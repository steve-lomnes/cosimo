/**
 * MCP tools (SPEC §10.2). Each tool validates its input with zod (which also yields the JSON Schema
 * published in `tools/list`) and calls the same services as the REST API, as the `mcp` actor.
 *
 * Writes go through the review policy like any other writer; for the `mcp` actor the default is
 * review, and OAuth grants are always propose-only. Every write tool that touches the books takes
 * a `rationale` and returns the review item ID and status. Corrections to posted entries (reverse,
 * replace, and a payment's date) are proposals like any other write, and so is recording a customer
 * payment against invoices. Notes, contacts, and bank feed syncs don't touch the books, so they apply
 * directly and are recorded in the audit log (rules a sync runs still go through the review policy).
 * Recurring templates are proposed too, and nothing runs until a person approves. An assistant may
 * withdraw its own pending proposals, which ends them as rejected. There is no tool to approve,
 * reject, void, delete, or move lock dates.
 */
import type { LineInput } from "@cosimo/core";
import { org } from "@cosimo/db";
import { ON_DUE_DATE, TERM_PRESETS } from "@cosimo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { OrgScope } from "../http/types.ts";
import { listAccounts } from "./accounts.ts";
import {
  categorizeTx,
  countBankTxns,
  listBankAccounts,
  listBankTxns,
  mustGetBankTxn,
  type Split,
} from "./banking.ts";
import { holdBillDraftTx } from "./bill-review.ts";
import { contactView, createContactTx, listContacts, updateContactTx } from "./contacts.ts";
import { dashboard } from "./dashboard.ts";
import {
  createBillTx,
  createInvoiceTx,
  type DocLineInput,
  finalizeBillTx,
  finalizeInvoiceTx,
  listBills,
  listInvoices,
  listPayments,
  openBalance,
  payFromBankTxnTx,
  recordPaymentTx,
} from "./documents.ts";
import { assertNoPendingReplacement, proposeReplacementTx } from "./entry-replacement-review.ts";
import { holdInvoiceDraftTx } from "./invoice-review.ts";
import { getEntry, listEntries, reverseEntryTx, submitEntryTx } from "./ledger.ts";
import { appendNoteTx } from "./notes.ts";
import { payLinker } from "./online-payments.ts";
import { proposePaymentRedateTx } from "./payment-redate-review.ts";
import { syncForAssistant } from "./plaid.ts";
import {
  inputOf,
  listTemplates,
  mustGetTemplate,
  proposeTemplateTx,
  type TemplateInput,
  type TemplateKind,
  type TemplateLine,
  templateView,
} from "./recurring.ts";
import { REPORT_KEYS, runReport } from "./reports.ts";
import { listReview, mustGetReview, reviewView, withdrawReviewTx } from "./review.ts";
import { createRuleTx } from "./rules.ts";

export interface ToolCtx {
  ctx: AppContext;
  scope: OrgScope;
}

interface Tool<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Whether the tool's inputs or results carry amounts; if so, `tool()` adds the cents note. */
  money: boolean;
  write?: boolean;
  run(t: ToolCtx, input: z.output<S>): Promise<unknown>;
}

const tools: Tool<z.ZodType>[] = [];
/** Appended to the description of every tool with `money: true`. */
export const MONEY_NOTE =
  "All amounts, in inputs and results, are integer cents in the org's currency (123456 = $1,234.56); divide by 100 before showing them to a person.";
function tool<S extends z.ZodType>(t: Tool<S>) {
  const description = t.money ? `${t.description} ${MONEY_NOTE}` : t.description;
  tools.push({ ...t, description } as unknown as Tool<z.ZodType>);
}

const Rationale = z
  .string()
  .min(3)
  .max(2000)
  .describe("Why you are proposing this, shown to the person who reviews it. Required.");
/**
 * An amount in integer cents. `.describe()` replaces a schema's description, so the label is built
 * in here rather than left to callers; put the sign convention or role in `extra`.
 */
function cents(extra?: string, sign?: "positive" | "nonnegative") {
  const n = z.number().int();
  return (sign === "positive" ? n.positive() : sign === "nonnegative" ? n.nonnegative() : n).describe(
    `Integer cents: 123456 = $1,234.56.${extra ? ` ${extra}` : ""}`,
  );
}
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const EntryLines = z
  .array(
    z.object({
      account: z.string().describe("Account ID or code"),
      amount: cents("Debit positive, credit negative."),
      description: z.string().optional(),
      contact_id: z.string().optional(),
    }),
  )
  .min(2);

function requireWriter(t: ToolCtx) {
  if (t.scope.role !== "owner" && t.scope.role !== "bookkeeper")
    throw forbidden("This connection is read-only (its role is not Owner or Bookkeeper).");
}

/** Accept an account ID or code. */
async function accountId(t: ToolCtx, ref: string) {
  const accounts = await listAccounts(t.scope.handle.db);
  const a = accounts.find((x) => x.id === ref) ?? accounts.find((x) => x.code === ref);
  if (!a)
    throw unprocessable(
      `Unknown account ${ref}. Use an account ID or code from get_account_balances.`,
      "unknown_account",
    );
  return a.id;
}

/** Journal lines from tool input, with account codes resolved to IDs. */
async function entryLines(t: ToolCtx, lines: z.output<typeof EntryLines>) {
  const out: LineInput[] = [];
  for (const l of lines)
    out.push({
      accountId: await accountId(t, l.account),
      amount: l.amount,
      description: l.description ?? null,
      contactId: l.contact_id ?? null,
    });
  return out;
}

/** One lookup of every account, keyed by ID, for enriching lines with a code and name. */
async function accountLookup(t: ToolCtx) {
  const accounts = await listAccounts(t.scope.handle.db);
  return new Map(accounts.map((a) => [a.id, a]));
}

/** One query for the names of these contacts, archived ones included (list_contacts hides them, but a line referencing one should still show a name). */
async function contactNames(t: ToolCtx, ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!uniq.length) return new Map<string, string>();
  const rows = await t.scope.handle.db
    .select({ id: org.contacts.id, name: org.contacts.name })
    .from(org.contacts)
    .where(inArray(org.contacts.id, uniq))
    .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Add account_code/account_name (and contact_name when contact_id is set) to a batch of lines. */
function withNames<L extends { account_id: string; contact_id?: string | null }>(
  lines: L[],
  accounts: Map<string, { code: string; name: string }>,
  contacts: Map<string, string>,
) {
  return lines.map((l) => ({
    ...l,
    account_code: accounts.get(l.account_id)?.code ?? null,
    account_name: accounts.get(l.account_id)?.name ?? null,
    ...(l.contact_id ? { contact_name: contacts.get(l.contact_id) ?? null } : {}),
  }));
}

/** Whether each of these targets (same type) has at least one attachment, in one grouped query. */
async function attachmentFlags(t: ToolCtx, targetType: string, ids: string[]) {
  if (!ids.length) return new Map<string, boolean>();
  const rows = await t.scope.handle.db
    .select({ targetId: org.attachmentLinks.targetId })
    .from(org.attachmentLinks)
    .where(and(eq(org.attachmentLinks.targetType, targetType), inArray(org.attachmentLinks.targetId, ids)))
    .all();
  const withAttachment = new Set(rows.map((r) => r.targetId));
  return new Map(ids.map((id) => [id, withAttachment.has(id)]));
}

