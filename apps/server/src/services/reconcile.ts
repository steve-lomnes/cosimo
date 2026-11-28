/**
 * Reconciliation (SPEC §7.4). Balances are in the account's normal sign as shown on the statement:
 * money in the bank for asset accounts, amount owed for credit cards (liabilities).
 */
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import type { Actor } from "@cosimo/shared";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import { renderReportPdf } from "../pdf/index.ts";
import type { ActorInfo } from "./actor.ts";
import { listAttachments } from "./attachments.ts";
import { appendAudit } from "./audit.ts";
import { csvCell } from "./reports.ts";

type Reader = OrgDb | OrgTx;
type ReconRow = typeof org.reconciliations.$inferSelect;

async function ledgerAccount(db: Reader, id: string) {
  const a = await db.select().from(org.accounts).where(eq(org.accounts.id, id)).get();
  if (!a) throw notFound("Account");
  if (a.type !== "asset" && a.type !== "liability") {
    throw unprocessable(
      "Only bank, card, and other balance sheet accounts can be reconciled.",
      "invalid_account",
    );
  }
  return a;
}

const signFor = (type: string) => (type === "asset" ? 1 : -1);

export async function mustGetRecon(db: Reader, id: string) {
  const r = await db.select().from(org.reconciliations).where(eq(org.reconciliations.id, id)).get();
  if (!r) throw notFound("Reconciliation");
  return r;
}

/** Line ids cleared by completed reconciliations of this account. */
async function clearedElsewhere(db: Reader, accountId: string, exceptRecon?: string) {
  const rows = await db
    .select({ lineId: org.reconciliationItems.journalLineId })
    .from(org.reconciliationItems)
    .innerJoin(org.reconciliations, eq(org.reconciliations.id, org.reconciliationItems.reconciliationId))
    .where(
      and(
        eq(org.reconciliations.bankAccountId, accountId),
        eq(org.reconciliations.status, "completed"),
        exceptRecon ? ne(org.reconciliations.id, exceptRecon) : undefined,
      ),
    )
    .all();
  return new Set(rows.map((r) => r.lineId));
}

export function reconView(r: ReconRow) {
  return {
    id: r.id,
    account_id: r.bankAccountId,
    statement_end_date: r.statementEndDate,
    statement_ending_balance: r.statementEndingBalance,
    beginning_balance: r.beginningBalance,
    cleared_balance: r.clearedBalance,
    difference: r.statementEndingBalance - r.clearedBalance,
    status: r.status,
    created_at: r.createdAt,
    completed_at: r.completedAt,
    undone_at: r.undoneAt,
  };
}

/** The page of a reconciliation in the web app, where a person uploads the statement and completes it. */
export function reconcileUrl(publicUrl: string, orgId: string, id: string) {
  return `${publicUrl.replace(/\/$/, "")}/o/${orgId}/banking/reconcile/${id}`;
}

export async function listRecons(db: Reader, accountId?: string) {
  const rows = await db
    .select()
    .from(org.reconciliations)
    .where(accountId ? eq(org.reconciliations.bankAccountId, accountId) : undefined)
    .orderBy(desc(org.reconciliations.statementEndDate), desc(org.reconciliations.createdAt))
    .all();
  const files = await db
    .select({
      id: org.attachmentLinks.targetId,
      n: sql<number>`count(*)`,
    })
    .from(org.attachmentLinks)
    .where(eq(org.attachmentLinks.targetType, "reconciliation"))
    .groupBy(org.attachmentLinks.targetId)
    .all();
  const fileCount = new Map(files.map((f) => [f.id, Number(f.n)]));
  const flags = await db
    .select({ id: org.reconciliationFlags.reconciliationId, n: sql<number>`count(*)` })
    .from(org.reconciliationFlags)
    .where(eq(org.reconciliationFlags.status, "open"))
    .groupBy(org.reconciliationFlags.reconciliationId)
    .all();
  const openFlags = new Map(flags.map((f) => [f.id, Number(f.n)]));
  return rows.map((r) => ({
    ...reconView(r),
    statement_count: fileCount.get(r.id) ?? 0,
    open_flag_count: openFlags.get(r.id) ?? 0,
  }));
}

