/**
 * Reserves (#114): money earmarked as a rate of net income for each tax year, such as tax set aside
 * for the owner. Cosimo never computes tax: the person supplies each part's rate and due dates, and
 * the target is `rate × max(0, net income)` from the start of the tax year to date. The pure rules
 * are in packages/core/src/reserves.ts.
 *
 * - `track` mode only reports target, paid, and remaining. `book` mode also books the target as a
 *   liability: a true-up entry (`reserve_true_up`, source_id the reserve) debits the charge account
 *   (Owner Draw unless set) and credits each part's liability account for the difference between
 *   the target and what is already booked.
 * - Booked totals come from the journal: lines on a part's liability account from this reserve's
 *   true-ups (and their reversals) that are posted or waiting in review, dated in the tax year.
 * - Paid comes only from `reserve_payments`, which the person attributes to a tax year (a January
 *   payment can belong to the year before). Paid from a bank account, a payment also proposes a
 *   `reserve_payment` entry; rejecting that entry removes the payment record (audited).
 * - Configuration is a person's (REST and the web); assistants read reserves, propose true-ups, and
 *   record payments, but can't create or change one.
 */
import {
  type DueDate,
  dueDateError,
  dueDatesFor,
  type Flow,
  MAX_RATE_BP,
  partTarget,
  projectedAnnual,
  RESERVE_BASES,
  RESERVE_MODES,
  type ReserveBase,
  type ReserveMode,
  reserveFlows,
  TRUE_UP_SCHEDULES,
  type TrueUpSchedule,
  taxYearOf,
  taxYearRange,
  yearInstallments,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { isIsoDate, today } from "@cosimo/shared";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { mustGetBankAccount } from "./banking.ts";
import {
  getEntry,
  onEntryRejected,
  type SubmitOptions,
  type SubmitResult,
  settingsRow,
  submitEntryTx,
  systemAccountId,
} from "./ledger.ts";
import { netIncome } from "./reports.ts";

type Reader = OrgDb | OrgTx;
export type ReserveRow = typeof org.reserves.$inferSelect;
export type PartRow = typeof org.reserveParts.$inferSelect;
export type PaymentRow = typeof org.reservePayments.$inferSelect;

// ----------------------------------------------------------------------------- views

export interface PartView {
  id: string;
  label: string;
  rate_bp: number;
  due_dates: DueDate[];
  liability_account_id: string | null;
  position: number;
}

export interface ReserveConfigView {
  id: string;
  name: string;
  mode: ReserveMode;
  base: ReserveBase;
  tax_year_start_month: number;
  charge_account_id: string | null;
  true_up_schedule: TrueUpSchedule;
  parts: PartView[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function parseDueDates(json: string): DueDate[] {
  try {
    const v = JSON.parse(json) as DueDate[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function partView(p: PartRow): PartView {
  return {
    id: p.id,
    label: p.label,
    rate_bp: p.rateBp,
    due_dates: parseDueDates(p.dueDatesJson),
    liability_account_id: p.liabilityAccountId,
    position: p.position,
  };
}

export function reserveConfigView(r: ReserveRow, parts: PartRow[]): ReserveConfigView {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    base: r.base,
    tax_year_start_month: r.taxYearStartMonth,
    charge_account_id: r.chargeAccountId,
    true_up_schedule: r.trueUpSchedule,
    parts: parts
      .filter((p) => !p.archivedAt)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(partView),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    archived_at: r.archivedAt,
  };
}

export async function mustGetReserve(db: Reader, id: string) {
  const r = await db.select().from(org.reserves).where(eq(org.reserves.id, id)).get();
  if (!r) throw notFound("Reserve");
  return r;
}

async function partsOf(db: Reader, reserveId: string, includeArchived = false) {
  return db
    .select()
    .from(org.reserveParts)
    .where(
      and(
        eq(org.reserveParts.reserveId, reserveId),
        includeArchived ? undefined : isNull(org.reserveParts.archivedAt),
      ),
    )
    .orderBy(asc(org.reserveParts.position), asc(org.reserveParts.id))
    .all();
}

export async function getReserveConfig(db: Reader, id: string) {
  const r = await mustGetReserve(db, id);
  return reserveConfigView(r, await partsOf(db, id));
}

export async function listReserves(db: Reader, includeArchived = false): Promise<ReserveConfigView[]> {
  const rows = await db
    .select()
    .from(org.reserves)
    .where(includeArchived ? undefined : isNull(org.reserves.archivedAt))
    .orderBy(asc(org.reserves.createdAt), asc(org.reserves.id))
    .all();
  if (!rows.length) return [];
  const parts = await db
    .select()
    .from(org.reserveParts)
    .where(
      and(
        inArray(
          org.reserveParts.reserveId,
          rows.map((r) => r.id),
        ),
        isNull(org.reserveParts.archivedAt),
      ),
    )
    .all();
  return rows.map((r) =>
    reserveConfigView(
      r,
      parts.filter((p) => p.reserveId === r.id),
    ),
  );
}

export async function mustGetPart(db: Reader, id: string) {
  const p = await db.select().from(org.reserveParts).where(eq(org.reserveParts.id, id)).get();
  if (!p) throw notFound("Reserve part");
  return p;
}

// ----------------------------------------------------------------------------- configuration

export interface PartInput {
  /** An existing part to keep (and update); new parts leave it out. */
  id?: string | null;
  label: string;
  rate_bp: number;
  due_dates: DueDate[];
  liability_account_id?: string | null;
}

export interface ReserveInput {
  name: string;
  mode?: ReserveMode;
  base?: ReserveBase;
  tax_year_start_month?: number;
  charge_account_id?: string | null;
  true_up_schedule?: TrueUpSchedule;
  parts: PartInput[];
}

async function accountRow(db: Reader, id: string) {
  return db.select().from(org.accounts).where(eq(org.accounts.id, id)).get();
}

/** Checks a whole reserve (create, or an edit merged with what is stored). */
async function checkReserve(db: Reader, v: Required<Omit<ReserveInput, "parts">> & { parts: PartInput[] }) {
  if (!v.name.trim()) throw unprocessable("A reserve needs a name.", "invalid_name");
  if (!(RESERVE_MODES as readonly string[]).includes(v.mode))
    throw unprocessable("The mode is track or book.", "invalid_mode");
  if (!(RESERVE_BASES as readonly string[]).includes(v.base))
    throw unprocessable("The base is net_income.", "invalid_base");
  if (!Number.isInteger(v.tax_year_start_month) || v.tax_year_start_month < 1 || v.tax_year_start_month > 12)
    throw unprocessable("The tax year starts in month 1 to 12.", "invalid_month");
  if (!(TRUE_UP_SCHEDULES as readonly string[]).includes(v.true_up_schedule))
    throw unprocessable("The true-up schedule is manual or monthly.", "invalid_schedule");
  if (v.true_up_schedule === "monthly" && v.mode !== "book")
    throw unprocessable("Monthly true-ups are for a reserve in book mode.", "invalid_schedule");
  if (!v.parts.length) throw unprocessable("A reserve needs at least one part.", "invalid_parts");
  if (v.charge_account_id) {
    const a = await accountRow(db, v.charge_account_id);
    if (!a) throw unprocessable("Unknown charge account.", "unknown_account");
    if (!a.isActive) throw unprocessable("The charge account is inactive.", "inactive_account");
  }
  const liabilities = new Set<string>();
  for (const p of v.parts) {
    if (!p.label.trim()) throw unprocessable("Each part needs a label.", "invalid_parts");
    if (!Number.isInteger(p.rate_bp) || p.rate_bp < 0 || p.rate_bp > MAX_RATE_BP)
      throw unprocessable(`${p.label}: the rate is 0% to 100%, in basis points 0 to 10000.`, "invalid_rate");
    if (!p.due_dates.length)
      throw unprocessable(`${p.label}: add at least one due date.`, "invalid_due_date");
    for (const d of p.due_dates) {
      const err = dueDateError(d);
      if (err) throw unprocessable(`${p.label}: ${err}`, "invalid_due_date");
    }
    if (p.liability_account_id) {
      const a = await accountRow(db, p.liability_account_id);
      if (!a) throw unprocessable(`${p.label}: unknown liability account.`, "unknown_account");
      if (a.type !== "liability")
        throw unprocessable(`${p.label}: the account must be a liability account.`, "invalid_account");
      if (!a.isActive)
        throw unprocessable(`${p.label}: the liability account is inactive.`, "inactive_account");
      // Booked totals are read per account, so two parts can't share one.
      if (liabilities.has(a.id))
        throw unprocessable("Each part needs its own liability account.", "invalid_account");
      liabilities.add(a.id);
    } else if (v.mode === "book") {
      throw unprocessable(
        `${p.label}: book mode needs a liability account for each part.`,
        "invalid_account",
      );
    }
  }
}

async function writeParts(tx: OrgTx, reserveId: string, parts: PartInput[]) {
  const existing = await partsOf(tx, reserveId);
  const keep = new Set<string>();
  for (const [i, p] of parts.entries()) {
    const values = {
      label: p.label.trim(),
      rateBp: p.rate_bp,
      dueDatesJson: JSON.stringify(
        p.due_dates.map((d) => ({ month: d.month, day: d.day, year_offset: d.year_offset })),
      ),
      liabilityAccountId: p.liability_account_id ?? null,
      position: i,
    };
    if (p.id) {
      if (!existing.some((e) => e.id === p.id))
        throw unprocessable("A part isn't in this reserve.", "invalid_parts");
      keep.add(p.id);
      await tx.update(org.reserveParts).set(values).where(eq(org.reserveParts.id, p.id));
    } else {
      await tx.insert(org.reserveParts).values({ id: newId(), reserveId, ...values });
    }
  }
  // A part left out is archived, not deleted: its payments still point at it.
  const now = new Date().toISOString();
  for (const e of existing)
    if (!keep.has(e.id))
      await tx.update(org.reserveParts).set({ archivedAt: now }).where(eq(org.reserveParts.id, e.id));
}

export async function createReserveTx(tx: OrgTx, orgId: string, a: ActorInfo, input: ReserveInput) {
  const v = {
    name: input.name,
    mode: input.mode ?? "track",
    base: input.base ?? "net_income",
    tax_year_start_month: input.tax_year_start_month ?? 1,
    charge_account_id: input.charge_account_id ?? null,
    true_up_schedule: input.true_up_schedule ?? "manual",
    parts: input.parts,
  } as const;
  await checkReserve(tx, v);
  if (input.parts.some((p) => p.id))
    throw unprocessable("A new reserve's parts have no id.", "invalid_parts");
  const id = newId();
  await tx.insert(org.reserves).values({
    id,
    name: v.name.trim(),
    mode: v.mode,
    base: v.base,
    taxYearStartMonth: v.tax_year_start_month,
    chargeAccountId: v.charge_account_id,
    trueUpSchedule: v.true_up_schedule,
    createdBy: a.userId,
  });
  await writeParts(tx, id, input.parts);
  const view = await getReserveConfig(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "reserve.create",
    targetType: "reserve",
    targetId: id,
    after: view,
  });
  return view;
}

/** Change a reserve. `parts`, when given, is the whole list: parts left out are archived. */
export async function updateReserveTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  patch: Partial<ReserveInput>,
) {
  const cur = await mustGetReserve(tx, id);
  if (cur.archivedAt) throw conflict("That reserve is archived.", "reserve_archived");
  const before = await getReserveConfig(tx, id);
  const v = {
    name: patch.name ?? cur.name,
    mode: patch.mode ?? cur.mode,
    base: patch.base ?? cur.base,
    tax_year_start_month: patch.tax_year_start_month ?? cur.taxYearStartMonth,
    charge_account_id: patch.charge_account_id === undefined ? cur.chargeAccountId : patch.charge_account_id,
    true_up_schedule: patch.true_up_schedule ?? cur.trueUpSchedule,
    parts:
      patch.parts ??
      before.parts.map((p) => ({
        id: p.id,
        label: p.label,
        rate_bp: p.rate_bp,
        due_dates: p.due_dates,
        liability_account_id: p.liability_account_id,
      })),
  };
  await checkReserve(tx, v);
  await tx
    .update(org.reserves)
    .set({
      name: v.name.trim(),
      mode: v.mode,
      base: v.base,
      taxYearStartMonth: v.tax_year_start_month,
      chargeAccountId: v.charge_account_id,
      trueUpSchedule: v.true_up_schedule,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(org.reserves.id, id));
  if (patch.parts) await writeParts(tx, id, patch.parts);
  const after = await getReserveConfig(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "reserve.update",
    targetType: "reserve",
    targetId: id,
    before,
    after,
  });
  return after;
}

export async function archiveReserveTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const cur = await mustGetReserve(tx, id);
  if (cur.archivedAt) return getReserveConfig(tx, id);
  const now = new Date().toISOString();
  await tx.update(org.reserves).set({ archivedAt: now, updatedAt: now }).where(eq(org.reserves.id, id));
  const after = await getReserveConfig(tx, id);
  await appendAudit(tx, orgId, a, { action: "reserve.archive", targetType: "reserve", targetId: id, after });
  return after;
}

// ----------------------------------------------------------------------------- the reserve view

export interface PartStatus {
  part_id: string;
  label: string;
  rate_bp: number;
  target: number;
  paid: number;
  remaining: number;
  /** The year's target if net income keeps its pace. */
  projected_annual: number;
  /** Book mode only (null in track mode). */
  booked: number | null;
  booked_pending: number | null;
  true_up_due: number | null;
  held: number | null;
  liability_balance: number | null;
  next_due: { date: string; amount: number } | null;
}

export interface ReserveStatus {
  reserve: ReserveConfigView;
  as_of: string;
  tax_year: number;
  tax_year_start: string;
  tax_year_end: string;
  basis: "cash" | "accrual";
  net_income: number;
  parts: PartStatus[];
  totals: Omit<PartStatus, "part_id" | "label" | "rate_bp">;
  /** Book mode: a true-up of this reserve is waiting in review. */
  true_up_pending: boolean;
}

/** Sum of payments per part for one tax year. */
async function paidByPart(db: Reader, partIds: string[], year: number) {
  if (!partIds.length) return new Map<string, number>();
  const rows = await db
    .select({ partId: org.reservePayments.partId, total: sql<number>`sum(${org.reservePayments.amount})` })
    .from(org.reservePayments)
    .where(and(inArray(org.reservePayments.partId, partIds), eq(org.reservePayments.taxYear, year)))
    .groupBy(org.reservePayments.partId)
    .all();
  return new Map(rows.map((r) => [r.partId, Number(r.total)]));
}

/**
 * Booked per liability account for a reserve's tax year: the negated lines of its true-ups (and
 * reversals of them) that are posted or waiting in review, dated in the year; and the pending part.
 */
async function bookedByAccount(
  db: Reader,
  reserveId: string,
  accountIds: string[],
  from: string,
  to: string,
) {
  const out = new Map<string, { booked: number; pending: number }>();
  if (!accountIds.length) return out;
  const je = org.journalEntries;
  const trueUps = db
    .select({ id: je.id })
    .from(je)
    .where(and(eq(je.sourceType, "reserve_true_up"), eq(je.sourceId, reserveId)));
  const rows = await db
    .select({
      accountId: org.journalLines.accountId,
      status: je.status,
      total: sql<number>`sum(${org.journalLines.amount})`,
    })
    .from(org.journalLines)
    .innerJoin(je, eq(je.id, org.journalLines.entryId))
    .where(
      and(
        inArray(je.status, ["posted", "pending_review"]),
        gte(je.date, from),
        lte(je.date, to),
        inArray(org.journalLines.accountId, accountIds),
        or(
          and(eq(je.sourceType, "reserve_true_up"), eq(je.sourceId, reserveId)),
          inArray(je.reversesEntryId, trueUps),
        ),
      ),
    )
    .groupBy(org.journalLines.accountId, je.status)
    .all();
  for (const r of rows) {
    const cur = out.get(r.accountId) ?? { booked: 0, pending: 0 };
    cur.booked -= Number(r.total);
    if (r.status === "pending_review") cur.pending -= Number(r.total);
    out.set(r.accountId, cur);
  }
  return out;
}

/** Posted balances (normal sign: credit positive) of liability accounts through a date. */
async function liabilityBalances(db: Reader, accountIds: string[], asOf: string) {
  if (!accountIds.length) return new Map<string, number>();
  const rows = await db
    .select({ accountId: org.journalLines.accountId, total: sql<number>`sum(${org.journalLines.amount})` })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(
      and(
        eq(org.journalEntries.status, "posted"),
        lte(org.journalEntries.date, asOf),
        inArray(org.journalLines.accountId, accountIds),
      ),
    )
    .groupBy(org.journalLines.accountId)
    .all();
  return new Map(rows.map((r) => [r.accountId, -Number(r.total)]));
}

export async function pendingTrueUp(db: Reader, reserveId: string) {
  return db
    .select({ id: org.journalEntries.id })
    .from(org.journalEntries)
    .where(
      and(
        eq(org.journalEntries.sourceType, "reserve_true_up"),
        eq(org.journalEntries.sourceId, reserveId),
        eq(org.journalEntries.status, "pending_review"),
      ),
    )
    .get();
}

/** Net income from the tax year's start to `asOf` (or its end), on the org's default basis. */
async function yearNetIncome(
  db: Reader,
  range: { start: string; end: string },
  asOf: string,
  basis: "cash" | "accrual",
) {
  const to = asOf < range.end ? asOf : range.end;
  if (to < range.start) return 0;
  return netIncome(db, range.start, to, basis);
}

/**
 * Target, paid, and remaining for each part (and in book mode booked, held, and the true-up due)
 * for tax year `tax_year`, or the one `as_of` falls in.
 */
export async function reserveView(
  db: Reader,
  reserveId: string,
  opts: { as_of?: string | null; tax_year?: number | null } = {},
): Promise<ReserveStatus> {
  const asOf = opts.as_of ?? today();
  if (!isIsoDate(asOf)) throw unprocessable("Enter a valid date.", "invalid_date");
  const config = await getReserveConfig(db, reserveId);
  const start = config.tax_year_start_month;
  const year = opts.tax_year ?? taxYearOf(asOf, start);
  const range = taxYearRange(year, start);
  const s = await settingsRow(db);
  const ni = await yearNetIncome(db, range, asOf, s.defaultBasis);
  const book = config.mode === "book";
  const partIds = config.parts.map((p) => p.id);
  const paid = await paidByPart(db, partIds, year);
  const accounts = config.parts.map((p) => p.liability_account_id).filter((x): x is string => Boolean(x));
  const booked = book ? await bookedByAccount(db, reserveId, accounts, range.start, range.end) : new Map();
  const balances = book ? await liabilityBalances(db, accounts, asOf) : new Map<string, number>();
  const parts: PartStatus[] = config.parts.map((p) => {
    const target = partTarget(ni, p.rate_bp);
    const paidAmt = paid.get(p.id) ?? 0;
    const projected = projectedAnnual(ni, p.rate_bp, range, asOf);
    const next = yearInstallments({
      dates: dueDatesFor(p, year, start),
      asOf,
      target,
      paid: paidAmt,
      projected,
    })[0];
    const b = p.liability_account_id ? booked.get(p.liability_account_id) : undefined;
    const bookedAmt = book ? (b?.booked ?? 0) : null;
    return {
      part_id: p.id,
      label: p.label,
      rate_bp: p.rate_bp,
      target,
      paid: paidAmt,
      remaining: target - paidAmt,
      projected_annual: projected,
      booked: bookedAmt,
      booked_pending: book ? (b?.pending ?? 0) : null,
      true_up_due: bookedAmt === null ? null : target - bookedAmt,
      held: bookedAmt === null ? null : bookedAmt - paidAmt,
      liability_balance: book && p.liability_account_id ? (balances.get(p.liability_account_id) ?? 0) : null,
      next_due: next ? { date: next.date, amount: next.amount } : null,
    };
  });
  const sum = (k: "target" | "paid" | "remaining" | "projected_annual") =>
    parts.reduce((t, p) => t + p[k], 0);
  const sumBook = (k: "booked" | "booked_pending" | "true_up_due" | "held" | "liability_balance") =>
    book ? parts.reduce((t, p) => t + (p[k] ?? 0), 0) : null;
  const nextDate = parts
    .map((p) => p.next_due?.date)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  return {
    reserve: config,
    as_of: asOf,
    tax_year: year,
    tax_year_start: range.start,
    tax_year_end: range.end,
    basis: s.defaultBasis,
    net_income: ni,
    parts,
    totals: {
      target: sum("target"),
      paid: sum("paid"),
      remaining: sum("remaining"),
      projected_annual: sum("projected_annual"),
      booked: sumBook("booked"),
      booked_pending: sumBook("booked_pending"),
      true_up_due: sumBook("true_up_due"),
      held: sumBook("held"),
      liability_balance: sumBook("liability_balance"),
      next_due: nextDate
        ? {
            date: nextDate,
            amount: parts.reduce((t, p) => t + (p.next_due?.date === nextDate ? p.next_due.amount : 0), 0),
          }
        : null,
    },
    true_up_pending: book ? Boolean(await pendingTrueUp(db, reserveId)) : false,
  };
}

// ----------------------------------------------------------------------------- the forecast

/**
 * Every active reserve's outflows for the forecast, and for each part what is owed now (to hold
 * back what the window doesn't pay; see `reservesNotInWindow`).
 */
export async function reserveForecastInputs(db: Reader, asOf: string) {
  const flows: Flow[] = [];
  const owed: { id: string; tax_year: number; target: number; paid: number }[] = [];
  const list = await listReserves(db);
  if (!list.length) return { flows, owed };
  const s = await settingsRow(db);
  for (const r of list) {
    const start = r.tax_year_start_month;
    const year = taxYearOf(asOf, start);
    const range = taxYearRange(year, start);
    const prev = taxYearRange(year - 1, start);
    const ni = await yearNetIncome(db, range, asOf, s.defaultBasis);
    const prevNi = await netIncome(db, prev.start, prev.end, s.defaultBasis);
    const ids = r.parts.map((p) => p.id);
    const paid = await paidByPart(db, ids, year);
    const prevPaid = await paidByPart(db, ids, year - 1);
    flows.push(
      ...reserveFlows({
        reserve: { id: r.id, name: r.name, tax_year_start_month: start },
        parts: r.parts.map((p) => ({
          id: p.id,
          label: p.label,
          rate_bp: p.rate_bp,
          due_dates: p.due_dates,
          paid: paid.get(p.id) ?? 0,
          prev_paid: prevPaid.get(p.id) ?? 0,
        })),
        today: asOf,
        net_income: ni,
        prev_net_income: prevNi,
      }),
    );
    for (const p of r.parts)
      owed.push({ id: p.id, tax_year: year, target: partTarget(ni, p.rate_bp), paid: paid.get(p.id) ?? 0 });
  }
  return { flows, owed };
}

// ----------------------------------------------------------------------------- true-ups

/**
 * Propose a true-up of a book-mode reserve as of a date: one entry with a pair of lines per part
 * whose booked amount differs from its target (Dr the charge account / Cr the liability account,
 * flipped when the target has fallen). Refused while another true-up of the reserve is pending.
 */
export async function proposeReserveTrueUpTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  reserveId: string,
  input: { as_of?: string | null; rationale?: string | null; lock_override_note?: string | null } = {},
  opts: Pick<SubmitOptions, "requireReview" | "reviewContext"> = {},
): Promise<SubmitResult> {
  const r = await mustGetReserve(tx, reserveId);
  if (r.archivedAt) throw conflict("That reserve is archived.", "reserve_archived");
  if (r.mode !== "book")
    throw unprocessable("Only a reserve in book mode is booked, so only it has true-ups.", "not_book_mode");
  if (await pendingTrueUp(tx, reserveId))
    throw conflict(
      "A true-up of this reserve is already waiting in review. Approve or reject it first.",
      "true_up_pending",
    );
  const asOf = input.as_of ?? today();
  const view = await reserveView(tx, reserveId, { as_of: asOf });
  const charge = r.chargeAccountId ?? (await systemAccountId(tx, "owner_draw"));
  const byId = new Map(view.reserve.parts.map((p) => [p.id, p]));
  const lines = [];
  const changed = [];
  for (const p of view.parts) {
    const due = p.true_up_due ?? 0;
    const liability = byId.get(p.part_id)?.liability_account_id;
    if (!due || !liability) continue;
    lines.push(
      { accountId: charge, amount: due, description: p.label },
      { accountId: liability, amount: -due, description: p.label },
    );
    changed.push({ part_id: p.part_id, label: p.label, target: p.target, booked: p.booked, amount: due });
  }
  if (!lines.length)
    throw unprocessable(
      "What is booked already matches the target; there is nothing to true up.",
      "nothing_to_true_up",
    );
  return submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: asOf,
      memo: `Reserve true-up: ${r.name} through ${asOf}`,
      lines,
      sourceType: "reserve_true_up",
      sourceId: r.id,
      rationale: input.rationale ?? `Book the ${r.name} reserve at its target through ${asOf}.`,
      lockOverrideNote: input.lock_override_note ?? null,
    },
    {
      requireReview: opts.requireReview,
      reviewContext: {
        ...opts.reviewContext,
        reserve_true_up: {
          reserve_id: r.id,
          reserve_name: r.name,
          as_of: asOf,
          tax_year: view.tax_year,
          net_income: view.net_income,
          parts: changed,
        },
      },
    },
  );
}

