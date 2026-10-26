/**
 * The posting pipeline (SPEC §6, §7.5). Every journal entry, whatever its source, is created here:
 * validated, run through the review policy, and either posted (extending the ledger chain) or held
 * in the review queue. All `*Tx` functions MUST run inside the org write transaction.
 */
import {
  type AccountRef,
  checkLock,
  type Decision,
  decide,
  entryHash,
  type LineInput,
  type PolicyRule,
  type Proposal,
  reversalLines,
  validateLines,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import type { AccountType, SourceType } from "@cosimo/shared";
import { and, asc, desc, eq, gte, inArray, like, lte, or, type SQL, sql } from "drizzle-orm";
import { ApiError, conflict, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { linkAttachmentTx } from "./attachments.ts";
import { appendAudit } from "./audit.ts";
import { checkpoint, ledgerHead } from "./chain.ts";

type Reader = OrgDb | OrgTx;
type EntryRow = typeof org.journalEntries.$inferSelect;
type LineRow = typeof org.journalLines.$inferSelect;

/** Entries created by documents; only the document flows may reverse them (SPEC §6 #8). */
export const DOCUMENT_SOURCES: SourceType[] = ["invoice", "invoice_payment", "bill", "bill_payment"];

export interface EntryInput {
  date: string;
  memo?: string | null;
  lines: LineInput[];
  sourceType?: SourceType;
  sourceId?: string | null;
  reversesEntryId?: string | null;
  /** Required from owners posting into a soft-locked period. */
  lockOverrideNote?: string | null;
  /** Proposer's explanation, shown in the review queue. */
  rationale?: string | null;
}

export interface SubmitOptions {
  itemType?: Proposal["itemType"];
  ruleAutoPost?: boolean;
  accountUsedForPayee?: boolean;
  /** Skip the policy engine and post (document flows already decided, internal system entries). */
  forcePost?: boolean;
  /** Extra context stored with a review item (e.g. the bank transaction being categorized). */
  reviewContext?: Record<string, unknown>;
  /**
   * Hold for review with this reason whatever the policy says (e.g. a provider payment that doesn't
   * match an open invoice). Ignored with `forcePost`.
   */
  requireReview?: string;
}

export interface EntryView {
  id: string;
  date: string;
  memo: string | null;
  status: EntryRow["status"];
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  created_by: string | null;
  created_by_actor: string;
  created_at: string;
  posted_at: string | null;
  posted_by: string | null;
  lock_override_note: string | null;
  chain_seq: number | null;
  entry_hash: string | null;
  total: number;
  /** Set only by the single-entry fetch; list views leave this null to avoid a query per row. */
  recurring_template_id: string | null;
  lines: {
    id: string;
    account_id: string;
    amount: number;
    currency: string;
    description: string | null;
    contact_id: string | null;
    line_order: number;
  }[];
}

export interface SubmitResult {
  entry: EntryView;
  decision: Decision | null;
  reviewItemId: string | null;
}

export function entryView(e: EntryRow, lines: LineRow[]): EntryView {
  const sorted = [...lines].sort((a, b) => a.lineOrder - b.lineOrder || a.id.localeCompare(b.id));
  return {
    id: e.id,
    date: e.date,
    memo: e.memo,
    status: e.status,
    source_type: e.sourceType,
    source_id: e.sourceId,
    reverses_entry_id: e.reversesEntryId,
    reversed_by_entry_id: e.reversedByEntryId,
    created_by: e.createdBy,
    created_by_actor: e.createdByActor,
    created_at: e.createdAt,
    posted_at: e.postedAt,
    posted_by: e.postedBy,
    lock_override_note: e.lockOverrideNote,
    chain_seq: e.chainSeq,
    entry_hash: e.entryHash,
    total: debitTotal(sorted),
    recurring_template_id: null,
    lines: sorted.map((l) => ({
      id: l.id,
      account_id: l.accountId,
      amount: l.amount,
      currency: l.currency,
      description: l.description,
      contact_id: l.contactId,
      line_order: l.lineOrder,
    })),
  };
}

export function debitTotal(lines: { amount: number }[]): number {
  let s = 0;
  for (const l of lines) if (l.amount > 0) s += l.amount;
  return s;
}

// ----------------------------------------------------------------------------- document hooks

type EntryHook = (tx: OrgTx, orgId: string, entry: EntryView, a: ActorInfo) => Promise<void>;
const postHooks = new Map<string, EntryHook[]>();
const rejectHooks = new Map<string, EntryHook[]>();

/**
 * Documents (invoices, bills, payments) react when their entry finally posts or is rejected, which
 * may happen later from the review queue rather than when the document was saved.
 */
export function onEntryPosted(sourceType: string, fn: EntryHook) {
  postHooks.set(sourceType, [...(postHooks.get(sourceType) ?? []), fn]);
}
export function onEntryRejected(sourceType: string, fn: EntryHook) {
  rejectHooks.set(sourceType, [...(rejectHooks.get(sourceType) ?? []), fn]);
}

const approvingHooks = new Map<string, EntryHook[]>();

/**
 * Runs when a person approves a pending entry from the review queue, right before it posts. A hook
 * may throw to refuse the approval. It does not run on auto-post paths.
 */
export function onEntryApproving(sourceType: string, fn: EntryHook) {
  approvingHooks.set(sourceType, [...(approvingHooks.get(sourceType) ?? []), fn]);
}
export async function runEntryApprovingHooks(tx: OrgTx, orgId: string, entry: EntryView, a: ActorInfo) {
  for (const fn of approvingHooks.get(entry.source_type) ?? []) await fn(tx, orgId, entry, a);
}

// ----------------------------------------------------------------------------- lookups

export async function settingsRow(db: Reader) {
  const s = await db.select().from(org.orgSettings).where(eq(org.orgSettings.id, 1)).get();
  if (!s) throw new Error("org settings missing");
  return s;
}

export async function accountMap(db: Reader): Promise<Map<string, AccountRef & { type: AccountType }>> {
  const rows = await db
    .select({
      id: org.accounts.id,
      type: org.accounts.type,
      isActive: org.accounts.isActive,
      currency: org.accounts.currency,
    })
    .from(org.accounts)
    .all();
  return new Map(rows.map((r) => [r.id, r]));
}

export async function systemAccountId(db: Reader, key: string): Promise<string> {
  const a = await db
    .select({ id: org.accounts.id })
    .from(org.accounts)
    .where(eq(org.accounts.systemKey, key))
    .get();
  if (!a) throw new Error(`system account ${key} missing`);
  return a.id;
}

export async function policyRules(db: Reader): Promise<PolicyRule[]> {
  const rows = await db.select().from(org.reviewPolicy).all();
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor as PolicyRule["actor"],
    condition: JSON.parse(r.conditionJson || "{}"),
    action: r.action,
    priority: r.priority,
  }));
}

