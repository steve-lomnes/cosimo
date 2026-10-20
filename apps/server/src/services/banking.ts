/**
 * Bank accounts and the Categorize workflow (SPEC §7.3): categorize, split, match, transfer,
 * exclude, and undo. Every categorization goes through the posting pipeline, so the review policy
 * and lock dates apply exactly as for manual entries.
 */
import { checkLock, validateLines } from "@cosimo/core";
import { firstMatchingRule, type RuleActions, type RuleConditions, type RuleDef } from "@cosimo/core/rules";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { addDays } from "@cosimo/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, type SQL, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import { type ActorInfo, SYSTEM_ACTOR } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { type SyncStatusView, syncStatusView } from "./bank-sync.ts";
import {
  accountMap,
  mustGetEntry,
  rejectEntryTx,
  reverseEntryTx,
  type SubmitResult,
  settingsRow,
  submitEntryTx,
} from "./ledger.ts";
import {
  matchForReceiptTx,
  matchForTxnTx,
  onTxnCategorizedTx,
  releaseReceiptsForTxnTx,
  withReceipts,
} from "./receipts.ts";

type Reader = OrgDb | OrgTx;
type BankAccountRow = typeof org.bankAccounts.$inferSelect;
type BankTxnRow = typeof org.bankTransactions.$inferSelect;

/**
 * A transaction's bucket on the Categorize page. Checked in this order, so a row falls into
 * exactly one bucket. Every count and filter below uses this one expression, so they can't drift
 * apart: excluded first, then categorized (posted or matched, or already waiting in the review
 * queue), then pending (locked at the bank), and everything else is to categorize.
 */
export type TxnBucket = "to_categorize" | "pending" | "categorized" | "excluded";

const bucketSql = sql<TxnBucket>`case
  when ${org.bankTransactions.status} = 'excluded' then 'excluded'
  when ${org.bankTransactions.status} in ('categorized', 'matched')
    or ${org.bankTransactions.reviewItemId} is not null then 'categorized'
  when ${org.bankTransactions.isPending} then 'pending'
  else 'to_categorize'
end`;

/** TS twin of `bucketSql`, for a row already loaded in memory. */
export function txnBucket(t: Pick<BankTxnRow, "status" | "reviewItemId" | "isPending">): TxnBucket {
  if (t.status === "excluded") return "excluded";
  if (t.status === "categorized" || t.status === "matched" || t.reviewItemId) return "categorized";
  if (t.isPending) return "pending";
  return "to_categorize";
}

/** How far apart (days) the two sides of a transfer may post. */
export const TRANSFER_WINDOW_DAYS = 5;

export const RULE_ACTOR: ActorInfo = { actor: "rule", role: "bookkeeper", userId: null };

// ----------------------------------------------------------------------------- bank accounts

/** A bank account with its feed's sync status (all null for an account with no bank feed). */
export interface BankAccountView extends SyncStatusView {
  id: string;
  name: string;
  kind: BankAccountRow["kind"];
  mask: string | null;
  currency: string;
  is_active: boolean;
  ledger_account_id: string;
  connection_id: string | null;
  /** Ledger balance with normal sign (positive = money in the account / owed on the card). */
  balance: number;
  /** Rows someone can act on now: not pending, and not already waiting in the review queue. */
  unreviewed: number;
  /** Rows still pending at the bank; they move to `unreviewed` once posted. */
  pending: number;
  /** Signed cents sum of `pending`. */
  pending_amount: number;
  last_transaction_date: string | null;
}

export async function listBankAccounts(db: Reader): Promise<BankAccountView[]> {
  const rows = await db.select().from(org.bankAccounts).orderBy(asc(org.bankAccounts.createdAt)).all();
  if (!rows.length) return [];
  const bal = await db
    .select({ accountId: org.journalLines.accountId, total: sql<number>`sum(${org.journalLines.amount})` })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalEntries.status, "posted"),
        inArray(
          org.journalLines.accountId,
          rows.map((r) => r.ledgerAccountId),
        ),
      ),
    )
    .groupBy(org.journalLines.accountId)
    .all();
  const balBy = new Map(bal.map((b) => [b.accountId, Number(b.total)]));
  const counts = await db
    .select({
      id: org.bankTransactions.bankAccountId,
      n: sql<number>`sum(case when ${bucketSql} = 'to_categorize' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${bucketSql} = 'pending' then 1 else 0 end)`,
      pendingAmount: sql<number>`sum(case when ${bucketSql} = 'pending' then ${org.bankTransactions.amount} else 0 end)`,
      last: sql<string | null>`max(${org.bankTransactions.date})`,
    })
    .from(org.bankTransactions)
    .groupBy(org.bankTransactions.bankAccountId)
    .all();
  const cBy = new Map(counts.map((c) => [c.id, c]));
  const types = await accountMap(db);
  const conns = new Map((await db.select().from(org.bankConnections).all()).map((c) => [c.id, c]));
  return rows.map((r) => {
    const raw = balBy.get(r.ledgerAccountId) ?? 0;
    const t = types.get(r.ledgerAccountId)?.type;
    const c = cBy.get(r.id);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      mask: r.mask,
      currency: r.currency,
      is_active: r.isActive,
      ledger_account_id: r.ledgerAccountId,
      connection_id: r.connectionId,
      balance: t === "asset" ? raw : -raw,
      unreviewed: Number(c?.n ?? 0),
      pending: Number(c?.pending ?? 0),
      pending_amount: Number(c?.pendingAmount ?? 0),
      last_transaction_date: c?.last ?? null,
      ...syncStatusView(r.connectionId ? conns.get(r.connectionId) : null),
    };
  });
}

