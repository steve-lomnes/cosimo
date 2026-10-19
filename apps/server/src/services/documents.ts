/**
 * Receivables and payables (SPEC §8): invoices, bills, payments and their applications. Documents
 * drive their own entries (SPEC §6 #8): finalizing posts the document's entry, voiding reverses it,
 * and users cannot edit those entries directly. Every entry still goes through the posting pipeline,
 * so a large invoice may wait in the review queue; document state follows the entry through the
 * post/reject hooks at the bottom of this file.
 */
import { isPaymentAccount } from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import {
  addDays,
  dueFromRule,
  parseTerms,
  type TermRule,
  termsAgree,
  termsFromDates,
  today,
} from "@cosimo/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { assertReviewable, bankTxnView, mustGetBankAccount, mustGetBankTxn } from "./banking.ts";
import { mustGetContact } from "./contacts.ts";
import {
  accountMap,
  getEntry,
  onEntryApproving,
  onEntryPosted,
  onEntryRejected,
  rejectEntryTx,
  reverseEntryTx,
  type SubmitResult,
  settingsRow,
  submitEntryTx,
  systemAccountId,
} from "./ledger.ts";

type Reader = OrgDb | OrgTx;
type InvoiceRow = typeof org.invoices.$inferSelect;
type BillRow = typeof org.bills.$inferSelect;
type PaymentRow = typeof org.payments.$inferSelect;
export type DocType = "invoice" | "bill";

// ----------------------------------------------------------------------------- helpers

/** Line amount = quantity × unit price, quantity in thousandths, rounded half away from zero. */
export function lineAmount(quantityMilli: number, unitPrice: number): number {
  const p = quantityMilli * unitPrice;
  if (!Number.isSafeInteger(p)) throw unprocessable("Line amount is too large.", "invalid_amount");
  const sign = p < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(p) + 500) / 1000);
}

/**
 * Settles an invoice's terms and due date so they agree (the due date is authoritative, the terms
 * describe it). Both given: they must agree, else 422 `terms_conflict`. Due date only: the terms are
 * derived from it. Terms only: a rule computes the due date; "On due date" needs one, and custom
 * text falls back to 30 days. Neither: `fallback` terms (customer default, then org default).
 */
export function resolveTerms(o: {
  issue: string;
  terms?: string | null;
  due?: string | null;
  fallback: string;
}): { terms: string; due: string } {
  const { issue } = o;
  const given = o.terms?.trim() || null;
  let terms: string;
  let due: string;
  if (o.due) {
    due = o.due;
    if (given) {
      terms = given;
      if (!termsAgree(issue, terms, due)) {
        const rule = parseTerms(terms) as TermRule;
        throw unprocessable(
          `${terms} puts the due date on ${dueFromRule(issue, rule)}, but the due date given is ${due}. Change one, or leave terms out and Cosimo sets them from the due date.`,
          "terms_conflict",
        );
      }
    } else terms = termsFromDates(issue, due);
  } else {
    terms = given ?? o.fallback;
    let rule = parseTerms(terms);
    if (rule === "on_due_date") {
      if (given) throw unprocessable('"On due date" needs a due date.', "due_date_required");
      terms = "Net 30"; // an "On due date" default can't supply a date
      rule = parseTerms(terms);
    }
    due = addDays(issue, 30);
    if (rule && rule !== "on_due_date") due = dueFromRule(issue, rule);
  }
  if (due < issue) throw unprocessable("The due date can't be before the invoice date.", "invalid_due_date");
  return { terms, due };
}

function canReverseDocuments(a: ActorInfo) {
  if (a.actor === "mcp" || a.proposeOnly)
    throw forbidden("Voiding needs a person or a full-access API token.");
}

/** A person (or full API token) voiding a document posts the reversal directly. */
const reversalOpts = (a: ActorInfo) => ({
  forcePost: a.actor === "user" || (a.actor === "api_token" && !a.proposeOnly),
});

async function entryStatus(db: Reader, entryId: string | null) {
  if (!entryId) return null;
  const e = await db
    .select({ status: org.journalEntries.status })
    .from(org.journalEntries)
    .where(eq(org.journalEntries.id, entryId))
    .get();
  return e?.status ?? null;
}

/** Sum of live applications: payment not voided and its entry posted. */
async function appliedTo(db: Reader, type: DocType, id: string, asOf?: string) {
  const conds: SQL[] = [
    eq(org.paymentApplications.documentType, type),
    eq(org.paymentApplications.documentId, id),
    isNull(org.payments.voidedAt),
    eq(org.journalEntries.status, "posted"),
  ];
  if (asOf)
    conds.push(lte(sql`coalesce(${org.paymentApplications.appliedDate}, ${org.payments.date})`, asOf));
  const r = await db
    .select({ total: sql<number>`coalesce(sum(${org.paymentApplications.amount}), 0)` })
    .from(org.paymentApplications)
    .innerJoin(org.payments, eq(org.payments.id, org.paymentApplications.paymentId))
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.payments.entryId))
    .where(and(...conds))
    .get();
  return Number(r?.total ?? 0);
}

/** Sum of applications from payments still waiting in review (not yet counted by appliedTo). */
async function pendingAppliedTo(db: Reader, type: DocType, id: string) {
  const r = await db
    .select({ total: sql<number>`coalesce(sum(${org.paymentApplications.amount}), 0)` })
    .from(org.paymentApplications)
    .innerJoin(org.payments, eq(org.payments.id, org.paymentApplications.paymentId))
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.payments.entryId))
    .where(
      and(
        eq(org.paymentApplications.documentType, type),
        eq(org.paymentApplications.documentId, id),
        isNull(org.payments.voidedAt),
        eq(org.journalEntries.status, "pending_review"),
      ),
    )
    .get();
  return Number(r?.total ?? 0);
}

/** Recompute amount paid and status of a document from its live applications and entry. */
export async function recomputeDocTx(tx: OrgTx, type: DocType, id: string) {
  const table = type === "invoice" ? org.invoices : org.bills;
  const doc = (await tx.select().from(table).where(eq(table.id, id)).get()) as
    | InvoiceRow
    | BillRow
    | undefined;
  if (!doc) return;
  const paid = await appliedTo(tx, type, id);
  const posted = (await entryStatus(tx, doc.entryId)) === "posted";
  let status: string;
  if (doc.voidedAt) status = "void";
  else if (!posted) status = "draft";
  else if (paid <= 0) status = type === "invoice" ? "sent" : "open";
  else if (paid < doc.total) status = "partial";
  else status = "paid";
  await tx
    .update(table)
    .set({ amountPaid: paid, status: status as never })
    .where(eq(table.id, id));
}

// ----------------------------------------------------------------------------- invoices

export interface DocLineInput {
  description: string;
  quantity_milli?: number;
  unit_price?: number;
  /** Bills: the line amount directly. */
  amount?: number;
  account_id: string;
}