export async function getEntry(db: Reader, id: string): Promise<EntryView | null> {
  const e = await db.select().from(org.journalEntries).where(eq(org.journalEntries.id, id)).get();
  if (!e) return null;
  const lines = await db.select().from(org.journalLines).where(eq(org.journalLines.entryId, id)).all();
  return entryView(e, lines);
}

export async function mustGetEntry(db: Reader, id: string): Promise<EntryView> {
  const e = await getEntry(db, id);
  if (!e) throw notFound("Journal entry");
  return e;
}

export interface EntryFilter {
  status?: EntryRow["status"][];
  from?: string;
  to?: string;
  accountId?: string;
  sourceType?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

/** Newest first by date, then id. Cursor is the last seen `date|id`. */
export async function listEntries(db: Reader, f: EntryFilter) {
  const conds: SQL[] = [];
  const je = org.journalEntries;
  if (f.status?.length) conds.push(inArray(je.status, f.status));
  if (f.from) conds.push(gte(je.date, f.from));
  if (f.to) conds.push(lte(je.date, f.to));
  if (f.sourceType) conds.push(eq(je.sourceType, f.sourceType));
  if (f.q) conds.push(like(je.memo, `%${f.q.replace(/[%_]/g, "")}%`));
  if (f.accountId) {
    conds.push(
      sql`exists (select 1 from journal_lines l where l.entry_id = ${je.id} and l.account_id = ${f.accountId})`,
    );
  }
  if (f.cursor) {
    const [d, id] = f.cursor.split("|");
    if (d && id) conds.push(or(sql`${je.date} < ${d}`, and(eq(je.date, d), sql`${je.id} < ${id}`))!);
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const rows = await db
    .select()
    .from(je)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(je.date), desc(je.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  const lines = ids.length
    ? await db.select().from(org.journalLines).where(inArray(org.journalLines.entryId, ids)).all()
    : [];
  const byEntry = new Map<string, LineRow[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const last = page[page.length - 1];
  return {
    data: page.map((e) => entryView(e, byEntry.get(e.id) ?? [])),
    next_cursor: rows.length > limit && last ? `${last.date}|${last.id}` : null,
  };
}

// ----------------------------------------------------------------------------- validation

function ledgerError(errors: { code: string; message: string; line?: number }[]): ApiError {
  const first = errors[0]!;
  return unprocessable(first.message, first.code, { errors });
}

export async function validateForSave(tx: Reader, lines: LineInput[], forPosting: boolean) {
  const s = await settingsRow(tx);
  const errors = validateLines(lines, await accountMap(tx), s.baseCurrency, { forPosting });
  if (errors.length) throw ledgerError(errors);
  return s;
}

function lockError(code: string, message: string) {
  return unprocessable(message, code);
}

async function insertLines(tx: OrgTx, entryId: string, lines: LineInput[], currency: string) {
  if (!lines.length) return;
  await tx.insert(org.journalLines).values(
    lines.map((l, i) => ({
      id: newId(),
      entryId,
      accountId: l.accountId,
      amount: l.amount,
      currency,
      description: l.description ?? null,
      contactId: l.contactId ?? null,
      lineOrder: i,
    })),
  );
}

// ----------------------------------------------------------------------------- create / submit

/** Insert an entry as a draft. Drafts need not balance; they never affect balances. */
export async function createDraftTx(tx: OrgTx, orgId: string, a: ActorInfo, input: EntryInput) {
  const s = await validateForSave(tx, input.lines, false);
  const id = newId();
  await tx.insert(org.journalEntries).values({
    id,
    date: input.date,
    memo: input.memo ?? null,
    status: "draft",
    sourceType: input.sourceType ?? "manual",
    sourceId: input.sourceId ?? null,
    reversesEntryId: input.reversesEntryId ?? null,
    createdBy: a.userId,
    createdByActor: a.actor,
    lockOverrideNote: input.lockOverrideNote ?? null,
  });
  await insertLines(tx, id, input.lines, s.baseCurrency);
  await appendAudit(tx, orgId, a, {
    action: "entry.create",
    targetType: "journal_entry",
    targetId: id,
    after: await getEntry(tx, id),
  });
  return id;
}

/**
 * Create and submit an entry: validate, decide through the review policy, then post it or hold it
 * for review. The main entry point for every writer (UI, API, rules, MCP, documents).
 */
export async function submitEntryTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: EntryInput,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  await validateForSave(tx, input.lines, true);
  const id = await createDraftTx(tx, orgId, a, input);
  return submitDraftTx(tx, orgId, a, id, { ...opts, rationale: input.rationale ?? null });
}

/** Move an existing draft through the review policy. */
export async function submitDraftTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  opts: SubmitOptions & { rationale?: string | null } = {},
): Promise<SubmitResult> {
  const e = await mustGetEntry(tx, entryId);
  if (e.status !== "draft") throw conflict(`Entry is ${e.status}, not a draft.`, "invalid_state");
  await validateForSave(
    tx,
    e.lines.map((l) => ({ accountId: l.account_id, amount: l.amount })),
    true,
  );
  if (e.reverses_entry_id) await assertReversible(tx, e.reverses_entry_id, entryId);

  if (opts.forcePost) {
    const posted = await postEntryTx(tx, orgId, entryId, a, e.lock_override_note);
    return { entry: posted, decision: null, reviewItemId: null };
  }
  const s = await settingsRow(tx);
  let decision = decide(
    {
      actor: a.actor,
      itemType: opts.itemType ?? "journal_entry",
      amount: e.total,
      proposeOnly: a.proposeOnly,
      ruleAutoPost: opts.ruleAutoPost,
      accountUsedForPayee: opts.accountUsedForPayee,
    },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (opts.requireReview) {
    decision = { action: "require_review", reason: opts.requireReview, ruleId: null };
  }
  if (decision.action === "auto_approve") {
    // Lock dates are checked before posting so the caller gets a clear message; the trigger
    // enforces the same rule.
    const posted = await postEntryTx(tx, orgId, entryId, a, e.lock_override_note);
    return { entry: posted, decision, reviewItemId: null };
  }
  const reviewItemId = await holdForReviewTx(tx, orgId, a, e, decision.reason, opts.rationale ?? null, {
    itemType: opts.itemType === "bank_categorization" ? "bank_categorization" : "journal_entry",
    context: opts.reviewContext,
  });
  return { entry: (await getEntry(tx, entryId))!, decision, reviewItemId };
}

async function holdForReviewTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  e: EntryView,
  reason: string,
  rationale: string | null,
  item: { itemType: "journal_entry" | "bank_categorization"; context?: Record<string, unknown> },
) {
  await tx
    .update(org.journalEntries)
    .set({ status: "pending_review" })
    .where(eq(org.journalEntries.id, e.id));
  const reviewId = newId();
  const payload = JSON.stringify({ entry: { ...e, status: "pending_review" }, ...(item.context ?? {}) });
  await tx.insert(org.reviewItems).values({
    id: reviewId,
    itemType: item.itemType,
    itemId: e.id,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason,
    rationale,
    payloadJson: payload,
    originalPayloadJson: payload,
    amount: e.total,
  });
  await appendAudit(tx, orgId, a, {
    action: "entry.propose",
    targetType: "journal_entry",
    targetId: e.id,
    after: { review_item_id: reviewId, reason, rationale },
  });
  return reviewId;
}

/** Throws unless the entry is posted, not reversed, and has no other live reversal. */
export async function assertReversible(tx: Reader, originalId: string, reversalId: string | null) {
  const orig = await tx.select().from(org.journalEntries).where(eq(org.journalEntries.id, originalId)).get();
  if (!orig) throw notFound("Entry to reverse");
  if (orig.status !== "posted") throw conflict("Only posted entries can be reversed.", "invalid_state");
  if (orig.reversedByEntryId) throw conflict("This entry has already been reversed.", "already_reversed");
  const other = await tx
    .select({ id: org.journalEntries.id })
    .from(org.journalEntries)
    .where(
      and(
        eq(org.journalEntries.reversesEntryId, originalId),
        inArray(org.journalEntries.status, ["draft", "pending_review", "posted"]),
      ),
    )
    .all();
  if (other.some((o) => o.id !== reversalId)) {
    throw conflict("A reversal of this entry is already pending.", "already_reversed");
  }
  return orig;
}

/**
 * Post a draft or pending entry: check locks, stamp chain fields and extend the ledger chain.
 * `poster` is whoever causes the post (the proposer on auto-approve, the approver on review).
 */
export async function postEntryTx(
  tx: OrgTx,
  orgId: string,
  entryId: string,
  poster: ActorInfo,
  note?: string | null,
): Promise<EntryView> {
  const e = await tx.select().from(org.journalEntries).where(eq(org.journalEntries.id, entryId)).get();
  if (!e) throw notFound("Journal entry");
  if (e.status === "posted") throw conflict("Entry is already posted.", "invalid_state");
  if (e.status === "rejected") throw conflict("Rejected entries cannot be posted.", "invalid_state");
  const s = await settingsRow(tx);
  const lock = checkLock(e.date, s, { actor: poster.actor, role: poster.role }, note);
  if (!lock.ok) throw lockError(lock.code, lock.message);
  const lines = await tx.select().from(org.journalLines).where(eq(org.journalLines.entryId, entryId)).all();
  const errors = validateLines(
    lines.map((l) => ({ accountId: l.accountId, amount: l.amount })),
    await accountMap(tx),
    s.baseCurrency,
  );
  if (errors.length) throw ledgerError(errors);
  if (e.reversesEntryId) await assertReversible(tx, e.reversesEntryId, entryId);

  const head = await ledgerHead(tx, orgId);
  const postedAt = new Date().toISOString();
  const lockOverrideNote = lock.overridesSoftLock ? note!.trim() : null;
  const chainSeq = head.seq + 1;
  const hash = entryHash(orgId, head.hash, {
    id: e.id,
    chainSeq,
    date: e.date,
    memo: e.memo,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    reversesEntryId: e.reversesEntryId,
    createdBy: e.createdBy,
    createdByActor: e.createdByActor,
    postedAt,
    postedBy: poster.userId,
    lockOverrideNote,
    lines: lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      amount: l.amount,
      currency: l.currency,
      description: l.description,
      contactId: l.contactId,
      lineOrder: l.lineOrder,
    })),
  });

  await tx.delete(org.postingContext);
  await tx
    .insert(org.postingContext)
    .values({ id: 1, actor: poster.actor, role: poster.role, note: lockOverrideNote });
  await tx
    .update(org.journalEntries)
    .set({
      status: "posted",
      postedAt,
      postedBy: poster.userId,
      lockOverrideNote,
      chainSeq,
      prevHash: head.hash,
      entryHash: hash,
    })
    .where(eq(org.journalEntries.id, entryId));
  await tx.delete(org.postingContext);

  if (e.reversesEntryId) {
    await tx
      .update(org.journalEntries)
      .set({ reversedByEntryId: e.id })
      .where(eq(org.journalEntries.id, e.reversesEntryId));
  }
  const view = (await getEntry(tx, entryId))!;
  for (const h of postHooks.get(e.sourceType) ?? []) await h(tx, orgId, view, poster);
  await appendAudit(tx, orgId, poster, {
    action: e.reversesEntryId ? "entry.reverse" : "entry.post",
    targetType: "journal_entry",
    targetId: entryId,
    after: {
      chain_seq: chainSeq,
      entry_hash: hash,
      lock_override_note: lockOverrideNote,
      reverses: e.reversesEntryId,
    },
  });
  return view;
}

