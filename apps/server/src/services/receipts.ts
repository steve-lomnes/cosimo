/**
 * Receipt inbox (#89): capture a receipt when paying, and attach it to the card charge once the
 * bank feed brings it. Receipts are not ledger records: every change applies at once and is
 * audited, and the categorization of the matched transaction still goes through review.
 *
 * Matching runs from both sides with the same rules (packages/core/src/receipts.ts):
 * - forward (`matchForTxnTx`), when an import or sync brings new transactions (`applyRulesTx`);
 * - reverse (`matchForReceiptTx`), when a receipt is created, its amounts, date or account change,
 *   a file is attached, or it is restored or released.
 * A receipt is matched automatically only when it and the transaction are each other's only
 * candidate, the amount is exact, and the merchant matches or the receipt names the transaction's
 * bank account. Otherwise the receipt points at its best candidate (`suggested_bank_txn_id`), and
 * categorizing that transaction confirms the match. At most one receipt is matched to a
 * transaction (unique index).
 */
import {
  dateWindow,
  RECEIPT_EARLY_DAYS,
  RECEIPT_LATE_DAYS,
  RECEIPT_STALE_DAYS,
  rankCandidates,
  receiptFit,
  receiptMemo,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { addDays, today } from "@cosimo/shared";
import { and, count, desc, eq, gte, inArray, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { linkAttachmentTx, recordAttachmentTx, type storeBlob, unlinkAttachmentTx } from "./attachments.ts";
import { appendAudit } from "./audit.ts";
import { historySuggestion, mustGetBankTxn, type Suggestion } from "./banking.ts";
import { createBillTx } from "./documents.ts";
import { type SubmitResult, submitEntryTx } from "./ledger.ts";

type Reader = OrgDb | OrgTx;
export type ReceiptRow = typeof org.receipts.$inferSelect;
type BankTxnRow = typeof org.bankTransactions.$inferSelect;
type StoredBlob = Awaited<ReturnType<typeof storeBlob>>;

export const RECEIPT_STATUSES = ["inbox", "matched", "booked", "dismissed"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

// ----------------------------------------------------------------------------- views

export interface ReceiptTxnSummary {
  id: string;
  bank_account_id: string;
  date: string;
  amount: number;
  description: string;
  payee: string | null;
  status: BankTxnRow["status"];
  entry_id: string | null;
}

export interface ReceiptView {
  id: string;
  status: ReceiptStatus;
  merchant: string | null;
  receipt_date: string;
  receipt_time: string | null;
  amount: number | null;
  pre_tip_amount: number | null;
  tax_amount: number | null;
  tip_amount: number | null;
  bank_account_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  memo: string | null;
  business_purpose: string | null;
  attendees: string | null;
  location: string | null;
  extraction_source: ReceiptRow["extractionSource"];
  attachment: {
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    download_url: string;
  } | null;
  matched_bank_txn_id: string | null;
  match_method: ReceiptRow["matchMethod"];
  matched_at: string | null;
  suggested_bank_txn_id: string | null;
  /** The matched transaction, else the suggested one. */
  transaction: ReceiptTxnSummary | null;
  rejected_txn_ids: string[];
  booked_target_type: ReceiptRow["bookedTargetType"];
  booked_target_id: string | null;
  dismissed_reason: string | null;
  /** In the inbox for more than 30 days. */
  stale: boolean;
  created_by_actor: string;
  created_at: string;
  updated_at: string;
}

function rejectedIds(r: ReceiptRow): string[] {
  try {
    const v = JSON.parse(r.rejectedTxnIdsJson) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function txnSummary(t: BankTxnRow): ReceiptTxnSummary {
  return {
    id: t.id,
    bank_account_id: t.bankAccountId,
    date: t.date,
    amount: t.amount,
    description: t.description,
    payee: t.payee,
    status: t.status,
    entry_id: t.matchedEntryId,
  };
}

/** The receipt's page in the web app, where a person can add the photo (MCP `attach_url`). */
export function receiptAttachUrl(publicUrl: string, orgId: string, id: string) {
  return `${publicUrl.replace(/\/$/, "")}/o/${orgId}/banking/receipts/${id}`;
}

function staleCutoff(asOf = today()) {
  return addDays(asOf, -RECEIPT_STALE_DAYS);
}

/** Views for several receipts, loading their transactions and attachments in two queries. */
export async function receiptViews(db: Reader, orgId: string, rows: ReceiptRow[]): Promise<ReceiptView[]> {
  const txnIds = [
    ...new Set(rows.flatMap((r) => [r.matchedBankTxnId ?? r.suggestedBankTxnId].filter(Boolean) as string[])),
  ];
  const attIds = [...new Set(rows.map((r) => r.attachmentId).filter(Boolean) as string[])];
  const txns = txnIds.length
    ? await db.select().from(org.bankTransactions).where(inArray(org.bankTransactions.id, txnIds)).all()
    : [];
  const atts = attIds.length
    ? await db.select().from(org.attachments).where(inArray(org.attachments.id, attIds)).all()
    : [];
  const tBy = new Map(txns.map((t) => [t.id, t]));
  const aBy = new Map(atts.map((a) => [a.id, a]));
  const cutoff = staleCutoff();
  return rows.map((r) => {
    const t = tBy.get(r.matchedBankTxnId ?? r.suggestedBankTxnId ?? "");
    const a = r.attachmentId ? aBy.get(r.attachmentId) : undefined;
    return {
      id: r.id,
      status: r.status,
      merchant: r.merchant,
      receipt_date: r.receiptDate,
      receipt_time: r.receiptTime,
      amount: r.amount,
      pre_tip_amount: r.preTipAmount,
      tax_amount: r.taxAmount,
      tip_amount: r.tipAmount,
      bank_account_id: r.bankAccountId,
      account_id: r.accountId,
      contact_id: r.contactId,
      memo: r.memo,
      business_purpose: r.businessPurpose,
      attendees: r.attendees,
      location: r.location,
      extraction_source: r.extractionSource,
      attachment: a
        ? {
            id: a.id,
            filename: a.filename,
            mime_type: a.mimeType,
            size_bytes: a.sizeBytes,
            download_url: `/api/v1/orgs/${orgId}/attachments/${a.id}`,
          }
        : null,
      matched_bank_txn_id: r.matchedBankTxnId,
      match_method: r.matchMethod,
      matched_at: r.matchedAt,
      suggested_bank_txn_id: r.suggestedBankTxnId,
      transaction: t ? txnSummary(t) : null,
      rejected_txn_ids: rejectedIds(r),
      booked_target_type: r.bookedTargetType,
      booked_target_id: r.bookedTargetId,
      dismissed_reason: r.dismissedReason,
      stale: r.status === "inbox" && r.createdAt < cutoff,
      created_by_actor: r.createdByActor,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  });
}

export async function receiptView(db: Reader, orgId: string, r: ReceiptRow): Promise<ReceiptView> {
  return (await receiptViews(db, orgId, [r]))[0]!;
}

/** What the audit log records about a receipt. */
function auditFields(r: ReceiptRow) {
  return {
    status: r.status,
    merchant: r.merchant,
    receipt_date: r.receiptDate,
    receipt_time: r.receiptTime,
    amount: r.amount,
    pre_tip_amount: r.preTipAmount,
    tax_amount: r.taxAmount,
    tip_amount: r.tipAmount,
    bank_account_id: r.bankAccountId,
    account_id: r.accountId,
    contact_id: r.contactId,
    memo: r.memo,
    business_purpose: r.businessPurpose,
    attendees: r.attendees,
    location: r.location,
    attachment_id: r.attachmentId,
    extraction_source: r.extractionSource,
  };
}

export async function getReceipt(db: Reader, id: string) {
  return (await db.select().from(org.receipts).where(eq(org.receipts.id, id)).get()) ?? null;
}

export async function mustGetReceipt(db: Reader, id: string) {
  const r = await getReceipt(db, id);
  if (!r) throw notFound("Receipt");
  return r;
}

export interface ReceiptFilter {
  status?: ReceiptStatus[];
  limit?: number;
  cursor?: string | null;
}

/** Receipts newest first (by receipt date, then ID). The cursor is `date|id` of the last row. */
export async function listReceipts(db: Reader, orgId: string, f: ReceiptFilter = {}) {
  const r = org.receipts;
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(r.status, f.status));
  if (f.cursor) {
    const [d, id] = f.cursor.split("|");
    if (d && id) conds.push(sql`(${r.receiptDate} < ${d} or (${r.receiptDate} = ${d} and ${r.id} < ${id}))`);
  }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(r)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(r.receiptDate), desc(r.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: await receiptViews(db, orgId, page),
    next_cursor: rows.length > limit && last ? `${last.receiptDate}|${last.id}` : null,
  };
}

/** Inbox receipts older than 30 days, for the dashboard. */
export async function staleReceiptCount(db: Reader, asOf = today()) {
  const row = await db
    .select({ n: count() })
    .from(org.receipts)
    .where(and(eq(org.receipts.status, "inbox"), lt(org.receipts.createdAt, staleCutoff(asOf))))
    .get();
  return Number(row?.n ?? 0);
}

/** For bank transaction views: the matched receipt, and the inbox receipts suggested for each. */
export async function receiptsForTxns(db: Reader, txnIds: string[]) {
  const matched = new Map<string, string>();
  const suggested = new Map<string, string[]>();
  if (!txnIds.length) return { matched, suggested };
  const rows = await db
    .select({
      id: org.receipts.id,
      status: org.receipts.status,
      matched: org.receipts.matchedBankTxnId,
      suggested: org.receipts.suggestedBankTxnId,
    })
    .from(org.receipts)
    .where(
      or(
        inArray(org.receipts.matchedBankTxnId, txnIds),
        and(eq(org.receipts.status, "inbox"), inArray(org.receipts.suggestedBankTxnId, txnIds)),
      ),
    )
    .orderBy(org.receipts.id)
    .all();
  for (const r of rows) {
    if (r.matched) matched.set(r.matched, r.id);
    else if (r.suggested) suggested.set(r.suggested, [...(suggested.get(r.suggested) ?? []), r.id]);
  }
  return { matched, suggested };
}

/** Fill `receipt_id` and `suggested_receipt_ids` on bank transaction views. */
export async function withReceipts<
  T extends { id: string; receipt_id: string | null; suggested_receipt_ids: string[] },
>(db: Reader, views: T[]): Promise<T[]> {
  const { matched, suggested } = await receiptsForTxns(
    db,
    views.map((v) => v.id),
  );
  return views.map((v) => ({
    ...v,
    receipt_id: matched.get(v.id) ?? null,
    suggested_receipt_ids: suggested.get(v.id) ?? [],
  }));
}

// ----------------------------------------------------------------------------- matching

interface Candidate {
  id: string;
  t: BankTxnRow;
  fit: "exact" | "tip";
  merchant: boolean;
  days: number;
  rejected: boolean;
}

const fitInput = (r: ReceiptRow) => ({
  amount: r.amount,
  pre_tip_amount: r.preTipAmount,
  receipt_date: r.receiptDate,
  merchant: r.merchant,
});

/** Transactions statuses a receipt can match: never excluded. */
const MATCHABLE = ["new", "categorized", "matched"] as const;

/**
 * Transactions that fit the receipt, best first: posted outflows in the date window, not excluded,
 * not holding another matched receipt. Rejected ones are left out unless `includeRejected`.
 */
export async function candidateTxns(
  db: Reader,
  r: ReceiptRow,
  opts: { includeRejected?: boolean } = {},
): Promise<Candidate[]> {
  if (r.amount == null && r.preTipAmount == null) return [];
  const t = org.bankTransactions;
  const [from, to] = dateWindow(r.receiptDate);
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        lt(t.amount, 0),
        eq(t.isPending, false),
        inArray(t.status, [...MATCHABLE]),
        gte(t.date, from),
        lte(t.date, to),
        sql`not exists (select 1 from receipts x where x.matched_bank_txn_id = ${t.id} and x.id <> ${r.id})`,
      ),
    )
    .all();
  const rejected = new Set(rejectedIds(r));
  const out: Candidate[] = [];
  for (const row of rows) {
    const f = receiptFit(fitInput(r), row);
    if (!f) continue;
    const isRejected = rejected.has(row.id);
    if (isRejected && !opts.includeRejected) continue;
    out.push({ id: row.id, t: row, ...f, rejected: isRejected });
  }
  return rankCandidates(out);
}

/** Inbox receipts that fit the transaction (and haven't rejected it), best first. */
async function fittingReceipts(db: Reader, t: BankTxnRow) {
  if (t.amount >= 0 || t.isPending || t.status === "excluded") return [];
  const rows = await db
    .select()
    .from(org.receipts)
    .where(
      and(
        eq(org.receipts.status, "inbox"),
        // A charge posts up to a day before the receipt and a week after it.
        gte(org.receipts.receiptDate, addDays(t.date, -RECEIPT_LATE_DAYS)),
        lte(org.receipts.receiptDate, addDays(t.date, RECEIPT_EARLY_DAYS)),
      ),
    )
    .all();
  const out: { id: string; r: ReceiptRow; fit: "exact" | "tip"; merchant: boolean; days: number }[] = [];
  for (const r of rows) {
    if (rejectedIds(r).includes(t.id)) continue;
    const f = receiptFit(fitInput(r), t);
    if (f) out.push({ id: r.id, r, ...f });
  }
  return rankCandidates(out);
}

/** The auto-match rule's per-pair condition: an exact amount, and the merchant or the bank account. */
function autoFits(r: ReceiptRow, t: BankTxnRow, c: { fit: "exact" | "tip"; merchant: boolean }) {
  return (
    c.fit === "exact" && (c.merchant || (r.bankAccountId != null && r.bankAccountId === t.bankAccountId))
  );
}

/** The suggestion a receipt gives its transaction on Categorize. */
export function receiptSuggestion(r: ReceiptRow): Suggestion {
  return {
    source: "receipt",
    receipt_id: r.id,
    account_id: r.accountId,
    contact_id: r.contactId,
    memo: receiptMemo({ memo: r.memo, merchant: r.merchant, business_purpose: r.businessPurpose }),
  };
}

/** The matched receipt, else the inbox receipts suggested for a transaction. */
async function receiptsAt(db: Reader, txnId: string) {
  const matched = await db.select().from(org.receipts).where(eq(org.receipts.matchedBankTxnId, txnId)).get();
  if (matched) return [matched];
  return db
    .select()
    .from(org.receipts)
    .where(and(eq(org.receipts.status, "inbox"), eq(org.receipts.suggestedBankTxnId, txnId)))
    .orderBy(org.receipts.id)
    .all();
}

/**
 * Rewrite a transaction's receipt suggestion after its receipts changed. Only a transaction still
 * to categorize (new, not in review) whose suggestion is empty, from history, or from a receipt is
 * touched: a rule's or a payout's suggestion stays. With exactly one receipt matched to or
 * suggested for it, that receipt is the suggestion; otherwise a stale receipt suggestion falls
 * back to history.
 */
export async function refreshTxnSuggestionTx(tx: OrgTx, txnId: string | null | undefined) {
  if (!txnId) return;
  const t = await tx.select().from(org.bankTransactions).where(eq(org.bankTransactions.id, txnId)).get();
  if (t?.status !== "new" || t.reviewItemId) return;
  const cur = t.suggestionJson ? (JSON.parse(t.suggestionJson) as Suggestion) : null;
  if (cur && cur.source !== "history" && cur.source !== "receipt") return;
  const rs = await receiptsAt(tx, t.id);
  let next: Suggestion | null;
  if (rs.length === 1) next = receiptSuggestion(rs[0]!);
  else if (cur?.source === "receipt") next = await historySuggestion(tx, t);
  else return;
  const json = next ? JSON.stringify(next) : null;
  if (json !== t.suggestionJson)
    await tx
      .update(org.bankTransactions)
      .set({ suggestionJson: json })
      .where(eq(org.bankTransactions.id, t.id));
}

async function hasLink(tx: Reader, attachmentId: string, type: string, id: string) {
  const row = await tx
    .select({ id: org.attachmentLinks.attachmentId })
    .from(org.attachmentLinks)
    .where(
      and(
        eq(org.attachmentLinks.attachmentId, attachmentId),
        eq(org.attachmentLinks.targetType, type),
        eq(org.attachmentLinks.targetId, id),
      ),
    )
    .get();
  return Boolean(row);
}

/** Link the file to a record unless it already is (so the audit log isn't repeated). */
async function ensureLinkTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  attachmentId: string | null,
  target: { type: "receipt" | "bank_transaction" | "journal_entry" | "bill"; id: string },
) {
  if (!attachmentId || (await hasLink(tx, attachmentId, target.type, target.id))) return;
  await linkAttachmentTx(tx, orgId, a, attachmentId, target);
}

async function dropLinkTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  attachmentId: string | null,
  target: { type: string; id: string },
) {
  if (!attachmentId || !(await hasLink(tx, attachmentId, target.type, target.id))) return;
  await unlinkAttachmentTx(tx, orgId, a, attachmentId, target);
}

/** The links a receipt's file should have: the receipt, and when matched, the transaction and its entry. */
async function ensureLinksTx(tx: OrgTx, orgId: string, a: ActorInfo, r: ReceiptRow) {
  if (!r.attachmentId) return;
  await ensureLinkTx(tx, orgId, a, r.attachmentId, { type: "receipt", id: r.id });
  if (r.status !== "matched" || !r.matchedBankTxnId) return;
  await ensureLinkTx(tx, orgId, a, r.attachmentId, { type: "bank_transaction", id: r.matchedBankTxnId });
  const t = await mustGetBankTxn(tx, r.matchedBankTxnId);
  if (t.matchedEntryId)
    await ensureLinkTx(tx, orgId, a, r.attachmentId, { type: "journal_entry", id: t.matchedEntryId });
}

/** Point an inbox receipt at its best candidate, unless it already points at a valid one. */
async function suggestBestTx(tx: OrgTx, r: ReceiptRow, opts: { keepCurrent: boolean }) {
  const cands = await candidateTxns(tx, r);
  if (opts.keepCurrent && r.suggestedBankTxnId && cands.some((c) => c.id === r.suggestedBankTxnId)) return;
  const best = cands[0]?.id ?? null;
  if (best === r.suggestedBankTxnId) return;
  await tx.update(org.receipts).set({ suggestedBankTxnId: best }).where(eq(org.receipts.id, r.id));
  await refreshTxnSuggestionTx(tx, r.suggestedBankTxnId);
  await refreshTxnSuggestionTx(tx, best);
}

/**
 * Match a receipt to a transaction: set the match, clear its suggestion, take the transaction off
 * its rejected list, link the file, and move other receipts suggested for this transaction on.
 */
async function attachTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  r: ReceiptRow,
  t: BankTxnRow,
  method: "auto" | "manual" | "confirmed",
) {
  const holder = await tx
    .select({ id: org.receipts.id })
    .from(org.receipts)
    .where(eq(org.receipts.matchedBankTxnId, t.id))
    .get();
  if (holder && holder.id !== r.id)
    throw conflict("Another receipt is already matched to that transaction.", "already_matched");
  const prevSuggested = r.suggestedBankTxnId;
  await tx
    .update(org.receipts)
    .set({
      status: "matched",
      matchedBankTxnId: t.id,
      matchMethod: method,
      matchedAt: new Date().toISOString(),
      suggestedBankTxnId: null,
      rejectedTxnIdsJson: JSON.stringify(rejectedIds(r).filter((x) => x !== t.id)),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(org.receipts.id, r.id));
  const after = await mustGetReceipt(tx, r.id);
  await appendAudit(tx, orgId, a, {
    action: "receipt.match",
    targetType: "receipt",
    targetId: r.id,
    after: { bank_transaction_id: t.id, match_method: method },
  });
  await ensureLinksTx(tx, orgId, a, after);
  // Other receipts suggested for this transaction can't match it now.
  const others = await tx
    .select()
    .from(org.receipts)
    .where(
      and(
        eq(org.receipts.status, "inbox"),
        eq(org.receipts.suggestedBankTxnId, t.id),
        ne(org.receipts.id, r.id),
      ),
    )
    .all();
  for (const o of others) {
    await tx.update(org.receipts).set({ suggestedBankTxnId: null }).where(eq(org.receipts.id, o.id));
    await suggestBestTx(tx, { ...o, suggestedBankTxnId: null }, { keepCurrent: false });
  }
  if (prevSuggested && prevSuggested !== t.id) await refreshTxnSuggestionTx(tx, prevSuggested);
  await refreshTxnSuggestionTx(tx, t.id);
  return after;
}

/**
 * Forward matching, for a transaction an import or sync just brought: auto-match its one fitting
 * receipt, or point fitting receipts at their best candidate. Returns the receipt suggestion when
 * exactly one receipt is matched to or suggested for the transaction.
 */
export async function matchForTxnTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  t: BankTxnRow,
): Promise<Suggestion | null> {
  if (t.amount >= 0 || t.isPending || t.status === "excluded") return null;
  const held = await tx.select().from(org.receipts).where(eq(org.receipts.matchedBankTxnId, t.id)).get();
  if (held) return receiptSuggestion(held);
  const fits = await fittingReceipts(tx, t);
  if (!fits.length) return null;
  const only = fits.length === 1 ? fits[0]! : null;
  if (only && autoFits(only.r, t, only)) {
    const own = await candidateTxns(tx, only.r);
    if (own.length === 1 && own[0]!.id === t.id)
      return receiptSuggestion(await attachTx(tx, orgId, a, only.r, t, "auto"));
  }
  for (const f of fits) await suggestBestTx(tx, f.r, { keepCurrent: true });
  const at = await receiptsAt(tx, t.id);
  return at.length === 1 ? receiptSuggestion(at[0]!) : null;
}