/** Book-mode reserves whose booked amount differs from the target now, for an owner draw. */
export async function reservesNeedingTrueUp(db: Reader, asOf: string) {
  const out: string[] = [];
  for (const r of await listReserves(db)) {
    if (r.mode !== "book") continue;
    const v = await reserveView(db, r.id, { as_of: asOf });
    if (v.parts.some((p) => (p.true_up_due ?? 0) !== 0)) out.push(r.id);
  }
  return out;
}

// ----------------------------------------------------------------------------- payments

export interface PaymentView {
  id: string;
  part_id: string;
  reserve_id: string;
  part_label: string;
  tax_year: number;
  date: string;
  amount: number;
  entry_id: string | null;
  /** The payment's entry: pending_review, posted, or rejected; null without one. */
  entry_status: string | null;
  /** The entry was reversed (a posted reversal), so the record can go. */
  entry_reversed: boolean;
  note: string | null;
  created_by_actor: string;
  created_at: string;
  can_delete: boolean;
}

async function paymentView(db: Reader, p: PaymentRow, part?: PartRow): Promise<PaymentView> {
  const pt = part ?? (await mustGetPart(db, p.partId));
  const e = p.entryId ? await getEntry(db, p.entryId) : null;
  const reversed = e?.reversed_by_entry_id
    ? (await getEntry(db, e.reversed_by_entry_id))?.status === "posted"
    : false;
  return {
    id: p.id,
    part_id: p.partId,
    reserve_id: pt.reserveId,
    part_label: pt.label,
    tax_year: p.taxYear,
    date: p.date,
    amount: p.amount,
    entry_id: p.entryId,
    entry_status: e?.status ?? null,
    entry_reversed: reversed,
    note: p.note,
    created_by_actor: p.createdByActor,
    created_at: p.createdAt,
    can_delete: !e || e.status === "rejected" || reversed,
  };
}