/** Reject a pending entry. Rejected entries never post (SPEC §6 #12). */
export async function rejectEntryTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  note: string | null,
) {
  const e = await mustGetEntry(tx, entryId);
  if (e.status !== "pending_review" && e.status !== "draft") {
    throw conflict(`Entry is ${e.status}; only drafts and pending entries can be rejected.`, "invalid_state");
  }
  await tx.update(org.journalEntries).set({ status: "rejected" }).where(eq(org.journalEntries.id, entryId));
  const rejected = (await getEntry(tx, entryId))!;
  for (const h of rejectHooks.get(e.source_type) ?? []) await h(tx, orgId, rejected, a);
  await appendAudit(tx, orgId, a, {
    action: "entry.reject",
    targetType: "journal_entry",
    targetId: entryId,
    after: { note },
  });
}

// ----------------------------------------------------------------------------- drafts

export async function updateDraftTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  input: Partial<Pick<EntryInput, "date" | "memo" | "lines" | "lockOverrideNote">>,
  opts: { allowPending?: boolean } = {},
) {
  const before = await mustGetEntry(tx, entryId);
  const editable = before.status === "draft" || (opts.allowPending && before.status === "pending_review");
  if (!editable) {
    throw conflict(
      before.status === "posted"
        ? "Posted entries cannot be edited. Use reverse and replace."
        : `Entry is ${before.status} and cannot be edited.`,
      "invalid_state",
    );
  }
  if (DOCUMENT_SOURCES.includes(before.source_type as SourceType)) {
    throw conflict("This entry belongs to a document; edit the document instead.", "document_entry");
  }
  const s = input.lines
    ? await validateForSave(tx, input.lines, before.status !== "draft")
    : await settingsRow(tx);
  const patch: Partial<typeof org.journalEntries.$inferInsert> = {};
  if (input.date !== undefined) patch.date = input.date;
  if (input.memo !== undefined) patch.memo = input.memo;
  if (input.lockOverrideNote !== undefined) patch.lockOverrideNote = input.lockOverrideNote;
  if (Object.keys(patch).length) {
    await tx.update(org.journalEntries).set(patch).where(eq(org.journalEntries.id, entryId));
  }
  if (input.lines) {
    await tx.delete(org.journalLines).where(eq(org.journalLines.entryId, entryId));
    await insertLines(tx, entryId, input.lines, s.baseCurrency);
  }
  const after = (await getEntry(tx, entryId))!;
  await appendAudit(tx, orgId, a, {
    action: "entry.update",
    targetType: "journal_entry",
    targetId: entryId,
    before,
    after,
  });
  return after;
}