/**
 * Reverse matching, for one inbox receipt: auto-match its one candidate when that transaction has
 * no other fitting receipt, else point it at its best candidate (or at none).
 */
export async function matchForReceiptTx(tx: OrgTx, orgId: string, a: ActorInfo, receiptId: string) {
  const r = await getReceipt(tx, receiptId);
  if (r?.status !== "inbox") return r;
  const cands = await candidateTxns(tx, r);
  const only = cands.length === 1 ? cands[0]! : null;
  if (only && autoFits(r, only.t, only)) {
    const rivals = (await fittingReceipts(tx, only.t)).filter((x) => x.id !== r.id);
    if (!rivals.length) return attachTx(tx, orgId, a, r, only.t, "auto");
  }
  await suggestBestTx(tx, r, { keepCurrent: false });
  return mustGetReceipt(tx, r.id);
}

/**
 * A transaction was categorized (posted or proposed) into `entryId`: a receipt suggested for it is
 * confirmed (when it is the only one), and the matched receipt's file is linked to the entry.
 */
export async function onTxnCategorizedTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  txnId: string,
  entryId: string,
) {
  let r = await tx.select().from(org.receipts).where(eq(org.receipts.matchedBankTxnId, txnId)).get();
  if (!r) {
    const sug = await tx
      .select()
      .from(org.receipts)
      .where(and(eq(org.receipts.status, "inbox"), eq(org.receipts.suggestedBankTxnId, txnId)))
      .all();
    if (sug.length !== 1) return;
    r = await attachTx(tx, orgId, a, sug[0]!, await mustGetBankTxn(tx, txnId), "confirmed");
  }
  await ensureLinkTx(tx, orgId, a, r.attachmentId, { type: "journal_entry", id: entryId });
}