export interface InvoiceInput {
  customer_id: string;
  number?: string | null;
  issue_date: string;
  due_date?: string | null;
  terms?: string | null;
  memo?: string | null;
  lines: DocLineInput[];
  /** Offer the online pay link (payment provider). Defaults to the org's `online_pay_default`. */
  online_pay_enabled?: boolean;
  /** `manual_link` mode: a payment page URL pasted by the owner, shown on the PDF and email. */
  manual_pay_url?: string | null;
}

/**
 * Builds an invoice's pay link. The token is derived from the master key, so only code holding the
 * app context can make one (services/online-payments.ts `payLinker`); views without it show none.
 */
export type PayLinker = (inv: InvoiceRow) => string | null;

export async function invoiceView(db: Reader, inv: InvoiceRow, link?: PayLinker) {
  const lines = await db
    .select()
    .from(org.invoiceLines)
    .where(eq(org.invoiceLines.invoiceId, inv.id))
    .orderBy(asc(org.invoiceLines.lineOrder))
    .all();
  const customer = await db.select().from(org.contacts).where(eq(org.contacts.id, inv.customerId)).get();
  const es = await entryStatus(db, inv.entryId);
  const online = await onlineAdjustments(db, inv.id);
  return {
    id: inv.id,
    number: inv.number,
    customer_id: inv.customerId,
    customer_name: customer?.name ?? "",
    customer_email: customer?.email ?? null,
    issue_date: inv.issueDate,
    due_date: inv.dueDate,
    status: inv.status,
    entry_status: es,
    currency: inv.currency,
    subtotal: inv.subtotal,
    total: inv.total,
    amount_paid: inv.amountPaid,
    balance_due: inv.status === "void" ? 0 : inv.total - inv.amountPaid,
    overdue: (inv.status === "sent" || inv.status === "partial") && inv.dueDate < today(),
    memo: inv.memo,
    terms: inv.terms,
    entry_id: inv.entryId,
    recurring_id: inv.recurringId,
    created_by_actor: inv.createdByActor,
    created_at: inv.createdAt,
    sent_at: inv.sentAt,
    last_reminder_at: inv.lastReminderAt,
    voided_at: inv.voidedAt,
    online_payment_enabled: inv.onlinePayEnabled,
    pay_url: link?.(inv) ?? null,
    online_pay_status: inv.onlinePayStatus,
    pay_link_opened_at: inv.payLinkOpenedAt,
    pay_error: inv.payError,
    pay_error_at: inv.payErrorAt,
    manual_pay_url: inv.manualPayUrl,
    ...online,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity_milli: l.quantityMilli,
      unit_price: l.unitPrice,
      amount: l.amount,
      account_id: l.incomeAccountId,
    })),
  };
}
export type InvoiceView = Awaited<ReturnType<typeof invoiceView>>;

/**
 * Refunds and disputes of the invoice's online payments, by the state of their entries: posted
 * amounts (disputes net of funds returned), whether one waits for review, and whether one was
 * rejected (the owner books that one by hand).
 */
async function onlineAdjustments(db: Reader, invoiceId: string) {
  const rows = await db
    .select({
      kind: org.providerAdjustments.kind,
      amount: org.providerAdjustments.amount,
      status: org.journalEntries.status,
    })
    .from(org.providerAdjustments)
    .leftJoin(org.journalEntries, eq(org.journalEntries.id, org.providerAdjustments.entryId))
    .where(eq(org.providerAdjustments.invoiceId, invoiceId))
    .all();
  const posted = rows.filter((r) => r.status === "posted");
  const sum = (kind: string) => posted.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount, 0);
  return {
    online_refunded: sum("refund"),
    online_disputed: sum("dispute_withdrawal") - sum("dispute_reinstatement"),
    refund_pending_review: rows.some((r) => r.status === "pending_review"),
    refund_rejected: rows.some((r) => r.status === "rejected"),
  };
}

export async function mustGetInvoice(db: Reader, id: string) {
  const i = await db.select().from(org.invoices).where(eq(org.invoices.id, id)).get();
  if (!i) throw notFound("Invoice");
  return i;
}

export async function listInvoices(
  db: Reader,
  f: {
    status?: string[];
    customerId?: string;
    from?: string;
    to?: string;
    overdue?: boolean;
    limit?: number;
  },
  link?: PayLinker,
) {
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(org.invoices.status, f.status as InvoiceRow["status"][]));
  if (f.customerId) conds.push(eq(org.invoices.customerId, f.customerId));
  if (f.from) conds.push(gte(org.invoices.issueDate, f.from));
  if (f.to) conds.push(lte(org.invoices.issueDate, f.to));
  if (f.overdue)
    conds.push(
      and(inArray(org.invoices.status, ["sent", "partial"]), sql`${org.invoices.dueDate} < ${today()}`)!,
    );
  const rows = await db
    .select()
    .from(org.invoices)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(org.invoices.issueDate), desc(org.invoices.id))
    .limit(Math.min(f.limit ?? 200, 1000))
    .all();
  return Promise.all(rows.map((r) => invoiceView(db, r, link)));
}

export async function checkDocLines(tx: Reader, lines: DocLineInput[], kind: DocType) {
  if (!lines.length) throw unprocessable("Add at least one line.", "empty");
  const accts = await accountMap(tx);
  for (const l of lines) {
    const a = accts.get(l.account_id);
    if (!a?.isActive) throw unprocessable("A line's account is missing or inactive.", "invalid_account");
    if (kind === "invoice" && a.type !== "income" && a.type !== "liability") {
      throw unprocessable(
        "Invoice lines post to income (or liability, e.g. deposits) accounts.",
        "invalid_account",
      );
    }
    if (kind === "bill" && a.type !== "expense" && a.type !== "asset" && a.type !== "liability") {
      throw unprocessable("Bill lines post to expense, asset, or liability accounts.", "invalid_account");
    }
  }
}

async function nextInvoiceNumber(tx: OrgTx) {
  const s = await settingsRow(tx);
  for (let n = s.nextInvoiceNumber, i = 0; i < 10_000; n++, i++) {
    const num = `${s.invoicePrefix}${n}`;
    const taken = await tx
      .select({ id: org.invoices.id })
      .from(org.invoices)
      .where(eq(org.invoices.number, num))
      .get();
    if (!taken) {
      await tx
        .update(org.orgSettings)
        .set({ nextInvoiceNumber: n + 1 })
        .where(eq(org.orgSettings.id, 1));
      return num;
    }
  }
  throw conflict("Could not allocate an invoice number.");
}