export async function startReconTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: {
    account_id: string;
    statement_end_date: string;
    statement_ending_balance: number;
    rationale?: string;
  },
) {
  await ledgerAccount(tx, input.account_id);
  const open = await tx
    .select({ id: org.reconciliations.id })
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, input.account_id),
        eq(org.reconciliations.status, "in_progress"),
      ),
    )
    .get();
  if (open)
    throw conflict(
      "Finish or discard the reconciliation already in progress for this account.",
      "in_progress",
      { id: open.id },
    );
  const last = await tx
    .select()
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, input.account_id),
        eq(org.reconciliations.status, "completed"),
      ),
    )
    .orderBy(desc(org.reconciliations.statementEndDate))
    .limit(1)
    .get();
  if (last && input.statement_end_date <= last.statementEndDate) {
    throw unprocessable(
      `This account is reconciled through ${last.statementEndDate}. Choose a later statement date.`,
      "already_reconciled",
    );
  }
  const beginning = last?.statementEndingBalance ?? 0;
  const id = newId();
  await tx.insert(org.reconciliations).values({
    id,
    bankAccountId: input.account_id,
    statementEndDate: input.statement_end_date,
    statementEndingBalance: input.statement_ending_balance,
    beginningBalance: beginning,
    clearedBalance: beginning,
    createdBy: a.userId,
  });
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.start",
    targetType: "reconciliation",
    targetId: id,
    after: input,
  });
  return reconView(await mustGetRecon(tx, id));
}

/** Posted lines on the account through the statement date that no completed reconciliation cleared. */
export async function reconLines(db: Reader, id: string) {
  const r = await mustGetRecon(db, id);
  const acct = await ledgerAccount(db, r.bankAccountId);
  const sign = signFor(acct.type);
  const done = await clearedElsewhere(db, r.bankAccountId, r.id);
  const mine = new Set(
    (
      await db
        .select({ lineId: org.reconciliationItems.journalLineId })
        .from(org.reconciliationItems)
        .where(eq(org.reconciliationItems.reconciliationId, id))
        .all()
    ).map((x) => x.lineId),
  );
  const lines = await db
    .select({
      id: org.journalLines.id,
      entryId: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      description: org.journalLines.description,
      amount: org.journalLines.amount,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalLines.accountId, r.bankAccountId),
        eq(org.journalEntries.status, "posted"),
        r.status === "in_progress" ? lte(org.journalEntries.date, r.statementEndDate) : undefined,
      ),
    )
    .orderBy(asc(org.journalEntries.date), asc(org.journalEntries.chainSeq))
    .all();
  return {
    reconciliation: reconView(r),
    flags: await listFlags(db, id),
    statements: await listAttachments(db, { type: "reconciliation", id }),
    lines: lines
      .filter(
        (l) =>
          !done.has(l.id) && (r.status === "in_progress" || mine.has(l.id) || l.date <= r.statementEndDate),
      )
      .map((l) => ({
        id: l.id,
        entry_id: l.entryId,
        date: l.date,
        memo: l.memo,
        description: l.description,
        amount: l.amount * sign,
        cleared: mine.has(l.id),
      })),
  };
}

// ---------------------------------------------------------------------------
// Flags: what a statement shows that the books don't (or the reverse)
// ---------------------------------------------------------------------------