/**
 * A transaction is going away (removed by the bank) or being excluded: return its matched receipt
 * to the inbox, unlinking the file from the transaction, and clear receipts suggested for it.
 * Returns the receipts released, for the caller to match again.
 */
export async function releaseReceiptsForTxnTx(tx: OrgTx, orgId: string, a: ActorInfo, txnId: string) {
  const ids: string[] = [];
  const matched = await tx.select().from(org.receipts).where(eq(org.receipts.matchedBankTxnId, txnId)).all();
  for (const r of matched) {
    await dropLinkTx(tx, orgId, a, r.attachmentId, { type: "bank_transaction", id: txnId });
    await tx
      .update(org.receipts)
      .set({
        status: "inbox",
        matchedBankTxnId: null,
        matchMethod: null,
        matchedAt: null,
        suggestedBankTxnId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(org.receipts.id, r.id));
    await appendAudit(tx, orgId, a, {
      action: "receipt.unmatch",
      targetType: "receipt",
      targetId: r.id,
      before: { bank_transaction_id: txnId, match_method: r.matchMethod },
      after: { reason: "transaction_released" },
    });
    ids.push(r.id);
  }
  const suggested = await tx
    .select({ id: org.receipts.id })
    .from(org.receipts)
    .where(eq(org.receipts.suggestedBankTxnId, txnId))
    .all();
  if (suggested.length) {
    await tx
      .update(org.receipts)
      .set({ suggestedBankTxnId: null })
      .where(
        inArray(
          org.receipts.id,
          suggested.map((s) => s.id),
        ),
      );
    ids.push(...suggested.map((s) => s.id));
  }
  return ids;
}

// ----------------------------------------------------------------------------- writes

export interface ReceiptInput {
  merchant?: string | null;
  receipt_date?: string | null;
  receipt_time?: string | null;
  amount?: number | null;
  pre_tip_amount?: number | null;
  tax_amount?: number | null;
  tip_amount?: number | null;
  bank_account_id?: string | null;
  account_id?: string | null;
  contact_id?: string | null;
  memo?: string | null;
  business_purpose?: string | null;
  attendees?: string | null;
  location?: string | null;
  extraction_source?: "manual" | "assistant";
}

const FIELDS: [keyof ReceiptInput, keyof typeof org.receipts.$inferInsert][] = [
  ["merchant", "merchant"],
  ["receipt_date", "receiptDate"],
  ["receipt_time", "receiptTime"],
  ["amount", "amount"],
  ["pre_tip_amount", "preTipAmount"],
  ["tax_amount", "taxAmount"],
  ["tip_amount", "tipAmount"],
  ["bank_account_id", "bankAccountId"],
  ["account_id", "accountId"],
  ["contact_id", "contactId"],
  ["memo", "memo"],
  ["business_purpose", "businessPurpose"],
  ["attendees", "attendees"],
  ["location", "location"],
  ["extraction_source", "extractionSource"],
];

/** Fields that change which transactions fit, so an inbox receipt is matched again. */
const MATCH_FIELDS: (keyof ReceiptInput)[] = [
  "amount",
  "pre_tip_amount",
  "receipt_date",
  "bank_account_id",
  "merchant",
];
/** Fields the receipt's Categorize suggestion is built from. */
const SUGGESTION_FIELDS: (keyof ReceiptInput)[] = [
  "account_id",
  "contact_id",
  "memo",
  "merchant",
  "business_purpose",
];

async function checkRefs(tx: Reader, input: ReceiptInput) {
  for (const k of ["amount", "pre_tip_amount", "tax_amount", "tip_amount"] as const) {
    const v = input[k];
    if (v != null && (!Number.isSafeInteger(v) || v < 0 || (k === "amount" && v === 0)))
      throw unprocessable(
        `${k} must be ${k === "amount" ? "positive" : "zero or more"} integer cents.`,
        "invalid_amount",
      );
  }
  if (input.receipt_date && !/^\d{4}-\d{2}-\d{2}$/.test(input.receipt_date))
    throw unprocessable("receipt_date must be YYYY-MM-DD.", "invalid_date");
  if (input.receipt_time && !/^\d{2}:\d{2}$/.test(input.receipt_time))
    throw unprocessable("receipt_time must be HH:MM.", "invalid_time");
  if (input.bank_account_id) {
    const b = await tx
      .select()
      .from(org.bankAccounts)
      .where(eq(org.bankAccounts.id, input.bank_account_id))
      .get();
    if (!b) throw unprocessable("Unknown bank account.", "invalid_bank_account");
  }
  if (input.account_id) {
    const acct = await tx.select().from(org.accounts).where(eq(org.accounts.id, input.account_id)).get();
    if (!acct?.isActive) throw unprocessable("Unknown or inactive account.", "invalid_account");
  }
  if (input.contact_id) {
    const c = await tx.select().from(org.contacts).where(eq(org.contacts.id, input.contact_id)).get();
    if (!c) throw unprocessable("Unknown contact.", "invalid_contact");
  }
}

function clean(v: unknown) {
  return typeof v === "string" ? v.trim() || null : v;
}

/** Create a receipt, with its file when one was uploaded (store the blob first, outside the transaction). */
export async function createReceiptTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: ReceiptInput,
  blob?: StoredBlob | null,
) {
  if (!blob && input.amount == null)
    throw unprocessable("Add a photo of the receipt or the amount charged.", "receipt_empty");
  await checkRefs(tx, input);
  const id = newId();
  const values: typeof org.receipts.$inferInsert = {
    id,
    receiptDate: today(),
    createdBy: a.userId,
    createdByActor: a.actor,
  };
  for (const [k, col] of FIELDS) {
    const v = clean(input[k]);
    if (v !== undefined && v !== null) (values as Record<string, unknown>)[col] = v;
  }
  await tx.insert(org.receipts).values(values);
  if (blob) {
    await recordAttachmentTx(tx, orgId, a, blob, { type: "receipt", id });
    await tx.update(org.receipts).set({ attachmentId: blob.id }).where(eq(org.receipts.id, id));
  }
  const row = await mustGetReceipt(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "receipt.create",
    targetType: "receipt",
    targetId: id,
    after: auditFields(row),
  });
  await matchForReceiptTx(tx, orgId, a, id);
  return mustGetReceipt(tx, id);
}