async function writeInvoiceLines(tx: OrgTx, invoiceId: string, lines: DocLineInput[]) {
  await tx.delete(org.invoiceLines).where(eq(org.invoiceLines.invoiceId, invoiceId));
  let subtotal = 0;
  const rows = lines.map((l, i) => {
    const q = l.quantity_milli ?? 1000;
    const price = l.unit_price ?? l.amount ?? 0;
    const amount = lineAmount(q, price);
    subtotal += amount;
    return {
      id: newId(),
      invoiceId,
      description: l.description.trim() || "Item",
      quantityMilli: q,
      unitPrice: price,
      amount,
      incomeAccountId: l.account_id,
      lineOrder: i,
    };
  });
  if (rows.length) await tx.insert(org.invoiceLines).values(rows);
  return subtotal;
}

export async function createInvoiceTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: InvoiceInput,
  extra: { recurringId?: string } = {},
) {
  const customer = await mustGetContact(tx, input.customer_id);
  if (customer.kind === "vendor")
    throw unprocessable("That contact is a vendor. Mark it as a customer first.", "invalid_contact");
  await checkDocLines(tx, input.lines, "invoice");
  const s = await settingsRow(tx);
  const number = input.number?.trim() || (await nextInvoiceNumber(tx));
  const clash = await tx
    .select({ id: org.invoices.id })
    .from(org.invoices)
    .where(eq(org.invoices.number, number))
    .get();
  if (clash) throw conflict(`Invoice number ${number} is already used.`, "duplicate_number");
  const id = newId();
  const { terms, due } = resolveTerms({
    issue: input.issue_date,
    terms: input.terms,
    due: input.due_date,
    fallback: customer.defaultTerms || s.defaultTerms,
  });
  await tx.insert(org.invoices).values({
    id,
    number,
    customerId: customer.id,
    issueDate: input.issue_date,
    dueDate: due,
    status: "draft",
    currency: s.baseCurrency,
    memo: input.memo ?? null,
    terms,
    recurringId: extra.recurringId ?? null,
    createdBy: a.userId,
    createdByActor: a.actor,
    onlinePayEnabled: input.online_pay_enabled ?? s.onlinePayDefault,
    manualPayUrl: input.manual_pay_url ?? null,
  });
  const subtotal = await writeInvoiceLines(tx, id, input.lines);
  if (subtotal <= 0) throw unprocessable("The invoice total must be more than zero.", "invalid_total");
  await tx.update(org.invoices).set({ subtotal, total: subtotal }).where(eq(org.invoices.id, id));
  const inv = await mustGetInvoice(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "invoice.create",
    targetType: "invoice",
    targetId: id,
    after: await invoiceView(tx, inv),
  });
  return inv;
}

async function assertEditableDraft(tx: Reader, inv: InvoiceRow | BillRow) {
  if (inv.status !== "draft")
    throw conflict(`This document is ${inv.status}; only drafts can be edited.`, "invalid_state");
  if ((await entryStatus(tx, inv.entryId)) === "pending_review") {
    throw conflict(
      "This document is waiting in the review queue. Reject it there to edit.",
      "pending_review",
    );
  }
}

export async function updateInvoiceTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: Partial<InvoiceInput>,
) {
  const before = await mustGetInvoice(tx, id);
  await assertEditableDraft(tx, before);
  const beforeView = await invoiceView(tx, before);
  const patch: Partial<typeof org.invoices.$inferInsert> = {};
  if (input.customer_id) {
    const c = await mustGetContact(tx, input.customer_id);
    if (c.kind === "vendor") throw unprocessable("That contact is a vendor.", "invalid_contact");
    patch.customerId = c.id;
  }
  if (input.number?.trim() && input.number.trim() !== before.number) {
    const clash = await tx
      .select({ id: org.invoices.id })
      .from(org.invoices)
      .where(eq(org.invoices.number, input.number.trim()))
      .get();
    if (clash) throw conflict(`Invoice number ${input.number} is already used.`, "duplicate_number");
    patch.number = input.number.trim();
  }
  const issue = input.issue_date ?? before.issueDate;
  if (input.issue_date) patch.issueDate = input.issue_date;
  const givenTerms = input.terms?.trim() || null;
  if (input.due_date) {
    // A due date is authoritative: terms in the same patch must agree, otherwise they're derived.
    const r = resolveTerms({ issue, terms: givenTerms, due: input.due_date, fallback: "Net 30" });
    patch.terms = r.terms;
    patch.dueDate = r.due;
  } else {
    const terms = givenTerms ?? before.terms;
    const rule = parseTerms(terms);
    const changed = input.due_date === null || givenTerms !== null || input.issue_date !== undefined;
    if (givenTerms) patch.terms = givenTerms;
    if (rule && rule !== "on_due_date" && changed) {
      patch.dueDate = dueFromRule(issue, rule);
    } else if (input.due_date === null && !rule) {
      patch.dueDate = resolveTerms({ issue, terms, fallback: "Net 30" }).due;
    }
    const due = patch.dueDate ?? before.dueDate;
    if (due < issue)
      throw unprocessable("The due date can't be before the invoice date.", "invalid_due_date");
  }
  if (input.memo !== undefined) patch.memo = input.memo;
  if (input.online_pay_enabled !== undefined) patch.onlinePayEnabled = input.online_pay_enabled;
  if (input.manual_pay_url !== undefined) patch.manualPayUrl = input.manual_pay_url;
  if (input.lines) {
    await checkDocLines(tx, input.lines, "invoice");
    const subtotal = await writeInvoiceLines(tx, id, input.lines);
    if (subtotal <= 0) throw unprocessable("The invoice total must be more than zero.", "invalid_total");
    patch.subtotal = subtotal;
    patch.total = subtotal;
  }
  patch.entryId = null;
  await tx.update(org.invoices).set(patch).where(eq(org.invoices.id, id));
  const after = await mustGetInvoice(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "invoice.update",
    targetType: "invoice",
    targetId: id,
    before: beforeView,
    after: await invoiceView(tx, after),
  });
  return after;
}

export async function deleteInvoiceDraftTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const inv = await mustGetInvoice(tx, id);
  await assertEditableDraft(tx, inv);
  const before = await invoiceView(tx, inv);
  await tx.delete(org.invoiceLines).where(eq(org.invoiceLines.invoiceId, id));
  await tx.delete(org.invoices).where(eq(org.invoices.id, id));
  await appendAudit(tx, orgId, a, { action: "invoice.delete", targetType: "invoice", targetId: id, before });
}