export async function deleteDraftTx(tx: OrgTx, orgId: string, a: ActorInfo, entryId: string) {
  const before = await mustGetEntry(tx, entryId);
  if (before.status !== "draft") {
    throw conflict("Only drafts can be deleted. Posted entries are reversed.", "invalid_state");
  }
  await tx.delete(org.journalLines).where(eq(org.journalLines.entryId, entryId));
  await tx.delete(org.journalEntries).where(eq(org.journalEntries.id, entryId));
  await appendAudit(tx, orgId, a, {
    action: "entry.delete",
    targetType: "journal_entry",
    targetId: entryId,
    before,
  });
}

// ----------------------------------------------------------------------------- reverse / replace

export interface ReverseInput {
  date?: string;
  memo?: string | null;
  lockOverrideNote?: string | null;
  rationale?: string | null;
  /** Document flows may reverse their own entries. */
  allowDocument?: boolean;
}

/** Reverse a posted entry with a new entry whose lines are all negated (SPEC §6 #2). */
export async function reverseEntryTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  input: ReverseInput = {},
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const orig = await mustGetEntry(tx, entryId);
  await assertReversible(tx, entryId, null);
  if (!input.allowDocument && DOCUMENT_SOURCES.includes(orig.source_type as SourceType)) {
    throw conflict(
      "This entry was created by a document (invoice, bill, or payment). Void the document instead.",
      "document_entry",
    );
  }
  return submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: input.date ?? orig.date,
      memo: input.memo ?? `Reversal of ${orig.memo ?? `entry ${orig.chain_seq ?? orig.id}`}`,
      lines: reversalLines(
        orig.lines.map((l) => ({
          accountId: l.account_id,
          amount: l.amount,
          description: l.description,
          contactId: l.contact_id,
        })),
      ),
      sourceType: input.allowDocument ? (orig.source_type as SourceType) : "reversal",
      sourceId: input.allowDocument ? orig.source_id : orig.id,
      reversesEntryId: orig.id,
      lockOverrideNote: input.lockOverrideNote ?? null,
      rationale: input.rationale ?? null,
    },
    opts,
  );
}