export async function updateReceiptTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: ReceiptInput,
) {
  const before = await mustGetReceipt(tx, id);
  if (before.status === "booked")
    throw conflict("This receipt is already booked; change the bill or entry instead.", "invalid_state");
  await checkRefs(tx, input);
  const patch: Partial<typeof org.receipts.$inferInsert> = {};
  const changed = new Set<keyof ReceiptInput>();
  for (const [k, col] of FIELDS) {
    if (input[k] === undefined) continue;
    const v = clean(input[k]);
    if (k === "receipt_date" && v === null) continue;
    if (k === "extraction_source" && v === null) continue;
    if ((before as Record<string, unknown>)[col] === v) continue;
    (patch as Record<string, unknown>)[col] = v;
    changed.add(k);
  }
  if (!changed.size) return before;
  patch.updatedAt = new Date().toISOString();
  await tx.update(org.receipts).set(patch).where(eq(org.receipts.id, id));
  const after = await mustGetReceipt(tx, id);
  if (after.amount == null && !after.attachmentId)
    throw unprocessable("A receipt needs a photo or the amount charged.", "receipt_empty");
  await appendAudit(tx, orgId, a, {
    action: "receipt.update",
    targetType: "receipt",
    targetId: id,
    before: auditFields(before),
    after: auditFields(after),
  });
  if (after.status === "inbox" && MATCH_FIELDS.some((k) => changed.has(k))) {
    await matchForReceiptTx(tx, orgId, a, id);
  } else if (SUGGESTION_FIELDS.some((k) => changed.has(k))) {
    await refreshTxnSuggestionTx(tx, after.matchedBankTxnId ?? after.suggestedBankTxnId);
  }
  return mustGetReceipt(tx, id);
}