/** Post the invoice: AR debit for the total, income credits grouped by account. */
export async function finalizeInvoiceTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  opts: { lockOverrideNote?: string | null; forcePost?: boolean } = {},
) {
  const inv = await mustGetInvoice(tx, id);
  if (inv.status !== "draft") throw conflict(`This invoice is already ${inv.status}.`, "invalid_state");
  if ((await entryStatus(tx, inv.entryId)) === "pending_review")
    throw conflict("This invoice is already waiting for review.", "pending_review");
  const view = await invoiceView(tx, inv);
  const ar = await systemAccountId(tx, "ar");
  const byAccount = new Map<string, number>();
  for (const l of view.lines) byAccount.set(l.account_id, (byAccount.get(l.account_id) ?? 0) + l.amount);
  const lines = [
    { accountId: ar, amount: inv.total, contactId: inv.customerId, description: `Invoice ${inv.number}` },
    ...[...byAccount.entries()]
      .filter(([, amt]) => amt !== 0)
      .map(([accountId, amt]) => ({ accountId, amount: -amt, contactId: inv.customerId, description: null })),
  ];
  const r = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: inv.issueDate,
      memo: `Invoice ${inv.number} · ${view.customer_name}`,
      lines,
      sourceType: "invoice",
      sourceId: inv.id,
      lockOverrideNote: opts.lockOverrideNote ?? null,
    },
    {
      forcePost: opts.forcePost,
      // The review page renders the same shape as an invoice_draft item.
      reviewContext: { invoice: view },
    },
  );
  await tx.update(org.invoices).set({ entryId: r.entry.id }).where(eq(org.invoices.id, inv.id));
  await recomputeDocTx(tx, "invoice", inv.id);
  await appendAudit(tx, orgId, a, {
    action: "invoice.finalize",
    targetType: "invoice",
    targetId: inv.id,
    after: { entry_id: r.entry.id, entry_status: r.entry.status },
  });
  if (inv.onlinePayEnabled && inv.payTokenVersion === 0) await issuePayLinkTx(tx, orgId, a, inv.id, 1);
  return r;
}

/**
 * Start a new pay link version. The token hash is filled in by services/online-payments.ts, which
 * holds the master key (`storePayTokenHashesTx`); until then the link resolves through that
 * service's lookup, which stores missing hashes first.
 */
export async function issuePayLinkTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string, version: number) {
  await tx
    .update(org.invoices)
    .set({ payTokenVersion: version, payTokenHash: null, paySessionId: null, paySessionAmount: null })
    .where(eq(org.invoices.id, id));
  await appendAudit(tx, orgId, a, {
    action: version === 1 ? "invoice.pay_link_create" : "invoice.pay_link_rotate",
    targetType: "invoice",
    targetId: id,
    after: { version },
  });
}

export async function markInvoiceSentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  to: string | null,
) {
  const at = new Date().toISOString();
  await tx.update(org.invoices).set({ sentAt: at }).where(eq(org.invoices.id, id));
  await appendAudit(tx, orgId, a, {
    action: "invoice.send",
    targetType: "invoice",
    targetId: id,
    after: { to, sent_at: at },
  });
}

async function liveApplications(tx: Reader, type: DocType, id: string) {
  return tx
    .select({ paymentId: org.paymentApplications.paymentId, amount: org.paymentApplications.amount })
    .from(org.paymentApplications)
    .innerJoin(org.payments, eq(org.payments.id, org.paymentApplications.paymentId))
    .where(
      and(
        eq(org.paymentApplications.documentType, type),
        eq(org.paymentApplications.documentId, id),
        isNull(org.payments.voidedAt),
      ),
    )
    .all();
}

async function voidDocTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  type: DocType,
  id: string,
  date?: string | null,
) {
  canReverseDocuments(a);
  const table = type === "invoice" ? org.invoices : org.bills;
  const doc = (await tx.select().from(table).where(eq(table.id, id)).get()) as
    | InvoiceRow
    | BillRow
    | undefined;
  if (!doc) throw notFound(type === "invoice" ? "Invoice" : "Bill");
  if (doc.voidedAt) throw conflict("Already void.", "invalid_state");
  if ((await liveApplications(tx, type, id)).length) {
    throw conflict("Payments are applied to this document. Void or unapply them first.", "has_payments");
  }
  const es = await entryStatus(tx, doc.entryId);
  if (es === "posted") {
    const e = (await getEntry(tx, doc.entryId!))!;
    if (!e.reversed_by_entry_id) {
      await reverseEntryTx(
        tx,
        orgId,
        a,
        e.id,
        { date: date ?? undefined, allowDocument: true, memo: `Void ${e.memo ?? ""}`.trim() },
        reversalOpts(a),
      );
    }
  } else if (es === "pending_review") {
    await rejectEntryTx(tx, orgId, a, doc.entryId!, "Document voided");
    await tx
      .update(org.reviewItems)
      .set({
        status: "rejected",
        decidedBy: a.userId,
        decidedAt: new Date().toISOString(),
        decisionNote: "Document voided",
      })
      .where(and(eq(org.reviewItems.itemId, doc.entryId!), eq(org.reviewItems.status, "pending")));
  }
  await tx
    .update(table)
    .set({ voidedAt: new Date().toISOString(), status: "void" as never })
    .where(eq(table.id, id));
  await appendAudit(tx, orgId, a, { action: `${type}.void`, targetType: type, targetId: id });
}

export const voidInvoiceTx = (tx: OrgTx, orgId: string, a: ActorInfo, id: string, date?: string | null) =>
  voidDocTx(tx, orgId, a, "invoice", id, date);

// ----------------------------------------------------------------------------- bills

export interface BillInput {
  vendor_id: string;
  bill_number?: string | null;
  issue_date: string;
  due_date?: string | null;
  memo?: string | null;
  lines: DocLineInput[];
  /** Save without posting. */
  draft?: boolean;
  lock_override_note?: string | null;
}

export async function billView(db: Reader, b: BillRow) {
  const lines = await db
    .select()
    .from(org.billLines)
    .where(eq(org.billLines.billId, b.id))
    .orderBy(asc(org.billLines.lineOrder))
    .all();
  const vendor = await db.select().from(org.contacts).where(eq(org.contacts.id, b.vendorId)).get();
  return {
    id: b.id,
    vendor_id: b.vendorId,
    vendor_name: vendor?.name ?? "",
    bill_number: b.billNumber,
    issue_date: b.issueDate,
    due_date: b.dueDate,
    status: b.status,
    entry_status: await entryStatus(db, b.entryId),
    currency: b.currency,
    total: b.total,
    amount_paid: b.amountPaid,
    balance_due: b.status === "void" ? 0 : b.total - b.amountPaid,
    overdue: (b.status === "open" || b.status === "partial") && b.dueDate < today(),
    memo: b.memo,
    entry_id: b.entryId,
    recurring_id: b.recurringId,
    created_at: b.createdAt,
    voided_at: b.voidedAt,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      amount: l.amount,
      account_id: l.expenseAccountId,
    })),
  };
}
export type BillView = Awaited<ReturnType<typeof billView>>;

export async function mustGetBill(db: Reader, id: string) {
  const b = await db.select().from(org.bills).where(eq(org.bills.id, id)).get();
  if (!b) throw notFound("Bill");
  return b;
}