/**
 * "Edit" of a posted entry: reverse it and post a corrected replacement, atomically. The
 * replacement takes the original's files (`keepAttachments`, on by default; the original keeps its
 * own links too, so the reversed history still shows its evidence), and receipts booked to the
 * original point at the replacement.
 */
export async function replaceEntryTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  replacement: EntryInput,
  opts: SubmitOptions & { keepAttachments?: boolean } = {},
) {
  const { keepAttachments = true, ...submitOpts } = opts;
  const reversal = await reverseEntryTx(
    tx,
    orgId,
    a,
    entryId,
    { lockOverrideNote: replacement.lockOverrideNote, rationale: replacement.rationale },
    submitOpts,
  );
  const next = await submitEntryTx(
    tx,
    orgId,
    a,
    { ...replacement, sourceType: replacement.sourceType ?? "manual" },
    submitOpts,
  );
  if (keepAttachments) {
    const links = await tx
      .select({ id: org.attachmentLinks.attachmentId })
      .from(org.attachmentLinks)
      .where(
        and(eq(org.attachmentLinks.targetType, "journal_entry"), eq(org.attachmentLinks.targetId, entryId)),
      )
      .all();
    for (const l of links)
      await linkAttachmentTx(tx, orgId, a, l.id, { type: "journal_entry", id: next.entry.id });
  }
  await repointReceiptsTx(tx, orgId, a, entryId, next.entry.id);
  return { reversal, replacement: next };
}