export const FLAG_KINDS = [
  "missing_from_books",
  "not_on_statement",
  "mismatch",
  "beginning_balance",
  "other",
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
type FlagRow = typeof org.reconciliationFlags.$inferSelect;

export function flagView(f: FlagRow) {
  return {
    id: f.id,
    reconciliation_id: f.reconciliationId,
    kind: f.kind,
    date: f.date,
    amount: f.amount,
    journal_line_id: f.journalLineId,
    description: f.description,
    status: f.status,
    created_by: f.createdBy,
    created_actor: f.createdActor as Actor,
    created_at: f.createdAt,
    resolved_by: f.resolvedBy,
    resolved_actor: f.resolvedActor as Actor | null,
    resolved_at: f.resolvedAt,
    resolution_note: f.resolutionNote,
  };
}

export async function listFlags(db: Reader, reconId: string) {
  const rows = await db
    .select()
    .from(org.reconciliationFlags)
    .where(eq(org.reconciliationFlags.reconciliationId, reconId))
    .orderBy(asc(org.reconciliationFlags.createdAt), asc(org.reconciliationFlags.id))
    .all();
  return rows.map(flagView);
}

export async function mustGetFlag(db: Reader, id: string) {
  const f = await db.select().from(org.reconciliationFlags).where(eq(org.reconciliationFlags.id, id)).get();
  if (!f) throw notFound("Flag");
  return f;
}

export interface FlagInput {
  kind: FlagKind;
  description: string;
  date?: string | null;
  amount?: number | null;
  journal_line_id?: string | null;
}

export async function createFlagTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  reconId: string,
  input: FlagInput,
) {
  const r = await mustGetRecon(tx, reconId);
  if (r.status !== "in_progress")
    throw conflict("Flags can only be added to a reconciliation in progress.", "invalid_state");
  const description = input.description.trim();
  if (!description) throw unprocessable("Describe the problem.", "invalid_flag");
  const date = input.date ?? null;
  const amount = input.amount ?? null;
  const lineId = input.journal_line_id ?? null;
  const need = (ok: boolean, what: string) => {
    if (!ok) throw unprocessable(`A ${input.kind.replace(/_/g, " ")} flag needs ${what}.`, "invalid_flag");
  };
  if (input.kind === "missing_from_books") need(date != null && amount != null, "a date and an amount");
  else if (input.kind === "not_on_statement") need(lineId != null, "a journal line");
  else if (input.kind === "mismatch")
    need(
      lineId != null && (amount != null || date != null),
      "a journal line and the statement's amount or date",
    );
  else if (input.kind === "beginning_balance") need(amount != null, "the statement's opening balance");
  if (lineId) {
    const line = await tx
      .select({ id: org.journalLines.id })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          eq(org.journalLines.id, lineId),
          eq(org.journalLines.accountId, r.bankAccountId),
          eq(org.journalEntries.status, "posted"),
        ),
      )
      .get();
    if (!line)
      throw unprocessable(
        "That line is not a posted line of this reconciliation's account.",
        "invalid_lines",
      );
  }
  const dup = await tx
    .select({ id: org.reconciliationFlags.id })
    .from(org.reconciliationFlags)
    .where(
      and(
        eq(org.reconciliationFlags.reconciliationId, reconId),
        eq(org.reconciliationFlags.status, "open"),
        eq(org.reconciliationFlags.kind, input.kind),
        lineId
          ? eq(org.reconciliationFlags.journalLineId, lineId)
          : and(
              sql`${org.reconciliationFlags.journalLineId} is null`,
              date == null
                ? sql`${org.reconciliationFlags.date} is null`
                : eq(org.reconciliationFlags.date, date),
              amount == null
                ? sql`${org.reconciliationFlags.amount} is null`
                : eq(org.reconciliationFlags.amount, amount),
            ),
      ),
    )
    .get();
  if (dup && (lineId || input.kind !== "other"))
    throw conflict("An open flag for this item already exists.", "duplicate_flag", { id: dup.id });
  const id = newId();
  await tx.insert(org.reconciliationFlags).values({
    id,
    reconciliationId: reconId,
    kind: input.kind,
    date,
    amount,
    journalLineId: lineId,
    description,
    createdBy: a.userId,
    createdActor: a.actor,
  });
  const view = flagView(await mustGetFlag(tx, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.flag",
    targetType: "reconciliation",
    targetId: reconId,
    after: view,
  });
  return view;
}

/** People resolve or dismiss any flag; the agent resolves only flags it raised, and never dismisses. */
export async function resolveFlagTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  flagId: string,
  input: { status: "resolved" | "dismissed"; note?: string | null },
) {
  const f = await mustGetFlag(tx, flagId);
  // Assistants and propose-only tokens resolve only flags their kind of actor raised, and never dismiss.
  if (a.actor === "mcp" || a.proposeOnly) {
    if (input.status !== "resolved") throw forbidden("Only a person can dismiss a flag.");
    if (f.createdActor !== a.actor) throw forbidden("You can resolve only flags you raised.");
  }
  if (f.status !== "open") throw conflict(`This flag is already ${f.status}.`, "invalid_state");
  await tx
    .update(org.reconciliationFlags)
    .set({
      status: input.status,
      resolvedBy: a.userId,
      resolvedActor: a.actor,
      resolvedAt: new Date().toISOString(),
      resolutionNote: input.note?.trim() || null,
    })
    .where(eq(org.reconciliationFlags.id, flagId));
  const view = flagView(await mustGetFlag(tx, flagId));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.flag_resolve",
    targetType: "reconciliation",
    targetId: f.reconciliationId,
    before: flagView(f),
    after: view,
  });
  return view;
}

async function recompute(tx: OrgTx, r: ReconRow, sign: number) {
  const sum = await tx
    .select({ total: sql<number>`coalesce(sum(${org.journalLines.amount}), 0)` })
    .from(org.reconciliationItems)
    .innerJoin(org.journalLines, eq(org.journalLines.id, org.reconciliationItems.journalLineId))
    .where(eq(org.reconciliationItems.reconciliationId, r.id))
    .get();
  const cleared = r.beginningBalance + Number(sum?.total ?? 0) * sign;
  await tx
    .update(org.reconciliations)
    .set({ clearedBalance: cleared })
    .where(eq(org.reconciliations.id, r.id));
}