export async function listBills(
  db: Reader,
  f: { status?: string[]; vendorId?: string; from?: string; to?: string; limit?: number },
) {
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(org.bills.status, f.status as BillRow["status"][]));
  if (f.vendorId) conds.push(eq(org.bills.vendorId, f.vendorId));
  if (f.from) conds.push(gte(org.bills.issueDate, f.from));
  if (f.to) conds.push(lte(org.bills.issueDate, f.to));
  const rows = await db
    .select()
    .from(org.bills)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(org.bills.issueDate), desc(org.bills.id))
    .limit(Math.min(f.limit ?? 200, 1000))
    .all();
  return Promise.all(rows.map((r) => billView(db, r)));
}

async function writeBillLines(tx: OrgTx, billId: string, lines: DocLineInput[]) {
  await tx.delete(org.billLines).where(eq(org.billLines.billId, billId));
  let total = 0;
  const rows = lines.map((l, i) => {
    const amount = l.amount ?? lineAmount(l.quantity_milli ?? 1000, l.unit_price ?? 0);
    if (!Number.isSafeInteger(amount) || amount === 0)
      throw unprocessable("Bill line amounts must be non-zero cents.", "invalid_amount");
    total += amount;
    return {
      id: newId(),
      billId,
      description: l.description.trim() || "Item",
      amount,
      expenseAccountId: l.account_id,
      lineOrder: i,
    };
  });
  if (rows.length) await tx.insert(org.billLines).values(rows);
  if (total <= 0) throw unprocessable("The bill total must be more than zero.", "invalid_total");
  return total;
}

export async function createBillTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: BillInput,
  extra: { recurringId?: string } = {},
) {
  const vendor = await mustGetContact(tx, input.vendor_id);
  if (vendor.kind === "customer")
    throw unprocessable("That contact is a customer. Mark it as a vendor first.", "invalid_contact");
  await checkDocLines(tx, input.lines, "bill");
  const s = await settingsRow(tx);
  const id = newId();
  await tx.insert(org.bills).values({
    id,
    vendorId: vendor.id,
    billNumber: input.bill_number ?? null,
    issueDate: input.issue_date,
    dueDate: input.due_date ?? addDays(input.issue_date, 30),
    status: "draft",
    currency: s.baseCurrency,
    memo: input.memo ?? null,
    recurringId: extra.recurringId ?? null,
  });
  const total = await writeBillLines(tx, id, input.lines);
  await tx.update(org.bills).set({ total }).where(eq(org.bills.id, id));
  await appendAudit(tx, orgId, a, {
    action: "bill.create",
    targetType: "bill",
    targetId: id,
    after: await billView(tx, await mustGetBill(tx, id)),
  });
  let result: SubmitResult | null = null;
  if (!input.draft)
    result = await finalizeBillTx(tx, orgId, a, id, { lockOverrideNote: input.lock_override_note });
  return { bill: await mustGetBill(tx, id), result };
}

export async function updateBillTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: Partial<BillInput>,
) {
  const before = await mustGetBill(tx, id);
  await assertEditableDraft(tx, before);
  const beforeView = await billView(tx, before);
  const patch: Partial<typeof org.bills.$inferInsert> = { entryId: null };
  if (input.vendor_id) {
    const v = await mustGetContact(tx, input.vendor_id);
    if (v.kind === "customer") throw unprocessable("That contact is a customer.", "invalid_contact");
    patch.vendorId = v.id;
  }
  if (input.bill_number !== undefined) patch.billNumber = input.bill_number;
  if (input.issue_date) patch.issueDate = input.issue_date;
  if (input.due_date !== undefined)
    patch.dueDate = input.due_date ?? addDays(input.issue_date ?? before.issueDate, 30);
  if (input.memo !== undefined) patch.memo = input.memo;
  if (input.lines) {
    await checkDocLines(tx, input.lines, "bill");
    patch.total = await writeBillLines(tx, id, input.lines);
  }
  await tx.update(org.bills).set(patch).where(eq(org.bills.id, id));
  const after = await mustGetBill(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "bill.update",
    targetType: "bill",
    targetId: id,
    before: beforeView,
    after: await billView(tx, after),
  });
  return after;
}

export async function deleteBillDraftTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const b = await mustGetBill(tx, id);
  await assertEditableDraft(tx, b);
  const before = await billView(tx, b);
  await tx.delete(org.billLines).where(eq(org.billLines.billId, id));
  await tx.delete(org.bills).where(eq(org.bills.id, id));
  await appendAudit(tx, orgId, a, { action: "bill.delete", targetType: "bill", targetId: id, before });
}

/** Post the bill: expense debits per line, AP credit for the total. */
export async function finalizeBillTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  opts: { lockOverrideNote?: string | null; forcePost?: boolean } = {},
) {
  const b = await mustGetBill(tx, id);
  if (b.status !== "draft") throw conflict(`This bill is already ${b.status}.`, "invalid_state");
  if ((await entryStatus(tx, b.entryId)) === "pending_review")
    throw conflict("This bill is already waiting for review.", "pending_review");
  const view = await billView(tx, b);
  const ap = await systemAccountId(tx, "ap");
  const lines = [
    ...view.lines.map((l) => ({
      accountId: l.account_id,
      amount: l.amount,
      contactId: b.vendorId,
      description: l.description,
    })),
    {
      accountId: ap,
      amount: -b.total,
      contactId: b.vendorId,
      description: `Bill ${b.billNumber ?? ""}`.trim(),
    },
  ];
  const r = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: b.issueDate,
      memo: `Bill${b.billNumber ? ` ${b.billNumber}` : ""} · ${view.vendor_name}`,
      lines,
      sourceType: "bill",
      sourceId: b.id,
      lockOverrideNote: opts.lockOverrideNote ?? null,
    },
    {
      forcePost: opts.forcePost,
      // The review page renders the same shape as a bill_draft item.
      reviewContext: { bill: view },
    },
  );
  await tx.update(org.bills).set({ entryId: r.entry.id }).where(eq(org.bills.id, b.id));
  await recomputeDocTx(tx, "bill", b.id);
  await appendAudit(tx, orgId, a, {
    action: "bill.finalize",
    targetType: "bill",
    targetId: b.id,
    after: { entry_id: r.entry.id, entry_status: r.entry.status },
  });
  return r;
}

export const voidBillTx = (tx: OrgTx, orgId: string, a: ActorInfo, id: string, date?: string | null) =>
  voidDocTx(tx, orgId, a, "bill", id, date);

// ----------------------------------------------------------------------------- payments

export interface PaymentInput {
  direction: PaymentRow["direction"];
  contact_id: string;
  date: string;
  amount: number;
  /** Ledger account the money moved through: a bank/cash asset, or a credit card for sent payments. */
  account_id: string;
  method?: string | null;
  reference?: string | null;
  memo?: string | null;
  applications: { document_id: string; amount: number }[];
  lock_override_note?: string | null;
}