/**
 * Receipts booked to a replaced entry now point at its replacement. Done here rather than in
 * receipts.ts, which imports this module.
 */
async function repointReceiptsTx(tx: OrgTx, orgId: string, a: ActorInfo, fromId: string, toId: string) {
  const rows = await tx
    .select({ id: org.receipts.id })
    .from(org.receipts)
    .where(and(eq(org.receipts.bookedTargetType, "journal_entry"), eq(org.receipts.bookedTargetId, fromId)))
    .all();
  for (const r of rows) {
    await tx
      .update(org.receipts)
      .set({ bookedTargetId: toId, updatedAt: new Date().toISOString() })
      .where(eq(org.receipts.id, r.id));
    await appendAudit(tx, orgId, a, {
      action: "receipt.update",
      targetType: "receipt",
      targetId: r.id,
      before: { booked_target_id: fromId },
      after: { booked_target_id: toId, reason: "entry_replaced" },
    });
  }
}

// ----------------------------------------------------------------------------- lock dates

export async function setLockDatesTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: { softLockDate?: string | null; hardLockDate?: string | null },
) {
  if (a.role !== "owner" || a.actor === "mcp") {
    throw new ApiError(403, "forbidden", "Only owners can change lock dates.");
  }
  const before = await settingsRow(tx);
  const patch: Partial<typeof org.orgSettings.$inferInsert> = {};
  if (input.softLockDate !== undefined) patch.softLockDate = input.softLockDate;
  if (input.hardLockDate !== undefined) patch.hardLockDate = input.hardLockDate;
  const soft = patch.softLockDate !== undefined ? patch.softLockDate : before.softLockDate;
  const hard = patch.hardLockDate !== undefined ? patch.hardLockDate : before.hardLockDate;
  if (soft && hard && hard > soft) {
    throw unprocessable("The hard lock date cannot be later than the soft lock date.", "invalid_lock_dates");
  }
  if (!Object.keys(patch).length) return before;
  await tx.update(org.orgSettings).set(patch).where(eq(org.orgSettings.id, 1));
  const after = await settingsRow(tx);
  await appendAudit(tx, orgId, a, {
    action: "lock_dates.update",
    targetType: "org_settings",
    targetId: orgId,
    before: { soft_lock_date: before.softLockDate, hard_lock_date: before.hardLockDate },
    after: { soft_lock_date: after.softLockDate, hard_lock_date: after.hardLockDate },
  });
  await checkpoint(tx, orgId, "lock_date");
  return after;
}