export async function mustGetBankAccount(db: Reader, id: string) {
  const b = await db.select().from(org.bankAccounts).where(eq(org.bankAccounts.id, id)).get();
  if (!b) throw notFound("Bank account");
  return b;
}

async function nextCode(tx: OrgTx, start: number) {
  const codes = new Set(
    (await tx.select({ code: org.accounts.code }).from(org.accounts).all()).map((r) => r.code),
  );
  for (let c = start; c < start + 1000; c++) if (!codes.has(String(c))) return String(c);
  throw conflict("No free account code in range.");
}

export interface BankAccountInput {
  name: string;
  kind: BankAccountRow["kind"];
  mask?: string | null;
  /** Link an existing ledger account; when omitted a new one is created. */
  ledger_account_id?: string | null;
  connection_id?: string | null;
  provider_account_id?: string | null;
}

export async function createBankAccountTx(tx: OrgTx, orgId: string, a: ActorInfo, input: BankAccountInput) {
  const s = await settingsRow(tx);
  let ledgerId = input.ledger_account_id ?? null;
  if (ledgerId) {
    const acct = await tx.select().from(org.accounts).where(eq(org.accounts.id, ledgerId)).get();
    if (!acct) throw notFound("Ledger account");
    const okType = input.kind === "credit_card" ? acct.type === "liability" : acct.type === "asset";
    if (!okType) {
      throw unprocessable(
        input.kind === "credit_card"
          ? "A credit card must be linked to a liability account."
          : "A bank account must be linked to an asset account.",
        "invalid_account",
      );
    }
    const taken = await tx
      .select({ id: org.bankAccounts.id })
      .from(org.bankAccounts)
      .where(eq(org.bankAccounts.ledgerAccountId, ledgerId))
      .get();
    if (taken) throw conflict("That ledger account is already linked to a bank account.", "already_linked");
  } else {
    const isCard = input.kind === "credit_card";
    ledgerId = newId();
    await tx.insert(org.accounts).values({
      id: ledgerId,
      code: await nextCode(tx, isCard ? 2110 : 1020),
      name: input.mask ? `${input.name} (${input.mask})` : input.name,
      type: isCard ? "liability" : "asset",
      subtype: isCard ? "credit_card" : "bank",
      currency: s.baseCurrency,
    });
    await appendAudit(tx, orgId, a, {
      action: "account.create",
      targetType: "account",
      targetId: ledgerId,
      after: { name: input.name, for_bank_account: true },
    });
  }
  const id = newId();
  await tx.insert(org.bankAccounts).values({
    id,
    ledgerAccountId: ledgerId,
    name: input.name,
    mask: input.mask ?? null,
    kind: input.kind,
    currency: s.baseCurrency,
    connectionId: input.connection_id ?? null,
    providerAccountId: input.provider_account_id ?? null,
  });
  await appendAudit(tx, orgId, a, {
    action: "bank_account.create",
    targetType: "bank_account",
    targetId: id,
    after: { name: input.name, kind: input.kind, mask: input.mask ?? null, ledger_account_id: ledgerId },
  });
  return mustGetBankAccount(tx, id);
}

export async function updateBankAccountTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: { name?: string; mask?: string | null; is_active?: boolean },
) {
  const before = await mustGetBankAccount(tx, id);
  const patch: Partial<typeof org.bankAccounts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.mask !== undefined) patch.mask = input.mask;
  if (input.is_active !== undefined) patch.isActive = input.is_active;
  if (Object.keys(patch).length)
    await tx.update(org.bankAccounts).set(patch).where(eq(org.bankAccounts.id, id));
  const after = await mustGetBankAccount(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "bank_account.update",
    targetType: "bank_account",
    targetId: id,
    before: { name: before.name, mask: before.mask, is_active: before.isActive },
    after: { name: after.name, mask: after.mask, is_active: after.isActive },
  });
  return after;
}

// ----------------------------------------------------------------------------- transactions

export interface BankTxnView {
  id: string;
  bank_account_id: string;
  date: string;
  amount: number;
  description: string;
  payee: string | null;
  is_pending: boolean;
  status: BankTxnRow["status"];
  entry_id: string | null;
  entry_status: string | null;
  review_item_id: string | null;
  rule_id: string | null;
  suggestion: Suggestion | null;
  batch_id: string | null;
  provider_transaction_id: string | null;
  /** The receipt matched to this transaction (receipt inbox). */
  receipt_id: string | null;
  /** Inbox receipts suggested for this transaction, not yet confirmed. */
  suggested_receipt_ids: string[];
}

export interface Suggestion {
  source: "rule" | "history" | "payout" | "receipt";
  account_id?: string | null;
  transfer_account_id?: string | null;
  contact_id?: string | null;
  memo?: string | null;
  rule_id?: string | null;
  rule_name?: string | null;
  /** A payment provider's payout this deposit matches (`source: "payout"`); linked when accepted. */
  payout_id?: string | null;
  payout_arrival_date?: string | null;
  /** The receipt this suggestion comes from (`source: "receipt"`, or a rule's memo filled from it). */
  receipt_id?: string | null;
}