/**
 * Attach or replace the receipt's file. Every link the old file had (receipt, transaction, entry,
 * bill) moves to the new one, so the old file is left unlinked but kept (attachments are never
 * deleted).
 */
export async function setReceiptFileTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string, blob: StoredBlob) {
  const before = await mustGetReceipt(tx, id);
  await recordAttachmentTx(tx, orgId, a, blob, null);
  if (before.attachmentId) {
    const links = await tx
      .select()
      .from(org.attachmentLinks)
      .where(eq(org.attachmentLinks.attachmentId, before.attachmentId))
      .all();
    for (const l of links) {
      await unlinkAttachmentTx(tx, orgId, a, before.attachmentId, { type: l.targetType, id: l.targetId });
      await tx
        .insert(org.attachmentLinks)
        .values({ attachmentId: blob.id, targetType: l.targetType, targetId: l.targetId })
        .onConflictDoNothing();
      await appendAudit(tx, orgId, a, {
        action: "attachment.link",
        targetType: "attachment",
        targetId: blob.id,
        after: { type: l.targetType, id: l.targetId },
      });
    }
  }
  await tx
    .update(org.receipts)
    .set({ attachmentId: blob.id, updatedAt: new Date().toISOString() })
    .where(eq(org.receipts.id, id));
  const after = await mustGetReceipt(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "receipt.update",
    targetType: "receipt",
    targetId: id,
    before: { attachment_id: before.attachmentId },
    after: { attachment_id: blob.id },
  });
  await ensureLinksTx(tx, orgId, a, after);
  if (after.bookedTargetType && after.bookedTargetId)
    await ensureLinkTx(tx, orgId, a, blob.id, { type: after.bookedTargetType, id: after.bookedTargetId });
  if (after.status === "inbox") await matchForReceiptTx(tx, orgId, a, id);
  return mustGetReceipt(tx, id);
}