function outcome(r: {
  reviewItemId?: string | null;
  review_item_id?: string | null;
  entry?: { id: string; status: string };
}) {
  const reviewId = r.reviewItemId ?? r.review_item_id ?? null;
  return {
    status: reviewId ? "pending_review" : (r.entry?.status ?? "done"),
    review_item_id: reviewId,
    entry_id: r.entry?.id ?? null,
    message: reviewId
      ? "Proposed. It is waiting in the review queue for a person to approve; it does not affect the books until then."
      : "Applied: a review policy approved it automatically.",
  };
}

// ---------------------------------------------------------------------------------- read

tool({
  name: "list_orgs",
  title: "List organizations",
  description:
    "The one organization this connection can access, and your role in it. Call this first if you're unsure which org or role you have. To work with a different org, the person must approve a new connection; there is no tool to switch.",
  money: false,
  input: z.object({}),
  async run(t) {
    const reg = await t.ctx.orgs.get(t.scope.id);
    return {
      orgs: [
        {
          id: t.scope.id,
          name: reg?.name ?? "",
          role: t.scope.role,
          propose_only: t.scope.actor.proposeOnly ?? false,
        },
      ],
    };
  },
});

tool({
  name: "get_account_balances",
  title: "Chart of accounts with balances",
  description:
    "Every account (id, code, name, type, subtype, tax line, parent_id) with its posted balance as of a date. Balances are debit-positive and cover the account's own postings only; a parent's balance excludes its sub-accounts (those with parent_id set to it), which share its type, subtype, and tax line. Use this for the chart of accounts and current balances; for a full P&L or balance sheet, or history over a range, use run_report instead. Read org://profile first to learn which accounts this business uses.",
  money: true,
  input: z.object({
    as_of: IsoDate.optional().describe("Defaults to today"),
    include_inactive: z.boolean().default(false),
  }),
  async run(t, i) {
    const rows = await listAccounts(t.scope.handle.db, { withBalances: true, asOf: i.as_of });
    return { accounts: rows.filter((a) => i.include_inactive || a.is_active) };
  },
});

tool({
  name: "run_report",
  title: "Run a report",
  description:
    "Runs a full financial report: profit_and_loss, balance_sheet, trial_balance, cash_flow, tax_line_summary, general_ledger, ar_aging, ap_aging, or vendor_1099. Period reports (profit_and_loss, cash_flow, tax_line_summary, general_ledger) use from/to; point-in-time reports (balance_sheet, trial_balance, ar_aging, ap_aging) use as_of; vendor_1099 uses the year of `to`. For a quick balance check, use get_cash_snapshot or get_account_balances instead of a full report.",
  money: true,
  input: z.object({
    report: z.enum(REPORT_KEYS),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    as_of: IsoDate.optional(),
    basis: z.enum(["cash", "accrual"]).optional().describe("Defaults to the organization's basis"),
    compare: z.enum(["none", "prior_period", "prior_year", "monthly"]).optional(),
  }),
  async run(t, i) {
    const reg = await t.ctx.orgs.get(t.scope.id);
    const { report, ...p } = i;
    return runReport(t.scope.handle.db, t.scope.id, reg?.name ?? "", report, p);
  },
});