export async function paymentView(db: Reader, p: PaymentRow) {
  const apps = await db
    .select()
    .from(org.paymentApplications)
    .where(eq(org.paymentApplications.paymentId, p.id))
    .all();
  const contact = await db.select().from(org.contacts).where(eq(org.contacts.id, p.contactId)).get();
  const es = await entryStatus(db, p.entryId);
  const applied = apps.reduce((s, x) => s + x.amount, 0);
  const numbers = new Map<string, string>();
  for (const x of apps) {
    const doc =
      x.documentType === "invoice"
        ? await db
            .select({ n: org.invoices.number })
            .from(org.invoices)
            .where(eq(org.invoices.id, x.documentId))
            .get()
        : await db
            .select({ n: org.bills.billNumber })
            .from(org.bills)
            .where(eq(org.bills.id, x.documentId))
            .get();
    numbers.set(x.documentId, doc?.n ?? "");
  }
  return {
    id: p.id,
    direction: p.direction,
    contact_id: p.contactId,
    contact_name: contact?.name ?? "",
    date: p.date,
    amount: p.amount,
    account_id: p.bankAccountId,
    method: p.method,
    reference: p.reference,
    memo: p.memo,
    entry_id: p.entryId,
    entry_status: es,
    voided_at: p.voidedAt,
    applied,
    unapplied: p.voidedAt ? 0 : p.amount - applied,
    applications: apps.map((x) => ({
      document_type: x.documentType,
      document_id: x.documentId,
      document_number: numbers.get(x.documentId) ?? "",
      amount: x.amount,
      applied_date: x.appliedDate,
    })),
    created_at: p.createdAt,
  };
}
export type PaymentView = Awaited<ReturnType<typeof paymentView>>;

export async function mustGetPayment(db: Reader, id: string) {
  const p = await db.select().from(org.payments).where(eq(org.payments.id, id)).get();
  if (!p) throw notFound("Payment");
  return p;
}

export async function listPayments(
  db: Reader,
  f: { direction?: PaymentRow["direction"]; contactId?: string; withCredit?: boolean; limit?: number },
) {
  const conds: SQL[] = [];
  if (f.direction) conds.push(eq(org.payments.direction, f.direction));
  if (f.contactId) conds.push(eq(org.payments.contactId, f.contactId));
  const rows = await db
    .select()
    .from(org.payments)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(org.payments.date), desc(org.payments.id))
    .limit(Math.min(f.limit ?? 200, 1000))
    .all();
  const views = await Promise.all(rows.map((r) => paymentView(db, r)));
  return f.withCredit ? views.filter((v) => v.unapplied > 0 && v.entry_status === "posted") : views;
}

async function checkApplications(
  tx: Reader,
  p: { direction: PaymentRow["direction"]; contactId: string },
  apps: { document_id: string; amount: number }[],
  opts: { countPending?: boolean } = {},
) {
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  const seen = new Set<string>();
  for (const x of apps) {
    if (!Number.isSafeInteger(x.amount) || x.amount <= 0)
      throw unprocessable("Applied amounts must be positive.", "invalid_amount");
    if (seen.has(x.document_id)) throw unprocessable("Apply to each document once.", "duplicate_document");
    seen.add(x.document_id);
    const doc =
      type === "invoice" ? await mustGetInvoice(tx, x.document_id) : await mustGetBill(tx, x.document_id);
    const contactId = "customerId" in doc ? doc.customerId : doc.vendorId;
    if (contactId !== p.contactId)
      throw unprocessable("A document belongs to a different contact.", "contact_mismatch");
    if (doc.voidedAt || (await entryStatus(tx, doc.entryId)) !== "posted") {
      throw unprocessable(
        `${type === "invoice" ? "Invoice" : "Bill"} ${"number" in doc ? doc.number : (doc.billNumber ?? "")} is not open.`,
        "document_not_open",
      );
    }
    const posted = await appliedTo(tx, type, doc.id);
    const pending = opts.countPending ? await pendingAppliedTo(tx, type, doc.id) : 0;
    const open = doc.total - posted - pending;
    if (x.amount > open) {
      const label = `${type === "invoice" ? "Invoice" : "Bill"} ${"number" in doc ? doc.number : (doc.billNumber ?? "")}`;
      throw unprocessable(
        pending > 0
          ? `${label} has ${(open / 100).toFixed(2)} open, because ${(pending / 100).toFixed(2)} more is already waiting in review. A person must approve or reject that payment first (an assistant can withdraw its own with withdraw_proposal).`
          : `That is more than the ${(open / 100).toFixed(2)} still open on this document.`,
        "over_applied",
      );
    }
  }
  return type;
}

/** What is still open on a posted invoice or bill: total less posted applications (and, optionally, those waiting in review). */
export async function openBalance(db: Reader, type: DocType, id: string, countPending = false) {
  const doc = type === "invoice" ? await mustGetInvoice(db, id) : await mustGetBill(db, id);
  const posted = await appliedTo(db, type, id);
  const pending = countPending ? await pendingAppliedTo(db, type, id) : 0;
  return { doc, open: doc.total - posted - pending, posted };
}

/**
 * Record a payment received from a customer (or sent to a vendor), optionally applied to several
 * invoices (bills). Any amount not applied stays as a credit for the contact (SPEC §8.1).
 */