// ----------------------------------------------------------------------------- opening balances

export interface OpeningBalanceInput {
  date: string;
  /** Raw (debit-positive) balances per account. The difference goes to Opening Balance Equity. */
  balances: { accountId: string; amount: number }[];
  memo?: string | null;
  lockOverrideNote?: string | null;
}

/** One opening_balance entry against Opening Balance Equity (SPEC §6.4). */
export async function openingBalancesTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: OpeningBalanceInput,
  opts: SubmitOptions = {},
) {
  const obe = await systemAccountId(tx, "opening_balance_equity");
  const lines: LineInput[] = input.balances
    .filter((b) => b.amount !== 0 && b.accountId !== obe)
    .map((b) => ({ accountId: b.accountId, amount: b.amount, description: "Opening balance" }));
  if (!lines.length) throw unprocessable("Enter at least one non-zero balance.", "empty");
  const accounts = await accountTypes(tx);
  for (const l of lines) {
    const t = accounts.get(l.accountId);
    if (t === "income" || t === "expense") {
      throw unprocessable(
        "Opening balances apply to balance sheet accounts. Enter prior income and expense as a journal entry.",
        "invalid_account",
      );
    }
  }
  const diff = lines.reduce((s, l) => s + l.amount, 0);
  if (diff !== 0) lines.push({ accountId: obe, amount: -diff, description: "Opening balance equity" });
  const result = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: input.date,
      memo: input.memo ?? `Opening balances as of ${input.date}`,
      lines,
      sourceType: "opening_balance",
      lockOverrideNote: input.lockOverrideNote ?? null,
    },
    opts,
  );
  const s = await settingsRow(tx);
  if (!s.booksStartDate || s.booksStartDate > input.date) {
    await tx.update(org.orgSettings).set({ booksStartDate: input.date }).where(eq(org.orgSettings.id, 1));
  }
  return result;
}