export async function listReservePayments(db: Reader, reserveId: string, taxYear?: number | null) {
  await mustGetReserve(db, reserveId);
  const parts = await partsOf(db, reserveId, true);
  if (!parts.length) return [];
  const rows = await db
    .select()
    .from(org.reservePayments)
    .where(
      and(
        inArray(
          org.reservePayments.partId,
          parts.map((p) => p.id),
        ),
        taxYear == null ? undefined : eq(org.reservePayments.taxYear, taxYear),
      ),
    )
    .orderBy(asc(org.reservePayments.date), asc(org.reservePayments.id))
    .all();
  const byId = new Map(parts.map((p) => [p.id, p]));
  const out: PaymentView[] = [];
  for (const r of rows) out.push(await paymentView(db, r, byId.get(r.partId)));
  return out;
}

export interface PaymentInput {
  part_id: string;
  tax_year: number;
  date: string;
  amount: number;
  note?: string | null;
  /** Paid from this bank account: also proposes an entry. Left out, it was paid personally. */
  from_bank_account_id?: string | null;
  rationale?: string | null;
  lock_override_note?: string | null;
}

/**
 * Record a payment toward a reserve part. Without a bank account (paid personally, after a draw)
 * it is only the record, applied at once and audited. With one, it also submits a
 * `reserve_payment` entry through the review policy: Dr the part's liability account in book mode,
 * or the charge account (Owner Draw unless set) in track mode / Cr the bank's ledger account.
 */