/**
 * Match a receipt to a transaction by hand. Picking the transaction it was suggested for confirms
 * the suggestion; a transaction it was rejected for may be picked, and leaves the rejected list.
 */
export async function matchReceiptTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string, txnId: string) {
  const r = await mustGetReceipt(tx, id);
  if (r.status === "matched" && r.matchedBankTxnId === txnId) return r;
  if (r.status !== "inbox")
    throw conflict(
      r.status === "matched"
        ? "This receipt is matched to another transaction. Unmatch it first."
        : `This receipt is ${r.status}.`,
      "invalid_state",
    );
  const t = await mustGetBankTxn(tx, txnId);
  if (t.amount >= 0) throw unprocessable("A receipt can only match money going out.", "invalid_transaction");
  if (t.isPending)
    throw conflict("Pending transactions can be matched once the bank posts them.", "pending_transaction");
  if (t.status === "excluded") throw conflict("That transaction is excluded.", "invalid_state");
  return attachTx(tx, orgId, a, r, t, r.suggestedBankTxnId === t.id ? "confirmed" : "manual");
}

/**
 * "Not this receipt": undo a match or turn down a suggestion. The transaction joins the receipt's
 * rejected list, so it is never matched or suggested again, and the file is unlinked from the
 * transaction and its entries. The receipt goes back to the inbox and is matched again.
 */