export function bankTxnView(t: BankTxnRow, entryStatus: string | null = null): BankTxnView {
  return {
    id: t.id,
    bank_account_id: t.bankAccountId,
    date: t.date,
    amount: t.amount,
    description: t.description,
    payee: t.payee,
    is_pending: t.isPending,
    status: t.status,
    entry_id: t.matchedEntryId,
    entry_status: entryStatus,
    review_item_id: t.reviewItemId,
    rule_id: t.ruleId,
    suggestion: t.suggestionJson ? (JSON.parse(t.suggestionJson) as Suggestion) : null,
    batch_id: t.batchId,
    provider_transaction_id: t.providerTransactionId,
    receipt_id: null,
    suggested_receipt_ids: [],
  };
}

export async function mustGetBankTxn(db: Reader, id: string) {
  const t = await db.select().from(org.bankTransactions).where(eq(org.bankTransactions.id, id)).get();
  if (!t) throw notFound("Bank transaction");
  return t;
}

export interface BankTxnFilter {
  bankAccountId?: string;
  status?: BankTxnRow["status"][];
  bucket?: TxnBucket[];
  /** Only transactions with (true) or without (false) a matched or suggested receipt. */
  has_receipt?: boolean;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
}

/** The account and search conditions shared by `listBankTxns` and `countBankTxns`. */
function accountAndSearchConds(t: typeof org.bankTransactions, f: { bankAccountId?: string; q?: string }) {
  const conds: SQL[] = [];
  if (f.bankAccountId) conds.push(eq(t.bankAccountId, f.bankAccountId));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "").toLowerCase()}%`;
    conds.push(sql`(lower(${t.description}) like ${like} or lower(coalesce(${t.payee}, '')) like ${like})`);
  }
  return conds;
}

export async function listBankTxns(db: Reader, f: BankTxnFilter) {
  const t = org.bankTransactions;
  const conds: SQL[] = accountAndSearchConds(t, f);
  if (f.status?.length) conds.push(inArray(t.status, f.status));
  if (f.bucket?.length) conds.push(inArray(bucketSql, f.bucket));
  if (f.has_receipt !== undefined) {
    const has = sql`exists (select 1 from receipts x where x.matched_bank_txn_id = ${t.id} or (x.status = 'inbox' and x.suggested_bank_txn_id = ${t.id}))`;
    conds.push(f.has_receipt ? has : sql`not ${has}`);
  }
  if (f.from) conds.push(gte(t.date, f.from));
  if (f.to) conds.push(lte(t.date, f.to));
  if (f.cursor) {
    const [d, id] = f.cursor.split("|");
    if (d && id) conds.push(sql`(${t.date} < ${d} or (${t.date} = ${d} and ${t.id} < ${id}))`);
  }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = await db
    .select({ t, entryStatus: org.journalEntries.status })
    .from(t)
    .leftJoin(org.journalEntries, eq(org.journalEntries.id, t.matchedEntryId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.date), desc(t.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: await withReceipts(
      db,
      page.map((r) => bankTxnView(r.t, r.entryStatus)),
    ),
    next_cursor: rows.length > limit && last ? `${last.t.date}|${last.t.id}` : null,
  };
}

export interface BankTxnCounts {
  all: number;
  to_categorize: number;
  pending: { count: number; total: number };
  categorized: number;
  excluded: number;
}

/** Counts of transactions per bucket, for the Categorize page's filter pills. */
export async function countBankTxns(
  db: Reader,
  f: { bankAccountId?: string; q?: string },
): Promise<BankTxnCounts> {
  const t = org.bankTransactions;
  const rows = await db
    .select({ bucket: bucketSql, n: sql<number>`count(*)`, total: sql<number>`sum(${t.amount})` })
    .from(t)
    .where(and(...accountAndSearchConds(t, f)))
    .groupBy(bucketSql)
    .all();
  const by = new Map(rows.map((r) => [r.bucket, r]));
  const n = (b: TxnBucket) => Number(by.get(b)?.n ?? 0);
  return {
    all: rows.reduce((s, r) => s + Number(r.n), 0),
    to_categorize: n("to_categorize"),
    pending: { count: n("pending"), total: Number(by.get("pending")?.total ?? 0) },
    categorized: n("categorized"),
    excluded: n("excluded"),
  };
}

export function assertReviewable(t: BankTxnRow) {
  if (t.isPending)
    throw conflict(
      "Pending transactions can be categorized once the bank posts them.",
      "pending_transaction",
    );
  if (t.status !== "new")
    throw conflict(`This transaction is already ${t.status}. Undo it first.`, "invalid_state");
  if (t.reviewItemId)
    throw conflict("A categorization for this transaction is waiting in the review queue.", "pending_review");
}

// ----------------------------------------------------------------------------- categorize

export interface Split {
  account_id: string;
  /** Positive portion of the transaction amount (cents). */
  amount: number;
  contact_id?: string | null;
  description?: string | null;
}

export interface CategorizeInput {
  splits: Split[];
  memo?: string | null;
  contact_id?: string | null;
  rationale?: string | null;
  lock_override_note?: string | null;
}

async function accountUsedForPayee(tx: Reader, t: BankTxnRow, accountIds: string[]) {
  if (!accountIds.length) return false;
  const rows = await tx
    .select({ id: org.journalLines.accountId })
    .from(org.bankTransactions)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.bankTransactions.matchedEntryId))
    .innerJoin(org.journalLines, eq(org.journalLines.entryId, org.journalEntries.id))
    .where(
      and(
        eq(org.bankTransactions.normalizedDescription, t.normalizedDescription),
        eq(org.journalEntries.status, "posted"),
        ne(org.bankTransactions.id, t.id),
      ),
    )
    .all();
  const used = new Set(rows.map((r) => r.id));
  return accountIds.every((id) => used.has(id));
}

async function linkResult(tx: OrgTx, txnIds: string[], r: SubmitResult, extra: Partial<BankTxnRow> = {}) {
  const posted = r.entry.status === "posted";
  await tx
    .update(org.bankTransactions)
    .set({
      matchedEntryId: r.entry.id,
      reviewItemId: r.reviewItemId,
      status: posted ? "categorized" : "new",
      ...extra,
    })
    .where(inArray(org.bankTransactions.id, txnIds));
}

/** Categorize (or split) a bank transaction into one entry against the bank's ledger account. */
export async function categorizeTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  txnId: string,
  input: CategorizeInput,
  opts: { ruleId?: string | null; ruleAutoPost?: boolean } = {},
) {
  const t = await mustGetBankTxn(tx, txnId);
  assertReviewable(t);
  const bank = await mustGetBankAccount(tx, t.bankAccountId);
  if (!input.splits.length) throw unprocessable("Choose at least one account.", "empty");
  const total = input.splits.reduce((s, x) => s + x.amount, 0);
  if (input.splits.some((x) => !Number.isSafeInteger(x.amount) || x.amount <= 0)) {
    throw unprocessable("Split amounts must be positive.", "invalid_amount");
  }
  if (total !== Math.abs(t.amount)) {
    throw unprocessable(
      `Splits add up to ${(total / 100).toFixed(2)} but the transaction is ${(Math.abs(t.amount) / 100).toFixed(2)}.`,
      "split_mismatch",
    );
  }
  if (input.splits.some((x) => x.account_id === bank.ledgerAccountId)) {
    throw unprocessable("A transaction cannot be categorized to its own bank account.", "invalid_account");
  }
  const sign = t.amount > 0 ? -1 : 1;
  const lines = [
    {
      accountId: bank.ledgerAccountId,
      amount: t.amount,
      description: t.description,
      contactId: input.contact_id ?? null,
    },
    ...input.splits.map((x) => ({
      accountId: x.account_id,
      amount: sign * x.amount,
      description: x.description ?? null,
      contactId: x.contact_id ?? input.contact_id ?? null,
    })),
  ];
  const r = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: t.date,
      memo: input.memo ?? t.payee ?? t.description,
      lines,
      sourceType: "bank_transaction",
      sourceId: t.id,
      rationale: input.rationale ?? null,
      lockOverrideNote: input.lock_override_note ?? null,
    },
    {
      itemType: "bank_categorization",
      ruleAutoPost: opts.ruleAutoPost,
      accountUsedForPayee: await accountUsedForPayee(
        tx,
        t,
        input.splits.map((x) => x.account_id),
      ),
      reviewContext: { bank_transaction: bankTxnView(t) },
    },
  );
  await linkResult(tx, [t.id], r, { ruleId: opts.ruleId ?? null });
  // A receipt suggested for this transaction is confirmed, and the matched receipt's file is
  // linked to the new entry (posted or proposed).
  await onTxnCategorizedTx(tx, orgId, a, t.id, r.entry.id);
  return r;
}

/** Candidate counterpart for a transfer: the other side as an unreviewed bank transaction. */
export async function findTransferCounterpart(tx: Reader, t: BankTxnRow, otherLedgerId: string) {
  const other = await tx
    .select()
    .from(org.bankAccounts)
    .where(eq(org.bankAccounts.ledgerAccountId, otherLedgerId))
    .get();
  if (!other) return null;
  const rows = await tx
    .select()
    .from(org.bankTransactions)
    .where(
      and(
        eq(org.bankTransactions.bankAccountId, other.id),
        eq(org.bankTransactions.amount, -t.amount),
        eq(org.bankTransactions.status, "new"),
        eq(org.bankTransactions.isPending, false),
        isNull(org.bankTransactions.reviewItemId),
        gte(org.bankTransactions.date, addDays(t.date, -TRANSFER_WINDOW_DAYS)),
        lte(org.bankTransactions.date, addDays(t.date, TRANSFER_WINDOW_DAYS)),
      ),
    )
    .all();
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(t.date));
  return rows.sort((x, y) => dist(x.date) - dist(y.date) || x.id.localeCompare(y.id))[0] ?? null;
}

/**
 * Transfer between two of the org's own accounts: always one entry with two lines (SPEC §6 #7).
 * If the other side was already imported as a bank transaction, both are linked to that entry.
 */
export async function transferTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  txnId: string,
  input: {
    account_id: string;
    memo?: string | null;
    rationale?: string | null;
    lock_override_note?: string | null;
  },
  opts: { ruleId?: string | null; ruleAutoPost?: boolean } = {},
) {
  const t = await mustGetBankTxn(tx, txnId);
  assertReviewable(t);
  const bank = await mustGetBankAccount(tx, t.bankAccountId);
  if (input.account_id === bank.ledgerAccountId)
    throw unprocessable("Choose a different account.", "invalid_account");
  const target = (await accountMap(tx)).get(input.account_id);
  if (!target) throw notFound("Account");
  if (target.type !== "asset" && target.type !== "liability") {
    throw unprocessable("Transfers go to another bank, card, or balance sheet account.", "invalid_account");
  }
  const counterpart = await findTransferCounterpart(tx, t, input.account_id);
  const r = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: counterpart && counterpart.date < t.date ? counterpart.date : t.date,
      memo: input.memo ?? `Transfer: ${t.description}`,
      lines: [
        { accountId: bank.ledgerAccountId, amount: t.amount, description: t.description },
        { accountId: input.account_id, amount: -t.amount, description: counterpart?.description ?? null },
      ],
      sourceType: "transfer",
      sourceId: t.id,
      rationale: input.rationale ?? null,
      lockOverrideNote: input.lock_override_note ?? null,
    },
    {
      itemType: "bank_categorization",
      ruleAutoPost: opts.ruleAutoPost,
      reviewContext: { bank_transaction: bankTxnView(t), transfer_counterpart_id: counterpart?.id ?? null },
    },
  );
  await linkResult(tx, counterpart ? [t.id, counterpart.id] : [t.id], r, { ruleId: opts.ruleId ?? null });
  const sug = t.suggestionJson ? (JSON.parse(t.suggestionJson) as Suggestion) : null;
  if (sug?.payout_id) await linkPayoutTx(tx, sug.payout_id, t, input.account_id, r.entry.id);
  return { ...r, counterpartId: counterpart?.id ?? null };
}

/** Link a bank transaction to an entry already recorded (an invoice payment, a transfer, ...). */
export async function matchTx(tx: OrgTx, orgId: string, a: ActorInfo, txnId: string, entryId: string) {
  const t = await mustGetBankTxn(tx, txnId);
  assertReviewable(t);
  const bank = await mustGetBankAccount(tx, t.bankAccountId);
  const e = await mustGetEntry(tx, entryId);
  if (e.status !== "posted") throw conflict("Only posted entries can be matched.", "invalid_state");
  const hit = e.lines.some((l) => l.account_id === bank.ledgerAccountId && l.amount === t.amount);
  if (!hit) {
    throw unprocessable(
      "That entry has no line on this bank account for the same amount.",
      "no_matching_line",
    );
  }
  const taken = await tx
    .select({ id: org.bankTransactions.id })
    .from(org.bankTransactions)
    .where(
      and(
        eq(org.bankTransactions.matchedEntryId, entryId),
        eq(org.bankTransactions.bankAccountId, t.bankAccountId),
        ne(org.bankTransactions.id, t.id),
      ),
    )
    .get();
  if (taken)
    throw conflict(
      "That entry is already matched to another transaction in this account.",
      "already_matched",
    );
  await tx
    .update(org.bankTransactions)
    .set({ status: "matched", matchedEntryId: entryId })
    .where(eq(org.bankTransactions.id, t.id));
  await appendAudit(tx, orgId, a, {
    action: "bank_transaction.match",
    targetType: "bank_transaction",
    targetId: t.id,
    after: { entry_id: entryId },
  });
}

/** Posted entries that could match this transaction: same amount on the bank's ledger account nearby. */
export async function matchCandidates(db: Reader, txnId: string) {
  const t = await mustGetBankTxn(db, txnId);
  const bank = await mustGetBankAccount(db, t.bankAccountId);
  const rows = await db
    .select({
      id: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      source: org.journalEntries.sourceType,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalLines.accountId, bank.ledgerAccountId),
        eq(org.journalLines.amount, t.amount),
        eq(org.journalEntries.status, "posted"),
        isNull(org.journalEntries.reversedByEntryId),
        isNull(org.journalEntries.reversesEntryId),
        gte(org.journalEntries.date, addDays(t.date, -30)),
        lte(org.journalEntries.date, addDays(t.date, 30)),
        sql`not exists (select 1 from bank_transactions b where b.matched_entry_id = ${org.journalEntries.id} and b.bank_account_id = ${t.bankAccountId})`,
      ),
    )
    .limit(20)
    .all();
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(t.date));
  return rows.sort((x, y) => dist(x.date) - dist(y.date));
}

export async function excludeTx(tx: OrgTx, orgId: string, a: ActorInfo, txnId: string, exclude: boolean) {
  const t = await mustGetBankTxn(tx, txnId);
  if (exclude) {
    assertReviewable(t);
  } else if (t.status !== "excluded") {
    throw conflict("Only excluded transactions can be restored.", "invalid_state");
  }
  await tx
    .update(org.bankTransactions)
    .set({ status: exclude ? "excluded" : "new" })
    .where(eq(org.bankTransactions.id, txnId));
  await appendAudit(tx, orgId, a, {
    action: exclude ? "bank_transaction.exclude" : "bank_transaction.restore",
    targetType: "bank_transaction",
    targetId: txnId,
  });
  if (exclude) {
    // An excluded transaction can't carry a receipt: release it and look for another match.
    for (const id of await releaseReceiptsForTxnTx(tx, orgId, a, txnId))
      await matchForReceiptTx(tx, orgId, a, id);
  }
}

/**
 * Undo a categorization, match, or transfer: reverse the entry this transaction created (never
 * someone else's), unlink, and send the transaction(s) back to Categorize.
 */
export async function uncategorizeTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  txnId: string,
  input: { lock_override_note?: string | null } = {},
) {
  if (a.actor === "mcp" || a.proposeOnly) {
    // Undo posts a reversal without review, so only people and full API tokens may do it.
    throw forbidden("Undoing a categorization requires a person or a full-access API token.");
  }
  const t = await mustGetBankTxn(tx, txnId);
  if (t.status === "new" && !t.reviewItemId) throw conflict("Nothing to undo.", "invalid_state");
  if (t.status === "excluded") return excludeTx(tx, orgId, a, txnId, false);
  const linked = t.matchedEntryId
    ? await tx
        .select()
        .from(org.bankTransactions)
        .where(eq(org.bankTransactions.matchedEntryId, t.matchedEntryId))
        .all()
    : [t];
  if (t.status !== "matched" && t.matchedEntryId) {
    const e = await mustGetEntry(tx, t.matchedEntryId);
    const createdHere =
      (e.source_type === "bank_transaction" || e.source_type === "transfer") &&
      linked.some((x) => x.id === e.source_id);
    if (createdHere) {
      if (e.status === "posted") {
        if (!e.reversed_by_entry_id) {
          const rev = await reverseEntryTx(
            tx,
            orgId,
            a,
            e.id,
            { lockOverrideNote: input.lock_override_note ?? null },
            { forcePost: true },
          );
          if (rev.entry.status !== "posted")
            throw conflict("The reversal could not be posted.", "invalid_state");
        }
      } else if (e.status === "pending_review") {
        await rejectEntryTx(tx, orgId, a, e.id, "Categorization undone");
        if (t.reviewItemId) {
          await tx
            .update(org.reviewItems)
            .set({
              status: "rejected",
              decidedBy: a.userId,
              decidedAt: new Date().toISOString(),
              decisionNote: "Undone from Categorize",
            })
            .where(eq(org.reviewItems.id, t.reviewItemId));
        }
      }
    }
  }
  const ids = t.status === "matched" ? [t.id] : linked.map((x) => x.id);
  await tx
    .update(org.bankTransactions)
    .set({ status: "new", matchedEntryId: null, reviewItemId: null, ruleId: null })
    .where(inArray(org.bankTransactions.id, ids));
  await tx
    .update(org.providerPayouts)
    .set({ bankTxnId: null, entryId: null })
    .where(inArray(org.providerPayouts.bankTxnId, ids));
  await appendAudit(tx, orgId, a, {
    action: "bank_transaction.undo",
    targetType: "bank_transaction",
    targetId: txnId,
    before: { status: t.status, entry_id: t.matchedEntryId },
  });
}

// ----------------------------------------------------------------------------- rules & suggestions

export type RuleRow = typeof org.rules.$inferSelect;

export function ruleDef(r: RuleRow): RuleDef {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    isActive: r.isActive,
    conditions: JSON.parse(r.conditionsJson) as RuleConditions,
    actions: JSON.parse(r.actionsJson) as RuleActions,
  };
}

/** Most recent posted categorization of the same normalized description, as a suggestion. */
export async function historySuggestion(tx: Reader, t: BankTxnRow): Promise<Suggestion | null> {
  const prev = await tx
    .select({
      entryId: org.bankTransactions.matchedEntryId,
      bankAccountId: org.bankTransactions.bankAccountId,
    })
    .from(org.bankTransactions)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.bankTransactions.matchedEntryId))
    .where(
      and(
        eq(org.bankTransactions.normalizedDescription, t.normalizedDescription),
        eq(org.bankTransactions.status, "categorized"),
        eq(org.journalEntries.status, "posted"),
        isNull(org.journalEntries.reversedByEntryId),
        ne(org.bankTransactions.id, t.id),
      ),
    )
    .orderBy(desc(org.bankTransactions.date))
    .limit(1)
    .get();
  if (!prev?.entryId) return null;
  const e = await mustGetEntry(tx, prev.entryId);
  const bank = await mustGetBankAccount(tx, prev.bankAccountId);
  const others = e.lines.filter((l) => l.account_id !== bank.ledgerAccountId);
  if (others.length !== 1) return null;
  const line = others[0]!;
  return e.source_type === "transfer"
    ? { source: "history", transfer_account_id: line.account_id }
    : { source: "history", account_id: line.account_id, contact_id: line.contact_id, memo: e.memo };
}

/**
 * Apply rules to new transactions (SPEC §7.3). Auto-post rules go through the review policy as the
 * `rule` actor; suggest-only rules become review queue proposals; with no rule, fall back to a
 * receipt, payout, or history-based suggestion shown in Categorize. Never throws for one bad
 * transaction.
 *
 * Receipts are matched first (forward matching, audited as `auditActor`), so a rule that
 * categorizes the transaction confirms a suggested receipt and links its file to the entry. A rule
 * keeps its category; when it has no memo, the receipt's memo fills it.
 */
export async function applyRulesTx(
  tx: OrgTx,
  orgId: string,
  txnIds: string[],
  auditActor: ActorInfo = SYSTEM_ACTOR,
) {
  if (!txnIds.length) return { applied: 0, posted: 0, proposed: 0, suggested: 0 };
  const rules = (await tx.select().from(org.rules).where(eq(org.rules.isActive, true)).all()).map((r) => ({
    row: r,
    ...ruleDef(r),
  }));
  const txns = await tx
    .select()
    .from(org.bankTransactions)
    .where(inArray(org.bankTransactions.id, txnIds))
    .all();
  const s = await settingsRow(tx);
  const accts = await accountMap(tx);
  const out = { applied: 0, posted: 0, proposed: 0, suggested: 0 };
  for (const t of txns.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (t.status !== "new" || t.reviewItemId || t.isPending) continue;
    const fromReceipt = await matchForTxnTx(tx, orgId, auditActor, t);
    const rule = firstMatchingRule(rules, {
      bankAccountId: t.bankAccountId,
      amount: t.amount,
      description: t.description,
      payee: t.payee,
    });
    if (!rule) {
      const sug = fromReceipt ?? (await payoutSuggestion(tx, t)) ?? (await historySuggestion(tx, t));
      if (sug) {
        await tx
          .update(org.bankTransactions)
          .set({ suggestionJson: JSON.stringify(sug) })
          .where(eq(org.bankTransactions.id, t.id));
        out.suggested++;
      }
      continue;
    }
    const act = rule.actions;
    const memo = act.memo ?? fromReceipt?.memo ?? null;
    const suggestion: Suggestion = {
      source: "rule",
      account_id: act.account_id ?? null,
      transfer_account_id: act.transfer_account_id ?? null,
      contact_id: act.contact_id ?? null,
      memo,
      rule_id: rule.id,
      rule_name: rule.name,
      ...(fromReceipt ? { receipt_id: fromReceipt.receipt_id ?? null } : {}),
    };
    await tx
      .update(org.bankTransactions)
      .set({ suggestionJson: JSON.stringify(suggestion), ruleId: rule.id })
      .where(eq(org.bankTransactions.id, t.id));
    await tx
      .update(org.rules)
      .set({ timesApplied: sql`${org.rules.timesApplied} + 1` })
      .where(eq(org.rules.id, rule.id));
    out.applied++;
    const target = act.transfer_account_id ?? act.account_id;
    if (!target) continue;
    // Pre-flight the checks that would abort the import transaction: locks and account validity.
    const lock = checkLock(t.date, s, { actor: "rule", role: RULE_ACTOR.role });
    const bank = await mustGetBankAccount(tx, t.bankAccountId);
    const lineErrors = validateLines(
      [
        { accountId: bank.ledgerAccountId, amount: t.amount },
        { accountId: target, amount: -t.amount },
      ],
      accts,
      s.baseCurrency,
    );
    if (!lock.ok || lineErrors.length || target === bank.ledgerAccountId) continue;
    const opts = { ruleId: rule.id, ruleAutoPost: Boolean(act.auto_post) };
    const r = act.transfer_account_id
      ? await transferTx(
          tx,
          orgId,
          RULE_ACTOR,
          t.id,
          { account_id: act.transfer_account_id, memo: act.memo ?? null },
          opts,
        )
      : await categorizeTx(
          tx,
          orgId,
          RULE_ACTOR,
          t.id,
          {
            splits: [{ account_id: act.account_id!, amount: Math.abs(t.amount) }],
            memo,
            contact_id: act.contact_id ?? null,
            rationale: `Rule: ${rule.name}`,
          },
          opts,
        );
    if (r.entry.status === "posted") out.posted++;
    else out.proposed++;
  }
  return out;
}

// ----------------------------------------------------------------------------- provider payouts

/** A deposit shows up from a day before the payout's arrival date to three days after it. */
const PAYOUT_EARLY_DAYS = 1;
const PAYOUT_LATE_DAYS = 3;

/** A payout already suggested for another transaction still to categorize. */
const payoutSuggestedElsewhere = (txnId: string) =>
  sql`exists (select 1 from bank_transactions b where b.status = 'new' and b.id <> ${txnId} and json_extract(b.suggestion_json, '$.payout_id') = ${org.providerPayouts.payoutId})`;

function payoutSuggestionFor(p: typeof org.providerPayouts.$inferSelect, clearing: string): Suggestion {
  return {
    source: "payout",
    transfer_account_id: clearing,
    memo: `Stripe payout ${p.arrivalDate}`,
    payout_id: p.payoutId,
    payout_arrival_date: p.arrivalDate,
  };
}

/**
 * A deposit that matches a paid payout not yet linked to a bank transaction: same amount, arriving
 * within the window. Suggests a transfer from the clearing account; nothing posts until accepted.
 */
export async function payoutSuggestion(tx: Reader, t: BankTxnRow): Promise<Suggestion | null> {
  if (t.amount <= 0) return null;
  const clearing = (await settingsRow(tx)).paymentClearingAccountId;
  if (!clearing) return null;
  const rows = await tx
    .select()
    .from(org.providerPayouts)
    .where(
      and(
        eq(org.providerPayouts.amount, t.amount),
        eq(org.providerPayouts.status, "paid"),
        isNull(org.providerPayouts.bankTxnId),
        gte(org.providerPayouts.arrivalDate, addDays(t.date, -PAYOUT_LATE_DAYS)),
        lte(org.providerPayouts.arrivalDate, addDays(t.date, PAYOUT_EARLY_DAYS)),
        sql`not ${payoutSuggestedElsewhere(t.id)}`,
      ),
    )
    .all();
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(t.date));
  const best = rows.sort((x, y) => dist(x.arrivalDate) - dist(y.arrivalDate))[0];
  return best ? payoutSuggestionFor(best, clearing) : null;
}

/**
 * A payout that arrived after its deposit was imported: suggest it on the closest matching
 * transaction still to categorize that no rule has claimed. Returns the transaction, or null.
 */
export async function suggestPayoutMatchesTx(tx: OrgTx, payoutId: string): Promise<string | null> {
  const p = await tx
    .select()
    .from(org.providerPayouts)
    .where(eq(org.providerPayouts.payoutId, payoutId))
    .get();
  const clearing = (await settingsRow(tx)).paymentClearingAccountId;
  if (!p || !clearing || p.status !== "paid" || p.bankTxnId || p.amount <= 0) return null;
  const already = await tx
    .select({ id: org.bankTransactions.id })
    .from(org.bankTransactions)
    .where(
      and(
        eq(org.bankTransactions.status, "new"),
        sql`json_extract(${org.bankTransactions.suggestionJson}, '$.payout_id') = ${p.payoutId}`,
      ),
    )
    .get();
  if (already) return already.id;
  const rows = await tx
    .select()
    .from(org.bankTransactions)
    .where(
      and(
        eq(org.bankTransactions.status, "new"),
        eq(org.bankTransactions.amount, p.amount),
        eq(org.bankTransactions.isPending, false),
        isNull(org.bankTransactions.reviewItemId),
        isNull(org.bankTransactions.matchedEntryId),
        gte(org.bankTransactions.date, addDays(p.arrivalDate, -PAYOUT_EARLY_DAYS)),
        lte(org.bankTransactions.date, addDays(p.arrivalDate, PAYOUT_LATE_DAYS)),
        sql`(${org.bankTransactions.suggestionJson} is null or json_extract(${org.bankTransactions.suggestionJson}, '$.source') = 'history')`,
      ),
    )
    .all();
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(p.arrivalDate));
  const best = rows.sort((x, y) => dist(x.date) - dist(y.date) || x.id.localeCompare(y.id))[0];
  if (!best) return null;
  await tx
    .update(org.bankTransactions)
    .set({ suggestionJson: JSON.stringify(payoutSuggestionFor(p, clearing)) })
    .where(eq(org.bankTransactions.id, best.id));
  return best.id;
}

/**
 * The owner accepted a payout suggestion as a transfer: link the payout to the deposit and its
 * entry, when the transfer came from the clearing account for the payout's amount.
 */
async function linkPayoutTx(tx: OrgTx, payoutId: string, t: BankTxnRow, accountId: string, entryId: string) {
  if (accountId !== (await settingsRow(tx)).paymentClearingAccountId) return;
  await tx
    .update(org.providerPayouts)
    .set({ bankTxnId: t.id, entryId })
    .where(
      and(
        eq(org.providerPayouts.payoutId, payoutId),
        eq(org.providerPayouts.amount, t.amount),
        isNull(org.providerPayouts.bankTxnId),
      ),
    );
}

/** Auto-link newly imported transactions to transfer entries already recorded from the other side. */
export async function pairImportedTransfersTx(tx: OrgTx, orgId: string, txnIds: string[]) {
  let paired = 0;
  for (const id of txnIds) {
    const t = await mustGetBankTxn(tx, id);
    if (t.status !== "new" || t.isPending) continue;
    const bank = await mustGetBankAccount(tx, t.bankAccountId);
    const hit = await tx
      .select({ id: org.journalEntries.id })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          eq(org.journalLines.accountId, bank.ledgerAccountId),
          eq(org.journalLines.amount, t.amount),
          eq(org.journalEntries.sourceType, "transfer"),
          inArray(org.journalEntries.status, ["posted", "pending_review"]),
          isNull(org.journalEntries.reversedByEntryId),
          gte(org.journalEntries.date, addDays(t.date, -TRANSFER_WINDOW_DAYS)),
          lte(org.journalEntries.date, addDays(t.date, TRANSFER_WINDOW_DAYS)),
          sql`not exists (select 1 from bank_transactions b where b.matched_entry_id = ${org.journalEntries.id} and b.bank_account_id = ${t.bankAccountId})`,
        ),
      )
      .orderBy(asc(org.journalEntries.date))
      .limit(1)
      .get();
    if (!hit) continue;
    const e = await mustGetEntry(tx, hit.id);
    const pending = e.status === "pending_review";
    const other = await tx
      .select({ reviewItemId: org.bankTransactions.reviewItemId })
      .from(org.bankTransactions)
      .where(eq(org.bankTransactions.matchedEntryId, hit.id))
      .get();
    await tx
      .update(org.bankTransactions)
      .set({
        status: pending ? "new" : "categorized",
        matchedEntryId: hit.id,
        reviewItemId: pending ? (other?.reviewItemId ?? null) : null,
      })
      .where(eq(org.bankTransactions.id, t.id));
    await appendAudit(tx, orgId, RULE_ACTOR, {
      action: "bank_transaction.pair_transfer",
      targetType: "bank_transaction",
      targetId: t.id,
      after: { entry_id: hit.id },
    });
    paired++;
  }
  return paired;
}