export async function toggleLinesTx(tx: OrgTx, id: string, lineIds: string[], cleared: boolean) {
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress") throw conflict("This reconciliation is locked.", "locked");
  const acct = await ledgerAccount(tx, r.bankAccountId);
  if (lineIds.length) {
    const valid = await tx
      .select({ id: org.journalLines.id })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          inArray(org.journalLines.id, lineIds),
          eq(org.journalLines.accountId, r.bankAccountId),
          eq(org.journalEntries.status, "posted"),
          lte(org.journalEntries.date, r.statementEndDate),
        ),
      )
      .all();
    const done = await clearedElsewhere(tx, r.bankAccountId, r.id);
    const ok = valid.map((v) => v.id).filter((x) => !done.has(x));
    if (ok.length !== new Set(lineIds).size)
      throw unprocessable("Some lines do not belong to this reconciliation.", "invalid_lines");
    if (cleared) {
      await tx
        .insert(org.reconciliationItems)
        .values(ok.map((journalLineId) => ({ reconciliationId: id, journalLineId })))
        .onConflictDoNothing();
    } else {
      await tx
        .delete(org.reconciliationItems)
        .where(
          and(
            eq(org.reconciliationItems.reconciliationId, id),
            inArray(org.reconciliationItems.journalLineId, ok),
          ),
        );
    }
  }
  await recompute(tx, r, signFor(acct.type));
  return reconView(await mustGetRecon(tx, id));
}

export async function completeReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  // Defense in depth: no MCP tool completes, and a propose-only token must not either.
  if (a.actor === "mcp" || a.proposeOnly) throw forbidden("Only a person can complete a reconciliation.");
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress") throw conflict(`This reconciliation is ${r.status}.`, "invalid_state");
  const open = await tx
    .select({ n: sql<number>`count(*)` })
    .from(org.reconciliationFlags)
    .where(and(eq(org.reconciliationFlags.reconciliationId, id), eq(org.reconciliationFlags.status, "open")))
    .get();
  if (Number(open?.n ?? 0) > 0)
    throw unprocessable(
      "Resolve or dismiss the open flags before completing this reconciliation.",
      "open_flags",
    );
  if (r.clearedBalance !== r.statementEndingBalance) {
    throw unprocessable(
      `The cleared balance differs from the statement by ${((r.statementEndingBalance - r.clearedBalance) / 100).toFixed(2)}.`,
      "not_balanced",
    );
  }
  const completedAt = new Date().toISOString();
  await tx
    .update(org.reconciliations)
    .set({ status: "completed", completedBy: a.userId, completedAt })
    .where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.complete",
    targetType: "reconciliation",
    targetId: id,
    after: reconView({ ...r, status: "completed" }),
  });
  return reconView(await mustGetRecon(tx, id));
}

export async function discardReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const r = await mustGetRecon(tx, id);
  if (r.status !== "in_progress")
    throw conflict("Only a reconciliation in progress can be discarded.", "invalid_state");
  await tx.delete(org.reconciliationItems).where(eq(org.reconciliationItems.reconciliationId, id));
  await tx.delete(org.reconciliationFlags).where(eq(org.reconciliationFlags.reconciliationId, id));
  // Unlink the statements; the files stay, like other unlinked attachments.
  await tx
    .delete(org.attachmentLinks)
    .where(and(eq(org.attachmentLinks.targetType, "reconciliation"), eq(org.attachmentLinks.targetId, id)));
  await tx.delete(org.reconciliations).where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.discard",
    targetType: "reconciliation",
    targetId: id,
    before: reconView(r),
  });
}

/** Undo the latest completed reconciliation of an account (owners only; audit logged). */
export async function undoReconTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  if (a.role !== "owner" || a.actor === "mcp")
    throw forbidden("Only owners can undo a completed reconciliation.");
  const r = await mustGetRecon(tx, id);
  if (r.status !== "completed")
    throw conflict("Only completed reconciliations can be undone.", "invalid_state");
  const later = await tx
    .select({ id: org.reconciliations.id })
    .from(org.reconciliations)
    .where(
      and(
        eq(org.reconciliations.bankAccountId, r.bankAccountId),
        eq(org.reconciliations.status, "completed"),
        sql`${org.reconciliations.statementEndDate} > ${r.statementEndDate}`,
      ),
    )
    .get();
  if (later) throw conflict("Undo the later reconciliations of this account first.", "not_latest");
  const undoneAt = new Date().toISOString();
  await tx
    .update(org.reconciliations)
    .set({ status: "undone", undoneBy: a.userId, undoneAt })
    .where(eq(org.reconciliations.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reconciliation.undo",
    targetType: "reconciliation",
    targetId: id,
    before: reconView(r),
  });
  return reconView(await mustGetRecon(tx, id));
}