tool({
  name: "list_uncategorized_transactions",
  title: "Bank transactions needing categorization",
  description:
    "Bank and card transactions that are not yet categorized, newest first: what to work through in the monthly close. Leaves out transactions still pending at the bank (they show up here once posted) and ones already waiting in the review queue (see list_pending_reviews); `pending` gives the count and total of the pending ones. Positive amounts are money in, negative are money out. Pass next_cursor back as cursor for more. To find a specific transaction, already categorized or not, use search_transactions instead. Each bank account in `bank_accounts` carries its feed's sync status. If a transaction you expect is missing, check each bank account's `last_synced_at` / `last_sync_status` / `connection_status`, and call sync_bank_feed to fetch now.",
  money: true,
  input: z.object({
    bank_account_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    const r = await listBankTxns(t.scope.handle.db, {
      bankAccountId: i.bank_account_id,
      bucket: ["to_categorize"],
      limit: i.limit,
      cursor: i.cursor,
    });
    const counts = await countBankTxns(t.scope.handle.db, { bankAccountId: i.bank_account_id });
    return { bank_accounts: await listBankAccounts(t.scope.handle.db), pending: counts.pending, ...r };
  },
});

tool({
  name: "search_transactions",
  title: "Search bank transactions",
  description:
    "Search bank and card transactions (the bank feed, not the ledger) by text (description or payee), date range, account, and status. For only what still needs a category, use list_uncategorized_transactions instead; for journal entries once posted, use list_entries or get_entry. If a transaction you expect is missing, check each bank account's `last_synced_at` / `last_sync_status` / `connection_status`, and call sync_bank_feed to fetch now.",
  money: true,
  input: z.object({
    query: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    bank_account_id: z.string().optional(),
    status: z.array(z.enum(["new", "categorized", "matched", "transfer", "excluded"])).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    return listBankTxns(t.scope.handle.db, {
      q: i.query,
      from: i.from,
      to: i.to,
      bankAccountId: i.bank_account_id,
      status: i.status as never,
      limit: i.limit,
      cursor: i.cursor,
    });
  },
});

tool({
  name: "sync_bank_feed",
  title: "Sync bank feeds now",
  description:
    "Fetch new, changed, and removed transactions from the bank now (Plaid bank feeds), for one bank account (`bank_account_id`), one connection (`connection_id`), or, with neither, every connected bank. Applies right away; it is not a proposal and does not go to the review queue. Rules run exactly as in a scheduled sync, under the same review policy: their categorizations go to the review queue unless a person set the rule to post automatically. Each result has a `status`: `synced` (with counts and the new rows in `transactions`, each with any rule or history `suggestion`), `cooldown` (synced moments ago; retry after `retry_after_seconds`), `in_progress`, `error`, `needs_reauth`, or `disconnected`. `needs_reauth` means the bank login must be renewed: only a person can do that in Cosimo, so tell them; you can't fix it. `force_refresh` also asks Plaid to check the bank for newer transactions; Plaid bills that separately, so it only works when the instance allows it (otherwise `refresh` is `not_enabled` and the sync still runs), and what it finds arrives later, through a webhook-triggered sync or another call. An account without a bank feed can't be synced; import a statement instead.",
  write: true,
  money: true,
  input: z.object({
    bank_account_id: z.string().optional().describe("Sync the bank feed behind this bank account."),
    connection_id: z.string().optional().describe("Sync this bank connection."),
    force_refresh: z
      .boolean()
      .default(false)
      .describe("Also ask Plaid to check the bank now (billed by Plaid; may be disabled)."),
  }),
  async run(t, i) {
    requireWriter(t);
    return syncForAssistant(t.ctx, t.scope.id, t.scope.actor, {
      bankAccountId: i.bank_account_id,
      connectionId: i.connection_id,
      forceRefresh: i.force_refresh,
    });
  },
});

tool({
  name: "get_entry",
  title: "Get a journal entry",
  description:
    "One journal entry: its lines (debit-positive) with account code/name and, when set, contact name; status; source; and whether a receipt or other file is attached. For several entries, or to find one, use list_entries.",
  money: true,
  input: z.object({ entry_id: z.string() }),
  async run(t, i) {
    const e = await getEntry(t.scope.handle.db, i.entry_id);
    if (!e) throw notFound("Entry");
    const [accounts, contacts, attach] = await Promise.all([
      accountLookup(t),
      contactNames(
        t,
        e.lines.map((l) => l.contact_id),
      ),
      attachmentFlags(t, "journal_entry", [e.id]),
    ]);
    return { ...e, lines: withNames(e.lines, accounts, contacts), has_attachment: attach.get(e.id) ?? false };
  },
});

tool({
  name: "list_entries",
  title: "List journal entries",
  description:
    "Journal entries in a date range, newest first, filtered by status or source type. Each entry's lines carry account code/name and, when set, contact name, plus whether it has an attachment. For bank and card lines, use search_transactions instead.",
  money: true,
  input: z.object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    status: z.array(z.enum(["draft", "pending_review", "posted", "rejected"])).optional(),
    source_type: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    const r = await listEntries(t.scope.handle.db, {
      from: i.from,
      to: i.to,
      status: i.status,
      sourceType: i.source_type,
      limit: i.limit,
      cursor: i.cursor,
    });
    const [accounts, contacts, attach] = await Promise.all([
      accountLookup(t),
      contactNames(
        t,
        r.data.flatMap((e) => e.lines.map((l) => l.contact_id)),
      ),
      attachmentFlags(
        t,
        "journal_entry",
        r.data.map((e) => e.id),
      ),
    ]);
    return {
      ...r,
      data: r.data.map((e) => ({
        ...e,
        lines: withNames(e.lines, accounts, contacts),
        has_attachment: attach.get(e.id) ?? false,
      })),
    };
  },
});

tool({
  name: "list_contacts",
  title: "List customers and vendors",
  description:
    "Customers and vendors, optionally filtered by kind or a name search. Archived contacts are left out unless include_archived is true; a contact missing from the default list is often archived, not deleted.",
  money: false,
  input: z.object({
    kind: z.enum(["customer", "vendor"]).optional(),
    query: z.string().optional(),
    include_archived: z.boolean().default(false),
  }),
  async run(t, i) {
    return {
      contacts: await listContacts(t.scope.handle.db, {
        kind: i.kind,
        q: i.query,
        includeArchived: i.include_archived,
      }),
    };
  },
});

tool({
  name: "list_invoices",
  title: "List invoices",
  description:
    "Invoices to customers, with status, balance due, and whether each is overdue. Each invoice also says whether it accepts online payment (online_payment_enabled), its customer pay link (pay_url; none while the balance due is under Stripe's $0.50 minimum) or hand-entered payment link (manual_pay_url), whether a bank payment is still processing (online_pay_status), when the customer first opened the link, and why the link last failed (pay_error). Payments made online are recorded automatically. Refunds and disputes (chargebacks) made in Stripe are proposed as entries that wait for review; online_refunded and online_disputed are the posted amounts, refund_pending_review says one is waiting, and refund_rejected that one was rejected and must be booked by hand. A refunded invoice stays paid. For bills from vendors use list_bills instead. To record a customer payment use record_invoice_payment, and to see payments already received (or waiting in review) use list_invoice_payments.",
  money: true,
  input: z.object({
    status: z.array(z.enum(["draft", "sent", "partial", "paid", "void"])).optional(),
    customer_id: z.string().optional(),
    overdue: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    const db = t.scope.handle.db;
    return {
      invoices: await listInvoices(
        db,
        { status: i.status, customerId: i.customer_id, overdue: i.overdue, limit: i.limit },
        await payLinker(t.ctx, db, t.scope.id),
      ),
    };
  },
});

tool({
  name: "list_bills",
  title: "List bills",
  description:
    "Bills from vendors, with balance due and whether each is overdue. Each line carries account code/name, and each bill whether it has an attachment. For invoices to customers, use list_invoices; for payments already recorded against bills, use list_bill_payments. For payments received from customers, use list_invoice_payments.",
  money: true,
  input: z.object({
    status: z.array(z.enum(["draft", "open", "partial", "paid", "void"])).optional(),
    vendor_id: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    overdue: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    // `overdue` is computed per bill, so filter the full list before applying the limit.
    const bills = await listBills(t.scope.handle.db, {
      status: i.status,
      vendorId: i.vendor_id,
      from: i.from,
      to: i.to,
      limit: i.overdue == null ? i.limit : 1000,
    });
    const filtered = (i.overdue == null ? bills : bills.filter((b) => b.overdue === i.overdue)).slice(
      0,
      i.limit,
    );
    const [accounts, attach] = await Promise.all([
      accountLookup(t),
      attachmentFlags(
        t,
        "bill",
        filtered.map((b) => b.id),
      ),
    ]);
    return {
      bills: filtered.map((b) => ({
        ...b,
        lines: withNames(b.lines, accounts, new Map()),
        has_attachment: attach.get(b.id) ?? false,
      })),
    };
  },
});

tool({
  name: "list_bill_payments",
  title: "List payments sent to vendors",
  description:
    "Payments this business has sent to vendors, each with the bills it was applied to. For payments received from customers, use list_invoice_payments. For the bills themselves, use list_bills.",
  money: true,
  input: z.object({
    vendor_id: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    const payments = await listPayments(t.scope.handle.db, {
      direction: "sent",
      contactId: i.vendor_id,
      // listPayments has no date filter, so filter the full list before applying the limit.
      limit: i.from || i.to ? 1000 : i.limit,
    });
    return {
      payments: payments
        .filter((p) => (!i.from || p.date >= i.from) && (!i.to || p.date <= i.to))
        .slice(0, i.limit),
    };
  },
});

tool({
  name: "list_invoice_payments",
  title: "List payments received from customers",
  description:
    "Payments this business has received from customers, each with the invoices it was applied to, the amount not applied (unapplied: customer credit), and entry_status (pending_review means it is still waiting for a person to approve). Check this before record_invoice_payment so you don't record a payment twice; payment IDs here also work with propose_payment_date_change. For the invoices themselves, use list_invoices.",
  money: true,
  input: z.object({
    customer_id: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    const payments = await listPayments(t.scope.handle.db, {
      direction: "received",
      contactId: i.customer_id,
      // listPayments has no date filter, so filter the full list before applying the limit.
      limit: i.from || i.to ? 1000 : i.limit,
    });
    return {
      payments: payments
        .filter((p) => (!i.from || p.date >= i.from) && (!i.to || p.date <= i.to))
        .slice(0, i.limit),
    };
  },
});

tool({
  name: "list_recurring_templates",
  title: "List recurring templates",
  description:
    "Recurring invoices, bills, and journal entries: each template's contact, schedule summary (for example \"Monthly on the last day\"), next and upcoming dates, run mode, total, last error, and any change waiting for review. Run modes: draft creates drafts for a person to finish; post posts them (still through the review threshold and policies); post_and_send also emails invoices to the customer. Lines carry account code and name. Deleted templates are left out. Check this before proposing a template so you don't duplicate one; to create or change one, use propose_recurring_template.",
  money: true,
  input: z.object({
    kind: z.enum(["invoice", "bill", "entry"]).optional(),
    status: z.array(z.enum(["proposed", "active", "paused", "ended"])).optional(),
    upcoming: z.number().int().min(1).max(24).default(3).describe("How many upcoming dates to list"),
  }),
  async run(t, i) {
    const list = await listTemplates(t.scope.handle.db, {
      kind: i.kind,
      status: i.status,
      upcoming: i.upcoming,
    });
    const [accounts, contacts] = await Promise.all([
      accountLookup(t),
      contactNames(
        t,
        list.flatMap((x) => x.template.lines.map((l) => l.contact_id)),
      ),
    ]);
    return {
      templates: list.map((x) => ({
        ...x,
        template: { ...x.template, lines: withNames(x.template.lines, accounts, contacts) },
      })),
    };
  },
});

tool({
  name: "get_cash_snapshot",
  title: "Cash and business snapshot",
  description:
    "One overview: cash and card balances, this month's and year-to-date income/expense, review-queue and uncategorized-transaction counts, overdue invoices, and bills overdue or due soon. Each account and bank connection carries its feed's sync status (`last_synced_at`, `last_successful_sync_at`, `last_sync_status`, `last_sync_error`, `connection_status`); a stale or failing feed means recent transactions may be missing. Good for a quick 'how are we doing' check; for a full P&L or balance sheet use run_report, and for one account's balance use get_account_balances.",
  money: true,
  input: z.object({ as_of: IsoDate.optional().describe("Defaults to today") }),
  async run(t, i) {
    return dashboard(t.scope.handle.db, t.scope.id, i.as_of);
  },
});

tool({
  name: "list_pending_reviews",
  title: "Pending review items",
  description:
    "Proposals waiting for a person to approve, oldest first, including your own. You cannot approve, reject, or otherwise act on them; tell the person what's waiting instead. For one item's status once you have its ID, use get_review_item.",
  money: true,
  input: z.object({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }),
  async run(t, i) {
    return listReview(t.scope.handle.db, { status: ["pending"], limit: i.limit, cursor: i.cursor });
  },
});

tool({
  name: "get_review_item",
  title: "Get a review item",
  description:
    "One review item: its status (pending, approved, rejected, expired), the proposed payload, and any decision note left when it was decided. To find items rather than look one up by ID, use list_pending_reviews instead.",
  money: true,
  input: z.object({ review_item_id: z.string() }),
  async run(t, i) {
    return reviewView(await mustGetReview(t.scope.handle.db, i.review_item_id));
  },
});

// ---------------------------------------------------------------------------------- write

tool({
  name: "categorize_transaction",
  title: "Categorize a bank transaction",
  description:
    "Propose the account(s) for a bank or card transaction from list_uncategorized_transactions or search_transactions. Give one split for the whole amount, or several splits whose positive amounts add up to the transaction's absolute amount. Accounts may be IDs or codes. Refuses a transaction that isn't open to categorize (already categorized, matched, or excluded); to fix one of those, tell the person instead.",
  write: true,
  money: true,
  input: z.object({
    transaction_id: z.string(),
    splits: z
      .array(
        z.object({
          account: z.string().describe("Account ID or code"),
          amount: cents("Positive; omit when there is one split.", "positive").optional(),
          description: z.string().optional(),
          contact_id: z.string().optional(),
        }),
      )
      .min(1),
    memo: z.string().optional(),
    contact_id: z.string().optional(),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const txn = await mustGetBankTxn(t.scope.handle.db, i.transaction_id);
    if (i.splits.length > 1 && i.splits.some((s) => s.amount == null))
      throw unprocessable("Give an amount for every split when there is more than one.", "invalid_amount");
    const splits: Split[] = [];
    for (const s of i.splits)
      splits.push({
        account_id: await accountId(t, s.account),
        amount: s.amount ?? Math.abs(txn.amount),
        description: s.description ?? null,
        contact_id: s.contact_id ?? null,
      });
    const r = await t.scope.handle.write((tx) =>
      categorizeTx(tx, t.scope.id, t.scope.actor, i.transaction_id, {
        splits,
        memo: i.memo ?? null,
        contact_id: i.contact_id ?? null,
        rationale: i.rationale,
      }),
    );
    return outcome(r);
  },
});

tool({
  name: "record_invoice_payment",
  title: "Record a customer payment against invoices",
  description:
    "Propose recording a payment received from a customer and applying it to one or more of that customer's open invoices, in full or in part. An amount beyond what is applied stays as customer credit. When the deposit is in the bank feed, pass transaction_id (from list_uncategorized_transactions or search_transactions) so the deposit is linked and not counted twice; never categorize such a deposit to income, because the invoice already booked the income. Without transaction_id, give date, amount, and the bank or cash account. It waits in the review queue; approval posts Bank/Accounts Receivable and moves each invoice to partial or paid. Check list_invoice_payments first for one already waiting. Refuses: amounts beyond what is open (payments waiting in review count), invoices that are draft or void or belong to different customers, a withdrawal (money out), and a transaction that is already categorized, matched, or waiting.",
  write: true,
  money: true,
  input: z.object({
    invoices: z
      .array(
        z.object({
          invoice: z.string().describe("Invoice ID or number"),
          amount: cents(
            "Applied to this invoice. Omit to apply the smaller of its open balance and what is left of the payment.",
            "positive",
          ).optional(),
        }),
      )
      .min(1),
    transaction_id: z
      .string()
      .optional()
      .describe("A deposit from the bank feed; its date, amount, and account are used and it is linked."),
    date: IsoDate.optional().describe("Required without transaction_id"),
    amount: cents("The whole payment received. Required without transaction_id.", "positive").optional(),
    account: z
      .string()
      .optional()
      .describe("Bank or cash account ID or code. Required without transaction_id."),
    method: z.string().max(100).optional(),
    reference: z.string().max(200).optional().describe("For example a check number"),
    memo: z.string().optional(),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    if (i.transaction_id && (i.date || i.amount != null || i.account))
      throw unprocessable(
        "Don't give date, amount, or account with transaction_id: they come from the transaction.",
        "invalid_input",
      );
    if (!i.transaction_id && (!i.date || i.amount == null || !i.account))
      throw unprocessable(
        "Without transaction_id, give date, amount, and account (the bank or cash account the money went into).",
        "invalid_input",
      );
    const accountRef = i.account ? await accountId(t, i.account) : null;
    return t.scope.handle.write(async (tx) => {
      const txn = i.transaction_id ? await mustGetBankTxn(tx, i.transaction_id) : null;
      if (txn && txn.amount <= 0)
        throw unprocessable(
          "That transaction is money out, not a payment received. Use categorize_transaction.",
          "invalid_transaction",
        );
      const total = txn ? txn.amount : (i.amount as number);
      // Resolve each invoice by ID, else by number.
      const rows: { id: string; number: string; customerId: string; balance: number; amount: number }[] = [];
      let left = total;
      for (const x of i.invoices) {
        const inv =
          (await tx.select().from(org.invoices).where(eq(org.invoices.id, x.invoice)).get()) ??
          (await tx.select().from(org.invoices).where(eq(org.invoices.number, x.invoice)).get());
        if (!inv) throw notFound(`Invoice ${x.invoice}`);
        if (rows.some((r) => r.id === inv.id))
          throw unprocessable("Apply to each invoice once.", "duplicate_document");
        if (rows.length && rows[0]!.customerId !== inv.customerId)
          throw unprocessable(
            "These invoices belong to different customers; record one payment per customer.",
            "contact_mismatch",
          );
        const { open, posted } = await openBalance(tx, "invoice", inv.id, true);
        const amount = x.amount ?? Math.min(open, left);
        if (amount <= 0)
          throw unprocessable(
            `Nothing to apply to invoice ${inv.number}: it has no open balance (payments waiting in review count; withdraw your own with withdraw_proposal if it was wrong), or the payment is already fully allocated.`,
            "over_applied",
          );
        left -= amount;
        rows.push({
          id: inv.id,
          number: inv.number,
          customerId: inv.customerId,
          balance: inv.total - posted,
          amount,
        });
      }
      const applications = rows.map((r) => ({ document_id: r.id, amount: r.amount }));
      const opts = { rationale: i.rationale, countPending: true };
      const customerId = rows[0]!.customerId;
      const r = txn
        ? await payFromBankTxnTx(
            tx,
            t.scope.id,
            t.scope.actor,
            txn.id,
            { contact_id: customerId, applications, memo: i.memo ?? null },
            opts,
          )
        : await recordPaymentTx(
            tx,
            t.scope.id,
            t.scope.actor,
            {
              direction: "received",
              contact_id: customerId,
              date: i.date as string,
              amount: total,
              account_id: accountRef as string,
              method: i.method ?? null,
              reference: i.reference ?? null,
              memo: i.memo ?? null,
              applications,
            },
            opts,
          );
      const applied = rows.reduce((s, x) => s + x.amount, 0);
      return {
        ...outcome(r.result),
        payment_id: r.payment.id,
        amount: total,
        unapplied: total - applied,
        invoices: rows.map((x) => ({
          invoice_id: x.id,
          number: x.number,
          applied: x.amount,
          balance_due_after: x.balance - x.amount,
        })),
      };
    });
  },
});

tool({
  name: "record_bill_payment",
  title: "Record a payment to a vendor against bills",
  description:
    "Propose recording a payment made to a vendor and applying it to one or more of that vendor's open bills, in full or in part. Give date, amount, and the account the money moved through: a bank, other current asset, credit card, other current liability, or owner's equity account (for example when the owner paid the bill personally). It waits in the review queue; approval posts Accounts Payable against the chosen account and moves each bill to partial or paid. Check list_bill_payments first for one already waiting. Refuses: amounts beyond what is open (payments waiting in review count), bills that are draft or void or belong to different vendors, and accounts money cannot move through (such as accounts payable, income, or expense).",
  write: true,
  money: true,
  input: z.object({
    bills: z
      .array(
        z.object({
          bill: z.string().describe("Bill ID or bill number"),
          amount: cents(
            "Applied to this bill. Omit to apply the smaller of its open balance and what is left of the payment.",
            "positive",
          ).optional(),
        }),
      )
      .min(1),
    date: IsoDate,
    amount: cents("The whole payment made.", "positive"),
    account: z
      .string()
      .describe(
        "ID or code of the account the money moved through: bank, other current asset, credit card, other current liability, or owner's equity.",
      ),
    method: z.string().max(100).optional(),
    reference: z.string().max(200).optional().describe("For example a check number"),
    memo: z.string().optional(),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const accountRef = await accountId(t, i.account);
    return t.scope.handle.write(async (tx) => {
      // Resolve each bill by ID, else by bill number.
      const rows: { id: string; number: string; vendorId: string; balance: number; amount: number }[] = [];
      let left = i.amount;
      for (const x of i.bills) {
        const bill =
          (await tx.select().from(org.bills).where(eq(org.bills.id, x.bill)).get()) ??
          (await tx.select().from(org.bills).where(eq(org.bills.billNumber, x.bill)).get());
        if (!bill) throw notFound(`Bill ${x.bill}`);
        if (rows.some((r) => r.id === bill.id))
          throw unprocessable("Apply to each bill once.", "duplicate_document");
        if (rows.length && rows[0]!.vendorId !== bill.vendorId)
          throw unprocessable(
            "These bills belong to different vendors; record one payment per vendor.",
            "contact_mismatch",
          );
        const { open, posted } = await openBalance(tx, "bill", bill.id, true);
        const amount = x.amount ?? Math.min(open, left);
        if (amount <= 0)
          throw unprocessable(
            `Nothing to apply to bill ${bill.billNumber ?? bill.id}: it has no open balance (payments waiting in review count; withdraw your own with withdraw_proposal if it was wrong), or the payment is already fully allocated.`,
            "over_applied",
          );
        left -= amount;
        rows.push({
          id: bill.id,
          number: bill.billNumber ?? "",
          vendorId: bill.vendorId,
          balance: bill.total - posted,
          amount,
        });
      }
      const applications = rows.map((r) => ({ document_id: r.id, amount: r.amount }));
      const r = await recordPaymentTx(
        tx,
        t.scope.id,
        t.scope.actor,
        {
          direction: "sent",
          contact_id: rows[0]!.vendorId,
          date: i.date,
          amount: i.amount,
          account_id: accountRef,
          method: i.method ?? null,
          reference: i.reference ?? null,
          memo: i.memo ?? null,
          applications,
        },
        { rationale: i.rationale, countPending: true },
      );
      const applied = rows.reduce((s, x) => s + x.amount, 0);
      return {
        ...outcome(r.result),
        payment_id: r.payment.id,
        amount: i.amount,
        unapplied: i.amount - applied,
        bills: rows.map((x) => ({
          bill_id: x.id,
          number: x.number,
          applied: x.amount,
          balance_due_after: x.balance - x.amount,
        })),
      };
    });
  },
});

tool({
  name: "withdraw_proposal",
  title: "Withdraw your own pending proposal",
  description:
    "Withdraw a proposal you (an AI assistant working for this person) made that is still waiting in the review queue, undoing it as if it had been rejected, so you can propose a corrected one. The review_item_id comes from list_pending_reviews or the result of the proposal. Refuses items already decided, and items proposed by anyone else (a person, a rule, an integration, or another person's assistant). Never use it to clear proposals you didn't make; tell the person instead. The rationale is the reason and is kept on the item.",
  write: true,
  money: false,
  input: z.object({ review_item_id: z.string(), rationale: Rationale }),
  async run(t, i) {
    requireWriter(t);
    const r = await t.scope.handle.write((tx) =>
      withdrawReviewTx(tx, t.scope.id, t.scope.actor, i.review_item_id, i.rationale),
    );
    return {
      status: "withdrawn",
      review_item_id: r.id,
      message: "Withdrawn. The proposal was undone as if rejected; propose a corrected one if needed.",
    };
  },
});

tool({
  name: "create_rule",
  title: "Propose a categorization rule",
  description:
    "Propose a rule that categorizes future bank transactions matching its conditions. Conditions: description_contains, description_regex, amount_eq / amount_min / amount_max (absolute cents), direction (in|out), bank_account_id. Actions: account (ID or code), contact_id, memo, auto_post. Use this once a payee recurs with the same category; for a single transaction, use categorize_transaction instead.",
  write: true,
  money: true,
  input: z.object({
    name: z.string().min(1).max(200),
    conditions: z.object({
      description_contains: z.string().optional(),
      description_regex: z.string().max(200).optional(),
      amount_eq: cents("Match this exact amount (absolute value).").optional(),
      amount_min: cents("Match amounts at least this large (absolute value).").optional(),
      amount_max: cents("Match amounts at most this large (absolute value).").optional(),
      direction: z.enum(["in", "out"]).optional(),
      bank_account_id: z.string().optional(),
    }),
    actions: z.object({
      account: z.string().optional().describe("Account ID or code"),
      contact_id: z.string().optional(),
      memo: z.string().optional(),
      auto_post: z.boolean().default(false),
    }),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const { account, ...actions } = i.actions;
    const account_id = account ? await accountId(t, account) : undefined;
    const r = await t.scope.handle.write((tx) =>
      createRuleTx(tx, t.scope.id, t.scope.actor, {
        name: i.name,
        conditions: i.conditions,
        actions: { ...actions, account_id },
        rationale: i.rationale,
      }),
    );
    return {
      rule_id: r.rule.id,
      status: r.review_item_id ? "pending_review" : "active",
      review_item_id: r.review_item_id,
      message: r.review_item_id
        ? "Proposed. The rule stays inactive until a person approves it in the review queue."
        : "Created.",
    };
  },
});

tool({
  name: "create_manual_entry",
  title: "Propose a journal entry",
  description:
    "Propose a balanced journal entry (debits positive, credits negative; lines must sum to zero). Use it for adjustments and follow-on entries, such as monthly amortization of a prepaid expense. It goes to the review queue unless a policy approves it. To correct an entry that's already posted, use propose_replacement (or propose_reversal to cancel it) instead of adding an offsetting entry.",
  write: true,
  money: true,
  input: z.object({
    date: IsoDate,
    memo: z.string().max(500).optional(),
    lines: EntryLines,
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines = await entryLines(t, i.lines);
    const r = await t.scope.handle.write((tx) =>
      submitEntryTx(tx, t.scope.id, t.scope.actor, {
        date: i.date,
        memo: i.memo ?? null,
        lines,
        rationale: i.rationale,
      }),
    );
    return outcome(r);
  },
});

tool({
  name: "create_invoice_draft",
  title: "Propose an invoice draft",
  description:
    "Draft an invoice for a customer. It is held in the review queue; a person approves it (which finalizes it, posting Accounts Receivable) and decides when to send it. Line amounts are quantity × unit price. For a bill from a vendor use create_bill_draft instead.",
  write: true,
  money: true,
  input: z.object({
    customer_id: z.string(),
    issue_date: IsoDate,
    due_date: IsoDate.optional().describe(
      "Leave out to compute it from the terms. The due date can't be before issue_date.",
    ),
    terms: z
      .string()
      .max(100)
      .optional()
      .describe(
        `A preset (${TERM_PRESETS.join(", ")}) or custom text. Leave out to use the customer's default terms, then the organization's; if you give only a due_date the terms are derived from it. Terms that disagree with the due_date (Net 30 with a due date 5 days out) are rejected; "On due date" needs a due_date.`,
      ),
    memo: z.string().max(2000).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().positive().default(1),
          unit_price: cents("Price per unit.", "nonnegative"),
          account: z.string().describe("Income account ID or code"),
        }),
      )
      .min(1),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines: DocLineInput[] = [];
    for (const l of i.lines)
      lines.push({
        description: l.description,
        quantity_milli: Math.round(l.quantity * 1000),
        unit_price: l.unit_price,
        account_id: await accountId(t, l.account),
      });
    return t.scope.handle.write(async (tx) => {
      const inv = await createInvoiceTx(tx, t.scope.id, t.scope.actor, {
        customer_id: i.customer_id,
        issue_date: i.issue_date,
        due_date: i.due_date ?? null,
        terms: i.terms ?? null,
        memo: i.memo ?? null,
        lines,
      });
      const reviewId = await holdInvoiceDraftTx(tx, t.scope.id, t.scope.actor, inv.id, i.rationale);
      if (reviewId)
        return {
          invoice_id: inv.id,
          number: inv.number,
          total: inv.total,
          terms: inv.terms,
          due_date: inv.dueDate,
          status: "pending_review",
          review_item_id: reviewId,
          entry_id: null,
          message:
            "Drafted. It waits in the review queue; nothing is posted or sent until a person approves it.",
        };
      // A review policy approved it: finalize now, as approving the review item would.
      const r = await finalizeInvoiceTx(tx, t.scope.id, t.scope.actor, inv.id, { forcePost: true });
      const posted = await tx
        .select({ status: org.invoices.status })
        .from(org.invoices)
        .where(eq(org.invoices.id, inv.id))
        .get();
      return {
        invoice_id: inv.id,
        number: inv.number,
        total: inv.total,
        terms: inv.terms,
        due_date: inv.dueDate,
        status: posted?.status ?? "sent",
        review_item_id: null,
        entry_id: r.entry.id,
        message:
          "Applied: a review policy approved it automatically, so the invoice is posted to Accounts Receivable. It has not been sent; sending stays with a person.",
      };
    });
  },
});

tool({
  name: "create_bill_draft",
  title: "Propose a bill draft",
  description:
    "Draft a bill from a vendor. It is held in the review queue; a person approves it (which finalizes it, posting Accounts Payable). Each line is a description, an amount, and an expense (or asset/liability) account. The vendor must be a contact marked vendor or both, not customer-only. For an invoice to a customer use create_invoice_draft instead.",
  write: true,
  money: true,
  input: z.object({
    vendor_id: z.string(),
    bill_number: z.string().optional(),
    issue_date: IsoDate,
    due_date: IsoDate.optional(),
    memo: z.string().max(2000).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          amount: cents("The line amount.", "positive"),
          account: z.string().describe("Expense (or asset/liability) account ID or code"),
        }),
      )
      .min(1),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines: DocLineInput[] = [];
    for (const l of i.lines)
      lines.push({ description: l.description, amount: l.amount, account_id: await accountId(t, l.account) });
    return t.scope.handle.write(async (tx) => {
      const { bill } = await createBillTx(tx, t.scope.id, t.scope.actor, {
        vendor_id: i.vendor_id,
        bill_number: i.bill_number ?? null,
        issue_date: i.issue_date,
        due_date: i.due_date ?? null,
        memo: i.memo ?? null,
        lines,
        draft: true,
      });
      const reviewId = await holdBillDraftTx(tx, t.scope.id, t.scope.actor, bill.id, i.rationale);
      if (reviewId)
        return {
          bill_id: bill.id,
          bill_number: bill.billNumber,
          total: bill.total,
          status: "pending_review",
          review_item_id: reviewId,
          entry_id: null,
          message: "Drafted. It waits in the review queue; nothing is posted until a person approves it.",
        };
      // A review policy approved it: finalize now, as approving the review item would.
      const r = await finalizeBillTx(tx, t.scope.id, t.scope.actor, bill.id, { forcePost: true });
      return {
        bill_id: bill.id,
        bill_number: bill.billNumber,
        total: bill.total,
        status: "open",
        review_item_id: null,
        entry_id: r.entry.id,
        message:
          "Applied: a review policy approved it automatically, so the bill is posted to Accounts Payable.",
      };
    });
  },
});

const ContactFields = {
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z
    .record(z.string(), z.string().max(200))
    .nullable()
    .optional()
    .describe("Free-form fields, e.g. line1, city, state, postal_code, country"),
  tax_id_last4: z.string().max(4).nullable().optional().describe("Last 4 digits of the tax ID only"),
  is_1099_vendor: z.boolean().optional(),
  default_account: z
    .string()
    .nullable()
    .optional()
    .describe("Default expense or income account, ID or code; null clears it"),
  default_terms: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe(
      `Customers: terms for new invoices, used before the organization's default. A preset (${TERM_PRESETS.filter((t) => t !== ON_DUE_DATE).join(", ")}) or custom text; null clears it`,
    ),
  notes: z.string().max(5000).nullable().optional(),
};

/** Resolve `default_account` (ID or code) to `default_account_id`, keeping undefined and null as they are. */
async function defaultAccountId(t: ToolCtx, ref: string | null | undefined) {
  if (ref === undefined || ref === null) return ref;
  return accountId(t, ref);
}

tool({
  name: "create_contact",
  title: "Add a customer or vendor",
  description:
    "Add a customer or vendor, for example when one is missing before create_bill_draft or create_invoice_draft. Check list_contacts with include_archived: true first so you don't create a duplicate; to bring back an archived contact use update_contact with archived: false instead. Applies right away and is recorded in the audit log; it is not a proposal and does not go to the review queue, because contacts don't touch the books.",
  write: true,
  money: false,
  input: z.object({
    kind: z.enum(["customer", "vendor", "both"]),
    name: z.string().trim().min(1).max(200),
    ...ContactFields,
  }),
  async run(t, i) {
    requireWriter(t);
    const { default_account, ...rest } = i;
    const default_account_id = await defaultAccountId(t, default_account);
    const c = await t.scope.handle.write((tx) =>
      createContactTx(tx, t.scope.id, t.scope.actor, { ...rest, default_account_id }),
    );
    return {
      contact: contactView(c),
      message: "Created. Contacts apply directly; this did not go to the review queue.",
    };
  },
});

tool({
  name: "update_contact",
  title: "Update or archive a customer or vendor",
  description:
    "Change a customer's or vendor's details, archive one (archived: true), or bring an archived one back (archived: false). Only the fields you pass change. Applies right away and is recorded in the audit log; it is not a proposal and does not go to the review queue. To add a new contact use create_contact.",
  write: true,
  money: false,
  input: z.object({
    contact_id: z.string(),
    kind: z.enum(["customer", "vendor", "both"]).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    ...ContactFields,
    archived: z.boolean().optional(),
  }),
  async run(t, i) {
    requireWriter(t);
    const { contact_id, default_account, ...rest } = i;
    const default_account_id = await defaultAccountId(t, default_account);
    const c = await t.scope.handle.write((tx) =>
      updateContactTx(tx, t.scope.id, t.scope.actor, contact_id, { ...rest, default_account_id }),
    );
    return {
      contact: contactView(c),
      message: "Updated. Contacts apply directly; this did not go to the review queue.",
    };
  },
});

tool({
  name: "propose_reversal",
  title: "Propose reversing a posted entry",
  description:
    "Propose cancelling a posted journal entry with a reversal: a new entry with every line negated, dated the original's date unless you give one. It waits in the review queue like any other proposal. To fix an entry rather than cancel it, use propose_replacement. Entries created by an invoice, bill, or payment are refused: for a payment recorded on the wrong date use propose_payment_date_change; otherwise explain the fix to the person, who can void or edit the document. An entry that is already reversed, or has a reversal or replacement waiting, is refused too.",
  write: true,
  money: false,
  input: z.object({
    entry_id: z.string(),
    date: IsoDate.optional().describe("Defaults to the original entry's date"),
    memo: z.string().max(500).optional(),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const r = await t.scope.handle.write(async (tx) => {
      await assertNoPendingReplacement(tx, i.entry_id);
      return reverseEntryTx(tx, t.scope.id, t.scope.actor, i.entry_id, {
        date: i.date,
        memo: i.memo ?? null,
        rationale: i.rationale,
      });
    });
    return outcome(r);
  },
});

tool({
  name: "propose_replacement",
  title: "Propose correcting a posted entry",
  description:
    "Propose correcting a posted journal entry: the original is reversed and a corrected entry (the date, memo, and balanced lines you give, in the same format as create_manual_entry) is posted in its place. It is one review item: a person approves both halves together or neither, and nothing changes until then. Use get_entry first to see the original's lines. Entries created by an invoice, bill, or payment are refused (for a payment's date, use propose_payment_date_change). An entry that is already reversed, or has a reversal or replacement waiting, is refused too.",
  write: true,
  money: true,
  input: z.object({
    entry_id: z.string(),
    date: IsoDate,
    memo: z.string().max(500).optional(),
    lines: EntryLines,
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines = await entryLines(t, i.lines);
    const r = await t.scope.handle.write((tx) =>
      proposeReplacementTx(tx, t.scope.id, t.scope.actor, i.entry_id, {
        date: i.date,
        memo: i.memo ?? null,
        lines,
        rationale: i.rationale,
      }),
    );
    if (r.reviewItemId)
      return {
        status: "pending_review",
        review_item_id: r.reviewItemId,
        reversal_entry_id: null,
        replacement_entry_id: null,
        message:
          "Proposed. The reversal and the corrected entry wait in the review queue as one item; nothing changes until a person approves it.",
      };
    return {
      status: "posted",
      review_item_id: null,
      reversal_entry_id: r.reversal?.entry.id ?? null,
      replacement_entry_id: r.replacement?.entry.id ?? null,
      message:
        "Applied: a review policy approved it automatically, so the original is reversed and the correction posted.",
    };
  },
});

tool({
  name: "propose_payment_date_change",
  title: "Propose a new date for a payment",
  description:
    "Propose moving a recorded payment (to a vendor or from a customer) to a different date, typically to match the date the bank shows. Payment IDs come from list_bill_payments or list_invoice_payments, or from a journal entry's source_id when its source_type is bill_payment or invoice_payment. On approval the payment's entry is reversed on its original date and posted again on the new date; the bills or invoices it pays stay paid, and a matched bank transaction stays matched. It is one review item and changes nothing until a person approves it. Refuses a voided payment, one not yet posted, one in a completed bank reconciliation, or one with a date change already waiting.",
  write: true,
  money: false,
  input: z.object({ payment_id: z.string(), date: IsoDate, rationale: Rationale }),
  async run(t, i) {
    requireWriter(t);
    const r = await t.scope.handle.write((tx) =>
      proposePaymentRedateTx(tx, t.scope.id, t.scope.actor, i.payment_id, i.date, i.rationale),
    );
    if (r.reviewItemId)
      return {
        status: "pending_review",
        review_item_id: r.reviewItemId,
        entry_id: null,
        message:
          "Proposed. The date change waits in the review queue; nothing changes until a person approves it.",
      };
    return {
      status: "posted",
      review_item_id: null,
      entry_id: r.entry?.id ?? null,
      message: `Applied: a review policy approved it automatically, so the payment is now dated ${i.date}.`,
    };
  },
});

const TemplateLineArg = z.object({
  account: z.string().describe("Account ID or code"),
  description: z.string().max(1000).optional().describe("May use period placeholders such as {month}"),
  quantity: z.number().positive().optional().describe("Invoices: quantity, default 1"),
  unit_price: cents("Invoices: price per unit.").optional(),
  amount: cents("Bills: the line amount. Entries: debit positive, credit negative.").optional(),
  contact_id: z.string().optional().describe("Entries: a contact for this line"),
});

/** Template lines from tool input, shaped for the kind, with account codes resolved to IDs. */
async function templateLines(t: ToolCtx, kind: TemplateKind, lines: z.output<typeof TemplateLineArg>[]) {
  const out: TemplateLine[] = [];
  for (const l of lines) {
    const account_id = await accountId(t, l.account);
    if (kind === "invoice") {
      const price = l.unit_price ?? l.amount;
      if (price == null) throw unprocessable("Give each invoice line a unit_price.", "invalid_amount");
      out.push({
        description: l.description ?? null,
        quantity_milli: Math.round((l.quantity ?? 1) * 1000),
        unit_price: price,
        account_id,
      });
    } else if (kind === "bill") {
      const amount = l.amount ?? (l.unit_price != null ? Math.round(l.unit_price * (l.quantity ?? 1)) : null);
      if (amount == null) throw unprocessable("Give each bill line an amount.", "invalid_amount");
      out.push({ description: l.description ?? null, amount, account_id });
    } else {
      if (l.amount == null) throw unprocessable("Give each entry line an amount.", "invalid_amount");
      out.push({
        account_id,
        amount: l.amount,
        description: l.description ?? null,
        contact_id: l.contact_id ?? null,
      });
    }
  }
  return out;
}

/** Keep only the keys that were given, so an update changes just those fields. */
function given<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

tool({
  name: "propose_recurring_template",
  title: "Propose a recurring invoice, bill, or journal entry",
  description:
    "Propose a template that creates an invoice, bill, or balanced journal entry on a schedule, or propose changing, pausing, or resuming one (template IDs come from list_recurring_templates). Use it for things that repeat on a fixed schedule: a monthly software subscription or reimbursement, rent, a retainer invoice, or monthly amortization of a prepaid expense. For a single, one-off entry use create_manual_entry instead. Nothing runs or changes until a person approves it in the review queue. Schedule: unit day|week|month|year with interval (quarterly is month with interval 3); anchor_day 1-31 or -1 for the last day of the month (month and year only, defaults to the start date's day); start_date; end_date or max_occurrences, not both. Run mode: draft (default) creates drafts; post posts each one, still through the review threshold and policies; post_and_send (invoices only) also emails the customer and is always reviewed. Memo, terms, bill_number, and line descriptions may use {month}, {year}, {quarter}, {period}, {date}, with offsets like {month-1}, filled from each run's date. For update, pass only the fields to change; lines replace all lines. Accounts may be IDs or codes.",
  write: true,
  money: true,
  input: z.object({
    action: z.enum(["create", "update", "pause", "resume"]),
    template_id: z.string().optional().describe("Required for update, pause, and resume"),
    kind: z.enum(["invoice", "bill", "entry"]).optional().describe("Required for create"),
    name: z.string().trim().min(1).max(200).optional().describe("Required for create"),
    contact_id: z
      .string()
      .nullable()
      .optional()
      .describe("The customer (invoices) or vendor (bills); optional for entries"),
    run_mode: z.enum(["draft", "post", "post_and_send"]).optional().describe("Defaults to draft on create"),
    schedule: z
      .object({
        unit: z.enum(["day", "week", "month", "year"]).optional(),
        interval: z.number().int().min(1).max(1000).optional(),
        anchor_day: z.number().int().min(-1).max(31).nullable().optional(),
        start_date: IsoDate.optional(),
        end_date: IsoDate.nullable().optional(),
        max_occurrences: z.number().int().min(1).max(10_000).nullable().optional(),
      })
      .optional()
      .describe("Required for create (unit and start_date at least)"),
    memo: z.string().max(2000).nullable().optional(),
    terms: z
      .string()
      .max(100)
      .nullable()
      .optional()
      .describe(
        `Invoices: a preset (${TERM_PRESETS.join(", ")}) or custom text. A preset sets the due date, so leave due_days out or make it match (Net 30 needs 30); end-of-month presets can't have due_days; "On due date" needs due_days. Leave both out for the customer's or organization's default terms.`,
      ),
    due_days: z
      .number()
      .int()
      .min(0)
      .max(365)
      .nullable()
      .optional()
      .describe(
        "Invoices and bills: days until due. For an invoice with only due_days, the terms are derived from it",
      ),
    bill_number: z.string().max(60).nullable().optional(),
    lines: z.array(TemplateLineArg).min(1).max(200).optional().describe("Required for create"),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    let input: TemplateInput | undefined;
    if (i.action === "create") {
      if (!i.kind || !i.name || !i.lines || !i.schedule?.unit || !i.schedule.start_date)
        throw unprocessable(
          "To create a template give kind, name, schedule (unit and start_date at least), and lines.",
          "invalid_template",
        );
      input = {
        kind: i.kind,
        name: i.name,
        contact_id: i.contact_id ?? null,
        run_mode: i.run_mode ?? "draft",
        schedule: {
          unit: i.schedule.unit,
          interval: i.schedule.interval ?? 1,
          anchor_day: i.schedule.anchor_day ?? null,
          start_date: i.schedule.start_date,
          end_date: i.schedule.end_date ?? null,
          max_occurrences: i.schedule.max_occurrences ?? null,
        },
        template: {
          memo: i.memo ?? null,
          terms: i.terms ?? null,
          due_days: i.due_days ?? null,
          bill_number: i.bill_number ?? null,
          lines: await templateLines(t, i.kind, i.lines),
        },
      };
    } else if (!i.template_id) {
      throw unprocessable("Give the template_id to change.", "invalid_template");
    } else if (i.action === "update") {
      const cur = inputOf(await mustGetTemplate(t.scope.handle.db, i.template_id));
      input = {
        ...cur,
        ...given({ name: i.name, contact_id: i.contact_id, run_mode: i.run_mode }),
        schedule: { ...cur.schedule, ...given(i.schedule) },
        template: {
          ...cur.template,
          ...given({ memo: i.memo, terms: i.terms, due_days: i.due_days, bill_number: i.bill_number }),
          lines: i.lines ? await templateLines(t, cur.kind, i.lines) : cur.template.lines,
        },
      };
    }
    const r = await t.scope.handle.write((tx) =>
      proposeTemplateTx(tx, t.scope.id, t.scope.actor, {
        action: i.action,
        templateId: i.template_id,
        input,
        rationale: i.rationale,
      }),
    );
    // For a proposal, show the template as it will be once approved.
    const view = r.proposed ?? (await templateView(t.scope.handle.db, r.template));
    return {
      template_id: view.id,
      status: r.reviewItemId ? "pending_review" : view.status,
      review_item_id: r.reviewItemId,
      template: view,
      message: r.reviewItemId
        ? "Proposed. It waits in the review queue; nothing runs or changes until a person approves it."
        : "Applied: a review policy approved it automatically.",
    };
  },
});

tool({
  name: "append_note",
  title: "Record a bookkeeping note",
  description:
    'Record something durable you learned about how this business keeps its books, for example: "Payments from Acme are retainer billing, account 4010." Notes are dated, attributed to you, and read by future assistants (org://notes). Applies right away; it is not a proposal and does not go to the review queue. Never include secrets, passwords, or account numbers. For something specific to one write, put it in that tool\'s rationale instead of a note.',
  write: true,
  money: false,
  input: z.object({ note: z.string().min(3).max(10_000) }),
  async run(t, i) {
    requireWriter(t);
    const n = await t.scope.handle.write((tx) => appendNoteTx(tx, t.scope.id, t.scope.actor, i.note));
    return { note_id: n.id, created_at: n.created_at, message: "Noted." };
  },
});

export function listTools() {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }),
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      destructiveHint: false,
      idempotentHint: !t.write,
      openWorldHint: false,
    },
  }));
}

export function registerMcpTool<S extends z.ZodType>(t: Tool<S>) {
  tool(t);
}

export class ToolInputError extends Error {}

export async function callTool(t: ToolCtx, name: string, args: unknown) {
  const def = tools.find((x) => x.name === name);
  if (!def) return null;
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success)
    throw new ToolInputError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  return def.run(t, parsed.data);
}