export async function unmatchReceiptTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const r = await mustGetReceipt(tx, id);
  const txnId =
    r.status === "matched" ? r.matchedBankTxnId : r.status === "inbox" ? r.suggestedBankTxnId : null;
  if (!txnId) throw conflict("This receipt isn't matched to a transaction.", "invalid_state");
  if (r.status === "matched" && r.attachmentId) {
    await dropLinkTx(tx, orgId, a, r.attachmentId, { type: "bank_transaction", id: txnId });
    const t = await tx.select().from(org.bankTransactions).where(eq(org.bankTransactions.id, txnId)).get();
    const entries = await tx
      .select({ id: org.journalEntries.id })
      .from(org.journalEntries)
      .where(
        or(
          t?.matchedEntryId ? eq(org.journalEntries.id, t.matchedEntryId) : sql`0`,
          and(
            inArray(org.journalEntries.sourceType, ["bank_transaction", "transfer"]),
            eq(org.journalEntries.sourceId, txnId),
          ),
        ),
      )
      .all();
    for (const e of entries)
      await dropLinkTx(tx, orgId, a, r.attachmentId, { type: "journal_entry", id: e.id });
  }
  await tx
    .update(org.receipts)
    .set({
      status: "inbox",
      matchedBankTxnId: null,
      matchMethod: null,
      matchedAt: null,
      suggestedBankTxnId: null,
      rejectedTxnIdsJson: JSON.stringify([...new Set([...rejectedIds(r), txnId])]),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(org.receipts.id, id));
  await appendAudit(tx, orgId, a, {
    action: "receipt.unmatch",
    targetType: "receipt",
    targetId: id,
    before: { status: r.status, bank_transaction_id: txnId, match_method: r.matchMethod },
    after: { status: "inbox", rejected: txnId },
  });
  await refreshTxnSuggestionTx(tx, txnId);
  return matchForReceiptTx(tx, orgId, a, id);
}