export async function recordReservePaymentTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: PaymentInput,
  opts: Pick<SubmitOptions, "reviewContext"> = {},
): Promise<{ payment: PaymentView; result: SubmitResult | null }> {
  const part = await mustGetPart(tx, input.part_id);
  const r = await mustGetReserve(tx, part.reserveId);
  if (part.archivedAt || r.archivedAt) throw conflict("That reserve part is archived.", "reserve_archived");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw unprocessable("The payment must be a positive amount.", "invalid_amount");
  if (!isIsoDate(input.date)) throw unprocessable("Enter a valid date.", "invalid_date");
  if (!Number.isInteger(input.tax_year) || input.tax_year < 1900 || input.tax_year > 9999)
    throw unprocessable("Enter the tax year the payment is for, such as 2026.", "invalid_tax_year");
  const bank = input.from_bank_account_id ? await mustGetBankAccount(tx, input.from_bank_account_id) : null;
  const charge = r.chargeAccountId ?? (await systemAccountId(tx, "owner_draw"));
  // Which entry, if any, the payment makes:
  // - from a bank account: debit the liability (book) or the charge account (track), credit the bank;
  // - paid personally in book mode: the owner paid it out of a draw already taken, so that draw
  //   settled the declared distribution. Debit the liability, credit the charge account (Owner
  //   Draw), or the liability stays on the balance sheet and the draw counts twice in equity;
  // - paid personally in track mode: nothing was booked, so only the record.
  let lines: { debit: string; credit: string } | null = null;
  if (r.mode === "book") {
    if (!part.liabilityAccountId)
      throw unprocessable("This part has no liability account.", "invalid_account");
    lines = { debit: part.liabilityAccountId, credit: bank ? bank.ledgerAccountId : charge };
  } else if (bank) lines = { debit: charge, credit: bank.ledgerAccountId };
  const id = newId();
  await tx.insert(org.reservePayments).values({
    id,
    partId: part.id,
    taxYear: input.tax_year,
    date: input.date,
    amount: input.amount,
    note: input.note?.trim() || null,
    createdBy: a.userId,
    createdByActor: a.actor,
  });
  let result: SubmitResult | null = null;
  if (lines) {
    result = await submitEntryTx(
      tx,
      orgId,
      a,
      {
        date: input.date,
        memo: `${r.name}: ${part.label} payment for tax year ${input.tax_year}${bank ? "" : " (paid personally from a draw)"}`,
        lines: [
          { accountId: lines.debit, amount: input.amount, description: input.note?.trim() || null },
          { accountId: lines.credit, amount: -input.amount },
        ],
        sourceType: "reserve_payment",
        sourceId: id,
        rationale: input.rationale ?? null,
        lockOverrideNote: input.lock_override_note ?? null,
      },
      {
        reviewContext: {
          ...opts.reviewContext,
          reserve_payment: {
            payment_id: id,
            reserve_id: r.id,
            reserve_name: r.name,
            mode: r.mode,
            part_label: part.label,
            tax_year: input.tax_year,
            amount: input.amount,
          },
        },
      },
    );
    await tx
      .update(org.reservePayments)
      .set({ entryId: result.entry.id })
      .where(eq(org.reservePayments.id, id));
  }
  const row = (await tx.select().from(org.reservePayments).where(eq(org.reservePayments.id, id)).get())!;
  const payment = await paymentView(tx, row, part);
  await appendAudit(tx, orgId, a, {
    action: "reserve.payment.create",
    targetType: "reserve_payment",
    targetId: id,
    after: payment,
  });
  return { payment, result };
}