export async function recordPaymentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: PaymentInput,
  opts: {
    requireReview?: string;
    reviewContext?: Record<string, unknown>;
    rationale?: string | null;
    /** Also count payments waiting in review against each document's open balance. */
    countPending?: boolean;
  } = {},
) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw unprocessable("The payment amount must be positive.", "invalid_amount");
  const contact = await mustGetContact(tx, input.contact_id);
  const acct = await tx
    .select({ type: org.accounts.type, subtype: org.accounts.subtype, isActive: org.accounts.isActive })
    .from(org.accounts)
    .where(eq(org.accounts.id, input.account_id))
    .get();
  if (!acct?.isActive)
    throw unprocessable("Choose an active account the money moved through.", "invalid_account");
  if (!isPaymentAccount(acct)) {
    throw unprocessable(
      "Payments move through a bank, other current asset, credit card, other current liability, or owner's equity account.",
      "invalid_account",
    );
  }
  const applied = input.applications.reduce((s, x) => s + x.amount, 0);
  if (applied > input.amount) throw unprocessable("Applied amounts exceed the payment.", "over_applied");
  const type = await checkApplications(
    tx,
    { direction: input.direction, contactId: contact.id },
    input.applications,
    { countPending: opts.countPending },
  );
  const id = newId();
  await tx.insert(org.payments).values({
    id,
    direction: input.direction,
    contactId: contact.id,
    date: input.date,
    amount: input.amount,
    bankAccountId: input.account_id,
    method: input.method ?? null,
    reference: input.reference ?? null,
    memo: input.memo ?? null,
  });
  if (input.applications.length) {
    await tx.insert(org.paymentApplications).values(
      input.applications.map((x) => ({
        paymentId: id,
        documentType: type,
        documentId: x.document_id,
        amount: x.amount,
        appliedDate: input.date,
      })),
    );
  }
  const control = await systemAccountId(tx, input.direction === "received" ? "ar" : "ap");
  const sign = input.direction === "received" ? 1 : -1;
  const r = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: input.date,
      memo: `${input.direction === "received" ? "Payment from" : "Payment to"} ${contact.name}${input.reference ? ` (${input.reference})` : ""}`,
      lines: [
        {
          accountId: input.account_id,
          amount: sign * input.amount,
          contactId: contact.id,
          description: input.memo ?? null,
        },
        { accountId: control, amount: -sign * input.amount, contactId: contact.id, description: null },
      ],
      sourceType: input.direction === "received" ? "invoice_payment" : "bill_payment",
      sourceId: id,
      lockOverrideNote: input.lock_override_note ?? null,
      rationale: opts.rationale ?? null,
    },
    {
      requireReview: opts.requireReview,
      reviewContext: {
        payment: {
          id,
          direction: input.direction,
          contact_name: contact.name,
          amount: input.amount,
          applications: await Promise.all(
            input.applications.map(async (x) => {
              const doc =
                type === "invoice"
                  ? await mustGetInvoice(tx, x.document_id)
                  : await mustGetBill(tx, x.document_id);
              return {
                document_type: type,
                document_id: x.document_id,
                document_number: "number" in doc ? doc.number : (doc.billNumber ?? ""),
                amount: x.amount,
              };
            }),
          ),
        },
        ...opts.reviewContext,
      },
    },
  );
  await tx.update(org.payments).set({ entryId: r.entry.id }).where(eq(org.payments.id, id));
  for (const x of input.applications) await recomputeDocTx(tx, type, x.document_id);
  await appendAudit(tx, orgId, a, {
    action: "payment.create",
    targetType: "payment",
    targetId: id,
    after: {
      direction: input.direction,
      contact: contact.name,
      amount: input.amount,
      applications: input.applications,
      entry_status: r.entry.status,
    },
  });
  return { payment: await mustGetPayment(tx, id), result: r };
}

/** Apply an existing payment's unapplied credit to more documents (SPEC §8.1 customer credits). */
export async function applyPaymentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  apps: { document_id: string; amount: number }[],
  date?: string,
) {
  const p = await mustGetPayment(tx, id);
  if (p.voidedAt) throw conflict("This payment is void.", "invalid_state");
  if ((await entryStatus(tx, p.entryId)) !== "posted")
    throw conflict("This payment is not posted yet.", "invalid_state");
  const view = await paymentView(tx, p);
  const total = apps.reduce((s, x) => s + x.amount, 0);
  if (total > view.unapplied)
    throw unprocessable(`Only ${(view.unapplied / 100).toFixed(2)} is unapplied.`, "over_applied");
  const type = await checkApplications(tx, { direction: p.direction, contactId: p.contactId }, apps);
  const on = date ?? today();
  for (const x of apps) {
    const existing = await tx
      .select()
      .from(org.paymentApplications)
      .where(
        and(
          eq(org.paymentApplications.paymentId, id),
          eq(org.paymentApplications.documentType, type),
          eq(org.paymentApplications.documentId, x.document_id),
        ),
      )
      .get();
    if (existing) {
      await tx
        .update(org.paymentApplications)
        .set({ amount: existing.amount + x.amount })
        .where(
          and(
            eq(org.paymentApplications.paymentId, id),
            eq(org.paymentApplications.documentType, type),
            eq(org.paymentApplications.documentId, x.document_id),
          ),
        );
    } else {
      await tx.insert(org.paymentApplications).values({
        paymentId: id,
        documentType: type,
        documentId: x.document_id,
        amount: x.amount,
        appliedDate: on,
      });
    }
    await recomputeDocTx(tx, type, x.document_id);
  }
  await appendAudit(tx, orgId, a, {
    action: "payment.apply",
    targetType: "payment",
    targetId: id,
    after: { applications: apps, date: on },
  });
  return mustGetPayment(tx, id);
}

/** Remove one application (the amount returns to the payment's unapplied credit). */
export async function unapplyPaymentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  documentId: string,
) {
  const p = await mustGetPayment(tx, id);
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  const existing = await tx
    .select()
    .from(org.paymentApplications)
    .where(and(eq(org.paymentApplications.paymentId, id), eq(org.paymentApplications.documentId, documentId)))
    .get();
  if (!existing) throw notFound("Application");
  await tx
    .delete(org.paymentApplications)
    .where(
      and(eq(org.paymentApplications.paymentId, id), eq(org.paymentApplications.documentId, documentId)),
    );
  await recomputeDocTx(tx, type, documentId);
  await appendAudit(tx, orgId, a, {
    action: "payment.unapply",
    targetType: "payment",
    targetId: id,
    before: { document_id: documentId, amount: existing.amount },
  });
}

export async function voidPaymentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  date?: string | null,
) {
  canReverseDocuments(a);
  const p = await mustGetPayment(tx, id);
  if (p.voidedAt) throw conflict("This payment is already void.", "invalid_state");
  const es = await entryStatus(tx, p.entryId);
  if (es === "posted") {
    const e = (await getEntry(tx, p.entryId!))!;
    if (!e.reversed_by_entry_id) {
      await reverseEntryTx(
        tx,
        orgId,
        a,
        e.id,
        { date: date ?? undefined, allowDocument: true, memo: `Void ${e.memo ?? "payment"}` },
        reversalOpts(a),
      );
    }
  } else if (es === "pending_review") {
    await rejectEntryTx(tx, orgId, a, p.entryId!, "Payment voided");
    await tx
      .update(org.reviewItems)
      .set({
        status: "rejected",
        decidedBy: a.userId,
        decidedAt: new Date().toISOString(),
        decisionNote: "Payment voided",
      })
      .where(and(eq(org.reviewItems.itemId, p.entryId!), eq(org.reviewItems.status, "pending")));
  }
  await tx.update(org.payments).set({ voidedAt: new Date().toISOString() }).where(eq(org.payments.id, id));
  // Unlink any bank transaction matched to this payment so it can be reviewed again.
  if (p.entryId) {
    await tx
      .update(org.bankTransactions)
      .set({ status: "new", matchedEntryId: null, reviewItemId: null })
      .where(eq(org.bankTransactions.matchedEntryId, p.entryId));
  }
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  for (const x of await tx
    .select()
    .from(org.paymentApplications)
    .where(eq(org.paymentApplications.paymentId, id))
    .all()) {
    await recomputeDocTx(tx, type, x.documentId);
  }
  await appendAudit(tx, orgId, a, { action: "payment.void", targetType: "payment", targetId: id });
}