async function accountTypes(db: Reader) {
  const rows = await db.select({ id: org.accounts.id, type: org.accounts.type }).from(org.accounts).all();
  return new Map(rows.map((r) => [r.id, r.type]));
}

// ----------------------------------------------------------------------------- balances

/** Raw (debit-positive) posted balances per account for dates in [from, to]. */
export async function balances(db: Reader, range: { from?: string | null; to?: string | null } = {}) {
  const conds: SQL[] = [eq(org.journalEntries.status, "posted")];
  if (range.from) conds.push(gte(org.journalEntries.date, range.from));
  if (range.to) conds.push(lte(org.journalEntries.date, range.to));
  const rows = await db
    .select({ accountId: org.journalLines.accountId, total: sql<number>`sum(${org.journalLines.amount})` })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(and(...conds))
    .groupBy(org.journalLines.accountId)
    .all();
  return new Map(rows.map((r) => [r.accountId, Number(r.total)]));
}

/** Posted lines (with entry fields) for the general ledger. */
export async function postedLines(
  db: Reader,
  range: { from?: string | null; to?: string | null; accountIds?: string[] },
) {
  const conds: SQL[] = [eq(org.journalEntries.status, "posted")];
  if (range.from) conds.push(gte(org.journalEntries.date, range.from));
  if (range.to) conds.push(lte(org.journalEntries.date, range.to));
  if (range.accountIds?.length) conds.push(inArray(org.journalLines.accountId, range.accountIds));
  return db
    .select({
      accountId: org.journalLines.accountId,
      entryId: org.journalEntries.id,
      lineId: org.journalLines.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      description: org.journalLines.description,
      sourceType: org.journalEntries.sourceType,
      amount: org.journalLines.amount,
      chainSeq: org.journalEntries.chainSeq,
      contactId: org.journalLines.contactId,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(and(...conds))
    .orderBy(asc(org.journalEntries.date), asc(org.journalEntries.chainSeq))
    .all();
}