/** Unreconciled posted lines of an account (as of a date). */
export async function unreconciled(db: Reader, accountId: string, asOf?: string) {
  const acct = await ledgerAccount(db, accountId);
  const done = await clearedElsewhere(db, accountId);
  const rows = await db
    .select({
      id: org.journalLines.id,
      entryId: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      amount: org.journalLines.amount,
    })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalLines.accountId, accountId),
        eq(org.journalEntries.status, "posted"),
        asOf ? lte(org.journalEntries.date, asOf) : undefined,
      ),
    )
    .orderBy(asc(org.journalEntries.date))
    .all();
  const sign = signFor(acct.type);
  return rows
    .filter((r) => !done.has(r.id))
    .map((r) => ({ id: r.id, entry_id: r.entryId, date: r.date, memo: r.memo, amount: r.amount * sign }));
}

function csv(rows: (string | number | null)[][]) {
  return `${rows.map((r) => r.map((v) => csvCell(v == null ? "" : String(v))).join(",")).join("\r\n")}\r\n`;
}

/** Reconciliation report as CSV and PDF, for the export endpoint and the year-end package. */
export async function reconciliationFiles(db: Reader, reconId: string, orgName: string, generatedAt: string) {
  const { reconciliation: rec, lines, flags } = await reconLines(db, reconId);
  const acct = await db.select().from(org.accounts).where(eq(org.accounts.id, rec.account_id)).get();
  const cleared = lines.filter((l) => l.cleared);
  const open = lines.filter((l) => !l.cleared);
  const name = `reconciliation-${(acct?.name ?? "account").replace(/\W+/g, "-")}-${rec.statement_end_date}`;
  const csvText = csv([
    ["Account", acct?.name ?? "", "Statement date", rec.statement_end_date, "Status", rec.status],
    [
      "Beginning",
      rec.beginning_balance / 100,
      "Cleared",
      rec.cleared_balance / 100,
      "Statement",
      rec.statement_ending_balance / 100,
    ],
    [],
    ["date", "memo", "amount", "cleared"],
    ...lines.map((l) => [
      l.date,
      l.memo ?? l.description ?? "",
      (l.amount / 100).toFixed(2),
      l.cleared ? "yes" : "no",
    ]),
    ...(flags.length
      ? [
          [],
          ["Flags"],
          ["kind", "date", "amount", "description", "status", "note"],
          ...flags.map((f) => [
            f.kind,
            f.date,
            f.amount == null ? "" : (f.amount / 100).toFixed(2),
            f.description,
            f.status,
            f.resolution_note,
          ]),
        ]
      : []),
  ]);
  const pdf = await renderReportPdf({
    title: `Reconciliation: ${acct?.name ?? ""}`,
    orgName,
    subtitle: `Statement ending ${rec.statement_end_date} · ${rec.status.replace("_", " ")}`,
    currency: "USD",
    columns: [{ label: "Date" }, { label: "Memo" }, { label: "Amount", align: "right" }],
    rows: [
      { kind: "row", cells: ["", "Beginning balance", rec.beginning_balance] },
      { kind: "header", cells: ["Cleared", null, null] },
      ...cleared.map((l) => ({
        kind: "row" as const,
        depth: 1,
        cells: [l.date, l.memo ?? l.description ?? "", l.amount],
      })),
      { kind: "subtotal", cells: ["", "Cleared balance", rec.cleared_balance] },
      { kind: "row", cells: ["", "Statement ending balance", rec.statement_ending_balance] },
      { kind: "total", cells: ["", "Difference", rec.difference] },
      { kind: "header", cells: ["Uncleared", null, null] },
      ...open.map((l) => ({
        kind: "row" as const,
        depth: 1,
        cells: [l.date, l.memo ?? l.description ?? "", l.amount],
      })),
      ...(flags.length
        ? [
            { kind: "header" as const, cells: ["Flags", null, null] },
            ...flags.map((f) => ({
              kind: "row" as const,
              depth: 1,
              cells: [
                f.date ?? "",
                `${f.kind.replace(/_/g, " ")} (${f.status}): ${f.description}${f.resolution_note ? ` - ${f.resolution_note}` : ""}`,
                f.amount,
              ],
            })),
          ]
        : []),
    ],
    footer: [`Generated ${generatedAt}`],
  });
  return { name, csv: csvText, pdf };
}