/** Open invoices (bills) of a contact, oldest first, for the payment form. */
export async function openDocuments(db: Reader, type: DocType, contactId?: string, link?: PayLinker) {
  if (type === "invoice") {
    const rows = await db
      .select()
      .from(org.invoices)
      .where(
        and(
          inArray(org.invoices.status, ["sent", "partial"]),
          contactId ? eq(org.invoices.customerId, contactId) : undefined,
        ),
      )
      .orderBy(asc(org.invoices.dueDate))
      .all();
    return Promise.all(rows.map((r) => invoiceView(db, r, link)));
  }
  const rows = await db
    .select()
    .from(org.bills)
    .where(
      and(
        inArray(org.bills.status, ["open", "partial"]),
        contactId ? eq(org.bills.vendorId, contactId) : undefined,
      ),
    )
    .orderBy(asc(org.bills.dueDate))
    .all();
  return Promise.all(rows.map((r) => billView(db, r)));
}

/**
 * Record a customer or vendor payment straight from a bank transaction (SPEC §8.3): the payment
 * moves through the bank's ledger account on the transaction date, and the transaction is linked.
 */
export async function payFromBankTxnTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  txnId: string,
  input: {
    contact_id: string;
    applications: { document_id: string; amount: number }[];
    memo?: string | null;
    lock_override_note?: string | null;
  },
  opts: { rationale?: string | null; countPending?: boolean } = {},
) {
  const t = await mustGetBankTxn(tx, txnId);
  assertReviewable(t);
  const bank = await mustGetBankAccount(tx, t.bankAccountId);
  const out = await recordPaymentTx(
    tx,
    orgId,
    a,
    {
      direction: t.amount > 0 ? "received" : "sent",
      contact_id: input.contact_id,
      date: t.date,
      amount: Math.abs(t.amount),
      account_id: bank.ledgerAccountId,
      memo: input.memo ?? t.description,
      reference: null,
      method: "bank",
      applications: input.applications,
      lock_override_note: input.lock_override_note ?? null,
    },
    opts,
  );
  const posted = out.result.entry.status === "posted";
  await tx
    .update(org.bankTransactions)
    .set({
      status: posted ? "matched" : "new",
      matchedEntryId: out.result.entry.id,
      reviewItemId: out.result.reviewItemId,
    })
    .where(eq(org.bankTransactions.id, t.id));
  return { ...out, transaction: bankTxnView(await mustGetBankTxn(tx, t.id)) };
}

// ----------------------------------------------------------------------------- hooks

async function onDocEntry(
  tx: OrgTx,
  type: DocType,
  entryId: string,
  sourceId: string | null,
  rejected: boolean,
) {
  if (!sourceId) return;
  const table = type === "invoice" ? org.invoices : org.bills;
  const doc = (await tx.select().from(table).where(eq(table.id, sourceId)).get()) as
    | InvoiceRow
    | BillRow
    | undefined;
  if (!doc) return;
  if (rejected) {
    if (doc.entryId === entryId) await tx.update(table).set({ entryId: null }).where(eq(table.id, doc.id));
  } else if (!doc.entryId) {
    await tx.update(table).set({ entryId }).where(eq(table.id, doc.id));
  }
  await recomputeDocTx(tx, type, doc.id);
}

async function onPaymentEntry(tx: OrgTx, entryId: string, sourceId: string | null, rejected: boolean) {
  if (!sourceId) return;
  const p = await tx.select().from(org.payments).where(eq(org.payments.id, sourceId)).get();
  if (!p) return;
  if (rejected && !p.voidedAt)
    await tx
      .update(org.payments)
      .set({ voidedAt: new Date().toISOString() })
      .where(eq(org.payments.id, p.id));
  if (!rejected && !p.entryId)
    await tx.update(org.payments).set({ entryId }).where(eq(org.payments.id, p.id));
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  for (const x of await tx
    .select()
    .from(org.paymentApplications)
    .where(eq(org.paymentApplications.paymentId, p.id))
    .all()) {
    await recomputeDocTx(tx, type, x.documentId);
  }
}

// Reversals carry the document's source type; they don't change the document (void does that).
for (const [src, type] of [
  ["invoice", "invoice"],
  ["bill", "bill"],
] as const) {
  onEntryPosted(src, (tx, _o, e) =>
    e.reverses_entry_id ? Promise.resolve() : onDocEntry(tx, type, e.id, e.source_id, false),
  );
  onEntryRejected(src, (tx, _o, e) =>
    e.reverses_entry_id ? Promise.resolve() : onDocEntry(tx, type, e.id, e.source_id, true),
  );
}
for (const src of ["invoice_payment", "bill_payment"]) {
  onEntryPosted(src, (tx, _o, e) =>
    e.reverses_entry_id ? Promise.resolve() : onPaymentEntry(tx, e.id, e.source_id, false),
  );
  onEntryRejected(src, (tx, _o, e) =>
    e.reverses_entry_id ? Promise.resolve() : onPaymentEntry(tx, e.id, e.source_id, true),
  );
}

/**
 * Approving a pending payment from the review queue re-checks its applications: another payment may
 * have used up the open balance, or the document may have been voided, since it was proposed.
 */
async function assertPaymentStillApplies(tx: OrgTx, _orgId: string, e: { source_id: string | null }) {
  if (!e.source_id) return;
  const p = await tx.select().from(org.payments).where(eq(org.payments.id, e.source_id)).get();
  if (!p) return;
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  const label = type === "invoice" ? "Invoice" : "Bill";
  const apps = await tx
    .select()
    .from(org.paymentApplications)
    .where(eq(org.paymentApplications.paymentId, p.id))
    .all();
  for (const x of apps) {
    const doc =
      type === "invoice" ? await mustGetInvoice(tx, x.documentId) : await mustGetBill(tx, x.documentId);
    const number = "number" in doc ? doc.number : (doc.billNumber ?? "");
    if (doc.voidedAt || (await entryStatus(tx, doc.entryId)) !== "posted") {
      throw conflict(
        `${label} ${number} is no longer open (it was voided or is not posted). Reject this payment.`,
        "over_applied",
      );
    }
    const open = Math.max(0, doc.total - (await appliedTo(tx, type, doc.id)));
    if (x.amount > open) {
      throw conflict(
        `${label} ${number} now has $${(open / 100).toFixed(2)} open; another payment was recorded after this one was proposed. Reject this one if it is a duplicate.`,
        "over_applied",
      );
    }
  }
}
for (const src of ["invoice_payment", "bill_payment"]) {
  onEntryApproving(src, (tx, o, e) =>
    e.reverses_entry_id ? Promise.resolve() : assertPaymentStillApplies(tx, o, e),
  );
}