export async function dismissReceiptTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  reason?: string | null,
) {
  const r = await mustGetReceipt(tx, id);
  if (r.status !== "inbox")
    throw conflict(
      r.status === "matched" ? "Unmatch this receipt before dismissing it." : `This receipt is ${r.status}.`,
      "invalid_state",
    );
  await tx
    .update(org.receipts)
    .set({
      status: "dismissed",
      suggestedBankTxnId: null,
      dismissedReason: clean(reason) as string | null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(org.receipts.id, id));
  await appendAudit(tx, orgId, a, {
    action: "receipt.dismiss",
    targetType: "receipt",
    targetId: id,
    after: { reason: clean(reason) ?? null },
  });
  await refreshTxnSuggestionTx(tx, r.suggestedBankTxnId);
  return mustGetReceipt(tx, id);
}

export async function restoreReceiptTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const r = await mustGetReceipt(tx, id);
  if (r.status !== "dismissed") throw conflict("Only dismissed receipts can be restored.", "invalid_state");
  await tx
    .update(org.receipts)
    .set({ status: "inbox", dismissedReason: null, updatedAt: new Date().toISOString() })
    .where(eq(org.receipts.id, id));
  await appendAudit(tx, orgId, a, {
    action: "receipt.restore",
    targetType: "receipt",
    targetId: id,
    before: { reason: r.dismissedReason },
  });
  return matchForReceiptTx(tx, orgId, a, id);
}

export type BookInput =
  | { as: "bill"; vendor_id?: string | null; rationale?: string | null }
  | { as: "entry"; credit_account_id: string; rationale?: string | null; lock_override_note?: string | null };

/**
 * Book a receipt that will never meet a bank transaction (paid in cash, or from a personal card):
 * as a draft bill to finalize on the bill page, or as an entry through the review policy.
 */
export async function bookReceiptTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string, input: BookInput) {
  const r = await mustGetReceipt(tx, id);
  if (r.status !== "inbox")
    throw conflict(
      r.status === "matched"
        ? "This receipt is matched to a bank transaction; categorize that instead."
        : `This receipt is ${r.status}.`,
      "invalid_state",
    );
  if (r.amount == null) throw unprocessable("Add the amount before booking the receipt.", "missing_amount");
  if (!r.accountId) throw unprocessable("Choose the account before booking the receipt.", "missing_account");
  const memo = receiptMemo({ memo: r.memo, merchant: r.merchant, business_purpose: r.businessPurpose });
  let target: { type: "bill" | "journal_entry"; id: string };
  let result: SubmitResult | null = null;
  if (input.as === "bill") {
    const vendorId = input.vendor_id ?? r.contactId;
    if (!vendorId) throw unprocessable("Choose a vendor for the bill.", "missing_vendor");
    const { bill } = await createBillTx(tx, orgId, a, {
      vendor_id: vendorId,
      issue_date: r.receiptDate,
      memo,
      lines: [{ description: memo ?? "Receipt", amount: r.amount, account_id: r.accountId }],
      draft: true,
    });
    target = { type: "bill", id: bill.id };
  } else {
    if (input.credit_account_id === r.accountId)
      throw unprocessable("Choose a different account to pay from.", "invalid_account");
    result = await submitEntryTx(tx, orgId, a, {
      date: r.receiptDate,
      memo,
      lines: [
        { accountId: r.accountId, amount: r.amount, contactId: r.contactId },
        { accountId: input.credit_account_id, amount: -r.amount },
      ],
      sourceType: "manual",
      rationale: input.rationale ?? null,
      lockOverrideNote: input.lock_override_note ?? null,
    });
    target = { type: "journal_entry", id: result.entry.id };
  }
  await tx
    .update(org.receipts)
    .set({
      status: "booked",
      suggestedBankTxnId: null,
      bookedTargetType: target.type,
      bookedTargetId: target.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(org.receipts.id, id));
  await ensureLinkTx(tx, orgId, a, r.attachmentId, target);
  await appendAudit(tx, orgId, a, {
    action: "receipt.book",
    targetType: "receipt",
    targetId: id,
    after: { as: input.as, target_type: target.type, target_id: target.id },
  });
  await refreshTxnSuggestionTx(tx, r.suggestedBankTxnId);
  return { receipt: await mustGetReceipt(tx, id), target, result };
}

/** Candidate transactions for the match picker, best first; rejected ones are included and flagged. */
export async function receiptCandidates(db: Reader, id: string) {
  const r = await mustGetReceipt(db, id);
  const cands = await candidateTxns(db, r, { includeRejected: true });
  return cands.map((c) => ({
    transaction: txnSummary(c.t),
    fit: c.fit,
    merchant_match: c.merchant,
    days_apart: c.days,
    rejected: c.rejected,
    suggested: r.suggestedBankTxnId === c.id,
  }));
}