/**
 * Delete a payment record. Only one with no entry, a rejected entry, or a reversed entry: a payment
 * whose entry posted is in the books, so reverse the entry first.
 */
export async function deleteReservePaymentTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const row = await tx.select().from(org.reservePayments).where(eq(org.reservePayments.id, id)).get();
  if (!row) throw notFound("Reserve payment");
  const before = await paymentView(tx, row);
  if (!before.can_delete)
    throw conflict(
      before.entry_status === "pending_review"
        ? "This payment's entry is waiting in review. Reject it there, which removes the payment."
        : "This payment's entry is posted. Reverse the entry first, then delete the payment.",
      "payment_has_entry",
    );
  await tx.delete(org.reservePayments).where(eq(org.reservePayments.id, id));
  await appendAudit(tx, orgId, a, {
    action: "reserve.payment.delete",
    targetType: "reserve_payment",
    targetId: id,
    before,
  });
}

// A rejected payment entry means the payment wasn't made from the business: the record goes too.
onEntryRejected("reserve_payment", async (tx, orgId, e, a) => {
  if (e.reverses_entry_id) return;
  const row = await tx.select().from(org.reservePayments).where(eq(org.reservePayments.entryId, e.id)).get();
  if (!row) return;
  const before = await paymentView(tx, row);
  await tx.delete(org.reservePayments).where(eq(org.reservePayments.id, row.id));
  await appendAudit(tx, orgId, a, {
    action: "reserve.payment.delete",
    targetType: "reserve_payment",
    targetId: row.id,
    before,
    after: { reason: "entry_rejected", entry_id: e.id },
  });
});
