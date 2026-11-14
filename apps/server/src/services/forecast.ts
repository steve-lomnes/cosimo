/**
 * Cash forecast (#113): what cash the business will have over the coming weeks or months, and how
 * much the owner can draw. The forecast is computed on read from booked documents (open invoices
 * and bills, active recurring templates, entries waiting in review) plus planned items a person or
 * assistant typed in, with the rules of packages/core/src/forecast.ts.
 *
 * Forecast data is not a ledger record: scenarios, planned items, overrides, links, and saved
 * windows apply at once, are audited (`forecast.*`), and are shared by the whole org.
 *
 * - Each org has one baseline scenario, created on the first write (reads use defaults until then).
 *   A named scenario holds only its changes on top of the baseline: its own planned items,
 *   overrides of other items, and assumption overrides.
 * - Flows come from separate gatherers (`invoiceFlows`, `billFlows`, `templateFlows`,
 *   `pendingEntryFlows`, `plannedFlows`) so another source (reserves) can add its own.
 * - Matching a planned occurrence to an actual invoice, bill, or bank transaction is only ever
 *   suggested; a person (or assistant, in its own scenario) acts on it by creating a link.
 * - An agent (anything but a user) writes only to a scenario its own client created
 *   (`assertCanWriteScenario`); the baseline is changed by people, by promoting a scenario.
 */
import {
  applyOverrides,
  bucketRanges,
  buildForecast,
  DEFAULT_ASSUMPTIONS,
  describeSchedule,
  type Flow,
  FORECAST_BUCKETS,
  type ForecastAssumptions,
  type ForecastBucket,
  type ForecastCore,
  type ForecastOverride,
  type ForecastWindow,
  type ItemSchedule,
  itemOccurrences,
  MAX_FORECAST_PERIODS,
  occurrence,
  type Schedule,
  splitLate,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { addDays, diffDays, isIsoDate, today } from "@cosimo/shared";
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { listBankAccounts, mustGetBankAccount } from "./banking.ts";
import { mustGetContact } from "./contacts.ts";
import { openBalance } from "./documents.ts";
import { accountMap, type SubmitResult, submitEntryTx, systemAccountId } from "./ledger.ts";
import { bodyOf, scheduleOf, templateTotal } from "./recurring.ts";

type Reader = OrgDb | OrgTx;
export type ScenarioRow = typeof org.forecastScenarios.$inferSelect;
export type ItemRow = typeof org.forecastItems.$inferSelect;
export type OverrideRow = typeof org.forecastOverrides.$inferSelect;
export type LinkRow = typeof org.forecastLinks.$inferSelect;
export type WindowRow = typeof org.forecastWindows.$inferSelect;

/** The id a client may use for the baseline before it exists. */
export const BASELINE_ALIAS = "baseline";
export const OVERRIDE_TARGETS = [
  "invoice",
  "bill",
  "recurring_template",
  "forecast_item",
  "reserve_part",
] as const;
export type OverrideTarget = (typeof OVERRIDE_TARGETS)[number];
export const LINK_TARGETS = ["invoice", "bill", "bank_transaction"] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number];

/** Past planned occurrences count (today, flagged) for this long before they are forgotten. */
export const PLANNED_LOOKBACK_DAYS = 90;
export const PLANNED_STALE_DAYS = 60;
export const FEED_STALE_DAYS = 3;
const MATCH_AMOUNT_TOLERANCE = 0.1;
const MATCH_DOC_DAYS = 10;
const MATCH_TXN_DAYS = 7;

// ----------------------------------------------------------------------------- types

export interface ScenarioView {
  id: string;
  name: string;
  is_baseline: boolean;
  description: string | null;
  /** Only the values this scenario sets; the baseline's hold every value that differs from the default. */
  assumptions: Partial<ForecastAssumptions>;
  /** False for the baseline until the first write creates it. */
  exists: boolean;
  created_by_actor: string;
  created_by_client: string | null;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ItemView {
  id: string;
  scenario_id: string;
  kind: ItemRow["kind"];
  name: string;
  direction: ItemRow["direction"];
  amount: number;
  unit: ItemRow["unit"];
  interval: number;
  anchor_day: number | null;
  start_date: string;
  end_date: string | null;
  max_occurrences: number | null;
  schedule_text: string;
  next_date: string | null;
  account_id: string | null;
  contact_id: string | null;
  bank_account_id: string | null;
  notes: string | null;
  source: ItemRow["source"];
  created_by_actor: string;
  last_confirmed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OverrideView {
  id: string;
  scenario_id: string;
  target_type: OverrideTarget;
  target_id: string;
  target_date: string | null;
  action: OverrideRow["action"];
  shift_days: number | null;
  created_by_actor: string;
  created_at: string;
}

export interface LinkView {
  id: string;
  item_id: string;
  occurrence_date: string;
  status: LinkRow["status"];
  target_type: LinkRow["targetType"];
  target_id: string | null;
  created_by_actor: string;
  created_at: string;
}

export interface WindowView {
  id: string;
  name: string;
  bucket: ForecastBucket;
  periods: number;
  created_at: string;
}

export interface AttentionItem {
  kind:
    | "planned_past_due"
    | "planned_unconfirmed"
    | "invoice_overdue"
    | "bank_feed_stale"
    | "card_balance"
    | "suggested_match"
    | "template_overlap";
  message: string;
  /** The planned item, invoice, bank account, or template the message is about. */
  ref: string | null;
  item_id?: string;
  occurrence_date?: string;
  target_type?: LinkTarget;
  target_id?: string;
}

export interface Suggestion {
  item_id: string;
  item_name: string;
  occurrence_date: string;
  amount: number;
  target_type: LinkTarget;
  target_id: string;
  target_label: string;
  target_date: string;
  target_amount: number;
}

export interface ResolvedWindow extends ForecastWindow {
  /** `w13`, `m12`, a saved window's id, or `custom`. */
  key: string;
  name: string;
}

export interface ForecastResult extends ForecastCore {
  as_of: string;
  currency: string;
  scenario: { id: string; name: string; is_baseline: boolean };
  window: ResolvedWindow & { start: string; end: string };
  opening_cash: number;
  assumptions: ForecastAssumptions;
  attention: AttentionItem[];
  suggestions: Suggestion[];
}

export interface WindowSpec {
  window?: string | null;
  bucket?: ForecastBucket | null;
  periods?: number | null;
}

// ----------------------------------------------------------------------------- scenarios

function parseAssumptions(json: string): Partial<ForecastAssumptions> {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<ForecastAssumptions> = {};
    for (const k of Object.keys(DEFAULT_ASSUMPTIONS) as (keyof ForecastAssumptions)[])
      if (typeof v[k] === "number") out[k] = v[k];
    return out;
  } catch {
    return {};
  }
}

/** Checks and normalizes assumption values: only known keys; null clears one. */
export function checkAssumptions(
  input: Partial<Record<keyof ForecastAssumptions, number | null>>,
): Partial<ForecastAssumptions> {
  const limits: Record<keyof ForecastAssumptions, [number, number]> = {
    collection_lag_days: [0, 365],
    late_share_pct: [0, 100],
    late_days: [0, 365],
    min_cash_buffer: [0, Number.MAX_SAFE_INTEGER],
  };
  const out: Partial<ForecastAssumptions> = {};
  for (const [k, [lo, hi]] of Object.entries(limits) as [keyof ForecastAssumptions, [number, number]][]) {
    const v = input[k];
    if (v == null) continue;
    if (!Number.isInteger(v) || v < lo || v > hi)
      throw unprocessable(`${k} must be a whole number from ${lo} to ${hi}.`, "invalid_assumption");
    out[k] = v;
  }
  return out;
}

export function scenarioView(r: ScenarioRow): ScenarioView {
  return {
    id: r.id,
    name: r.name,
    is_baseline: r.isBaseline,
    description: r.description,
    assumptions: parseAssumptions(r.assumptionsJson),
    exists: true,
    created_by_actor: r.createdByActor,
    created_by_client: r.createdByClient,
    archived_at: r.archivedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

const VIRTUAL_BASELINE: ScenarioView = {
  id: BASELINE_ALIAS,
  name: "Baseline",
  is_baseline: true,
  description: null,
  assumptions: {},
  exists: false,
  created_by_actor: "system",
  created_by_client: null,
  archived_at: null,
  created_at: null,
  updated_at: null,
};

async function baselineRow(db: Reader) {
  return db.select().from(org.forecastScenarios).where(eq(org.forecastScenarios.isBaseline, true)).get();
}

export async function listScenarios(db: Reader, includeArchived = false): Promise<ScenarioView[]> {
  const rows = await db
    .select()
    .from(org.forecastScenarios)
    .where(includeArchived ? undefined : isNull(org.forecastScenarios.archivedAt))
    .orderBy(asc(org.forecastScenarios.createdAt), asc(org.forecastScenarios.id))
    .all();
  const base = rows.find((r) => r.isBaseline);
  return [
    base ? scenarioView(base) : VIRTUAL_BASELINE,
    ...rows.filter((r) => !r.isBaseline).map(scenarioView),
  ];
}

export async function mustGetScenario(db: Reader, id: string) {
  const r = await db.select().from(org.forecastScenarios).where(eq(org.forecastScenarios.id, id)).get();
  if (!r) throw notFound("Scenario");
  return r;
}

/** The scenario to read: the baseline when `id` is empty or the alias (null until it exists). */
async function scenarioForRead(db: Reader, id?: string | null): Promise<ScenarioRow | null> {
  if (!id || id === BASELINE_ALIAS) return (await baselineRow(db)) ?? null;
  return mustGetScenario(db, id);
}

/** The baseline, created now if this is the org's first forecast write. */
export async function ensureBaselineTx(tx: OrgTx, orgId: string, a: ActorInfo): Promise<ScenarioRow> {
  const existing = await baselineRow(tx);
  if (existing) return existing;
  const id = newId();
  await tx.insert(org.forecastScenarios).values({
    id,
    name: "Baseline",
    isBaseline: true,
    createdBy: a.userId,
    createdByActor: a.actor,
  });
  const row = await mustGetScenario(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.create",
    targetType: "forecast_scenario",
    targetId: id,
    after: scenarioView(row),
  });
  return row;
}

/** The OAuth client or API token behind an actor, null for a person or the system. */
function clientOf(a: ActorInfo) {
  return a.oauthClientId ?? a.apiTokenId ?? null;
}

/**
 * A person (any actor of kind `user`, or the system) may write any scenario; the caller checks
 * their role. Any other actor may write only a non-baseline scenario its own client created.
 */
export function assertCanWriteScenario(a: ActorInfo, s: ScenarioRow) {
  if (a.actor === "user" || a.actor === "system") return;
  if (s.isBaseline)
    throw forbidden(
      "An assistant can't change the baseline forecast. Create a scenario with create_forecast_scenario, put your changes there, and ask the person to promote it.",
      "baseline_protected",
    );
  const client = clientOf(a);
  if (!client || s.createdByClient !== client)
    throw forbidden(
      "This scenario was created by someone else. An assistant can change only scenarios its own connection created.",
      "scenario_not_owned",
    );
}

/** The scenario to write to (the baseline, created now, when `id` is empty), after the ownership check. */
async function writableScenarioTx(tx: OrgTx, orgId: string, a: ActorInfo, id?: string | null) {
  const base = await ensureBaselineTx(tx, orgId, a);
  const s = !id || id === BASELINE_ALIAS || id === base.id ? base : await mustGetScenario(tx, id);
  if (s.archivedAt) throw conflict("That scenario is archived.", "scenario_archived");
  assertCanWriteScenario(a, s);
  return s;
}

function cleanName(name: string, what: string) {
  const n = name.trim();
  if (!n) throw unprocessable(`${what} needs a name.`, "invalid_name");
  return n;
}

export async function createScenarioTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: {
    name: string;
    description?: string | null;
    assumptions?: Partial<Record<keyof ForecastAssumptions, number | null>>;
  },
) {
  await ensureBaselineTx(tx, orgId, a);
  const id = newId();
  await tx.insert(org.forecastScenarios).values({
    id,
    name: cleanName(input.name, "A scenario"),
    description: input.description ?? null,
    assumptionsJson: JSON.stringify(checkAssumptions(input.assumptions ?? {})),
    createdBy: a.userId,
    createdByActor: a.actor,
    createdByClient: clientOf(a),
  });
  const row = await mustGetScenario(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.create",
    targetType: "forecast_scenario",
    targetId: id,
    after: scenarioView(row),
  });
  return row;
}

export async function updateScenarioTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string | undefined,
  patch: {
    name?: string;
    description?: string | null;
    assumptions?: Partial<Record<keyof ForecastAssumptions, number | null>>;
  },
) {
  const s = await writableScenarioTx(tx, orgId, a, id);
  if (patch.name !== undefined && s.isBaseline)
    throw unprocessable("The baseline keeps its name.", "invalid_name");
  const set: Partial<typeof org.forecastScenarios.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) set.name = cleanName(patch.name, "A scenario");
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.assumptions) {
    // A null clears a value (the scenario falls back to the baseline's).
    const merged = { ...parseAssumptions(s.assumptionsJson) };
    for (const k of Object.keys(DEFAULT_ASSUMPTIONS) as (keyof ForecastAssumptions)[])
      if (patch.assumptions[k] === null) delete merged[k];
    Object.assign(merged, checkAssumptions(patch.assumptions));
    set.assumptionsJson = JSON.stringify(merged);
  }
  await tx.update(org.forecastScenarios).set(set).where(eq(org.forecastScenarios.id, s.id));
  const row = await mustGetScenario(tx, s.id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.update",
    targetType: "forecast_scenario",
    targetId: s.id,
    before: scenarioView(s),
    after: scenarioView(row),
  });
  return row;
}

export async function archiveScenarioTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const s = await mustGetScenario(tx, id);
  if (s.isBaseline) throw conflict("The baseline can't be archived.", "baseline_protected");
  assertCanWriteScenario(a, s);
  const now = new Date().toISOString();
  await tx
    .update(org.forecastScenarios)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(org.forecastScenarios.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.archive",
    targetType: "forecast_scenario",
    targetId: id,
    before: scenarioView(s),
  });
}

/** Copy a scenario's items, overrides, assumptions, and links into a new scenario. */
export async function duplicateScenarioTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  name?: string | null,
) {
  const src = id === BASELINE_ALIAS ? await baselineRow(tx) : await mustGetScenario(tx, id);
  if (!src || src.isBaseline)
    throw unprocessable(
      "The baseline is already the base of every scenario. Create a new scenario instead.",
      "baseline_protected",
    );
  const copy = await createScenarioTx(tx, orgId, a, {
    name: name?.trim() || `Copy of ${src.name}`,
    description: src.description,
  });
  await tx
    .update(org.forecastScenarios)
    .set({ assumptionsJson: src.assumptionsJson })
    .where(eq(org.forecastScenarios.id, copy.id));
  const items = await tx
    .select()
    .from(org.forecastItems)
    .where(and(eq(org.forecastItems.scenarioId, id), isNull(org.forecastItems.archivedAt)))
    .all();
  const ids = new Map<string, string>();
  for (const it of items) {
    const nid = newId();
    ids.set(it.id, nid);
    await tx.insert(org.forecastItems).values({
      ...it,
      id: nid,
      scenarioId: copy.id,
      createdBy: a.userId,
      createdByActor: a.actor,
      source: a.actor === "user" ? "person" : "assistant",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  if (ids.size) {
    const links = await tx
      .select()
      .from(org.forecastLinks)
      .where(inArray(org.forecastLinks.itemId, [...ids.keys()]))
      .all();
    for (const l of links)
      await tx.insert(org.forecastLinks).values({ ...l, id: newId(), itemId: ids.get(l.itemId)! });
  }
  for (const o of await tx
    .select()
    .from(org.forecastOverrides)
    .where(eq(org.forecastOverrides.scenarioId, id))
    .all()) {
    await tx.insert(org.forecastOverrides).values({
      ...o,
      id: newId(),
      scenarioId: copy.id,
      // An override of a copied item follows the copy.
      targetId: o.targetType === "forecast_item" ? (ids.get(o.targetId) ?? o.targetId) : o.targetId,
      createdBy: a.userId,
      createdByActor: a.actor,
    });
  }
  const row = await mustGetScenario(tx, copy.id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.duplicate",
    targetType: "forecast_scenario",
    targetId: copy.id,
    before: { source_id: id },
    after: scenarioView(row),
  });
  return row;
}

/**
 * Move the chosen items, overrides, and assumption values of a scenario into the baseline. Items
 * and overrides are re-parented, not copied. Only people do this.
 */
export async function promoteScenarioTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  sel: { item_ids?: string[]; override_ids?: string[]; assumptions?: boolean },
) {
  if (a.actor !== "user")
    throw forbidden("Only a person can promote a scenario to the baseline.", "baseline_protected");
  const s = await mustGetScenario(tx, id);
  if (s.isBaseline) throw unprocessable("The baseline can't be promoted into itself.", "baseline_protected");
  const base = await ensureBaselineTx(tx, orgId, a);
  const moved = { items: 0, overrides: 0, assumptions: [] as string[] };
  for (const itemId of sel.item_ids ?? []) {
    const it = await tx.select().from(org.forecastItems).where(eq(org.forecastItems.id, itemId)).get();
    if (!it || it.scenarioId !== id) throw unprocessable("An item isn't in this scenario.", "invalid_item");
    await tx
      .update(org.forecastItems)
      .set({ scenarioId: base.id, updatedAt: new Date().toISOString() })
      .where(eq(org.forecastItems.id, itemId));
    moved.items++;
  }
  for (const oid of sel.override_ids ?? []) {
    const o = await tx.select().from(org.forecastOverrides).where(eq(org.forecastOverrides.id, oid)).get();
    if (!o || o.scenarioId !== id)
      throw unprocessable("An override isn't in this scenario.", "invalid_override");
    // The promoted override replaces one the baseline already has for the same target.
    await tx
      .delete(org.forecastOverrides)
      .where(
        and(
          eq(org.forecastOverrides.scenarioId, base.id),
          eq(org.forecastOverrides.targetType, o.targetType),
          eq(org.forecastOverrides.targetId, o.targetId),
          eq(org.forecastOverrides.targetDate, o.targetDate),
        ),
      );
    await tx
      .update(org.forecastOverrides)
      .set({ scenarioId: base.id })
      .where(eq(org.forecastOverrides.id, oid));
    moved.overrides++;
  }
  if (sel.assumptions) {
    const mine = parseAssumptions(s.assumptionsJson);
    const theirs = parseAssumptions(base.assumptionsJson);
    moved.assumptions = Object.keys(mine);
    await tx
      .update(org.forecastScenarios)
      .set({ assumptionsJson: JSON.stringify({ ...theirs, ...mine }), updatedAt: new Date().toISOString() })
      .where(eq(org.forecastScenarios.id, base.id));
    await tx
      .update(org.forecastScenarios)
      .set({ assumptionsJson: "{}", updatedAt: new Date().toISOString() })
      .where(eq(org.forecastScenarios.id, id));
  }
  await appendAudit(tx, orgId, a, {
    action: "forecast.scenario.promote",
    targetType: "forecast_scenario",
    targetId: id,
    after: moved,
  });
  return moved;
}

// ----------------------------------------------------------------------------- planned items

export interface ItemInput {
  scenario_id?: string | null;
  kind?: ItemRow["kind"];
  name: string;
  direction: ItemRow["direction"];
  amount: number;
  /** Null (or left out) for a one-off on `start_date`. */
  unit?: ItemRow["unit"];
  interval?: number;
  anchor_day?: number | null;
  start_date: string;
  end_date?: string | null;
  max_occurrences?: number | null;
  account_id?: string | null;
  contact_id?: string | null;
  bank_account_id?: string | null;
  notes?: string | null;
}

export async function mustGetItem(db: Reader, id: string) {
  const r = await db.select().from(org.forecastItems).where(eq(org.forecastItems.id, id)).get();
  if (!r) throw notFound("Planned item");
  return r;
}

export function itemView(r: ItemRow, asOf = today()): ItemView {
  const sched = itemSchedule(r);
  let next: string | null = null;
  if (!r.unit) next = r.startDate >= asOf ? r.startDate : null;
  else next = itemOccurrences(sched, asOf, addDays(asOf, 3660))[0] ?? null;
  return {
    id: r.id,
    scenario_id: r.scenarioId,
    kind: r.kind,
    name: r.name,
    direction: r.direction,
    amount: r.amount,
    unit: r.unit,
    interval: r.interval,
    anchor_day: r.anchorDay,
    start_date: r.startDate,
    end_date: r.endDate,
    max_occurrences: r.maxOccurrences,
    schedule_text: r.unit ? describeSchedule({ ...sched, unit: r.unit }) : `Once on ${r.startDate}`,
    next_date: next,
    account_id: r.accountId,
    contact_id: r.contactId,
    bank_account_id: r.bankAccountId,
    notes: r.notes,
    source: r.source,
    created_by_actor: r.createdByActor,
    last_confirmed_at: r.lastConfirmedAt,
    archived_at: r.archivedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function itemSchedule(r: ItemRow): ItemSchedule {
  return {
    unit: r.unit,
    interval: r.interval,
    anchor_day: r.anchorDay,
    start_date: r.startDate,
    end_date: r.endDate,
    max_occurrences: r.maxOccurrences,
  };
}

async function checkItemRefs(
  tx: Reader,
  v: { account_id?: string | null; contact_id?: string | null; bank_account_id?: string | null },
) {
  if (v.account_id) {
    const a = await tx
      .select({ id: org.accounts.id })
      .from(org.accounts)
      .where(eq(org.accounts.id, v.account_id))
      .get();
    if (!a) throw unprocessable("Unknown account.", "unknown_account");
  }
  if (v.contact_id) await mustGetContact(tx, v.contact_id);
  if (v.bank_account_id) await mustGetBankAccount(tx, v.bank_account_id);
}

/** The values of an item row from validated input (the whole row; partial edits merge first). */
function itemValues(v: ItemInput) {
  const kind = v.kind ?? "planned";
  const unit = v.unit ?? null;
  if (!Number.isSafeInteger(v.amount) || v.amount <= 0)
    throw unprocessable("The amount must be positive.", "invalid_amount");
  if (kind === "draw" && v.direction !== "out")
    throw unprocessable("A planned draw is always money out.", "invalid_direction");
  if (!isIsoDate(v.start_date)) throw unprocessable("Enter a valid date.", "invalid_date");
  if (v.end_date != null && !isIsoDate(v.end_date))
    throw unprocessable("Enter a valid end date.", "invalid_date");
  const interval = v.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1)
    throw unprocessable("Repeat every 1 or more.", "invalid_interval");
  if (v.max_occurrences != null && (!Number.isInteger(v.max_occurrences) || v.max_occurrences < 1))
    throw unprocessable("The maximum number of times must be 1 or more.", "invalid_interval");
  const anchor = v.anchor_day ?? null;
  if (anchor != null) {
    if (unit !== "month" && unit !== "year")
      throw unprocessable("A day of the month applies to monthly and yearly repeats only.", "invalid_anchor");
    if (!Number.isInteger(anchor) || (anchor !== -1 && (anchor < 1 || anchor > 31)))
      throw unprocessable("The day of the month is 1 to 31, or -1 for the last day.", "invalid_anchor");
  }
  return {
    kind,
    name: cleanName(v.name, "A planned item"),
    direction: v.direction,
    amount: v.amount,
    unit,
    interval,
    anchorDay: anchor,
    startDate: v.start_date,
    endDate: unit ? (v.end_date ?? null) : null,
    maxOccurrences: unit ? (v.max_occurrences ?? null) : null,
    accountId: v.account_id ?? null,
    contactId: v.contact_id ?? null,
    bankAccountId: v.bank_account_id ?? null,
    notes: v.notes ?? null,
  };
}

export async function createItemTx(tx: OrgTx, orgId: string, a: ActorInfo, input: ItemInput) {
  const s = await writableScenarioTx(tx, orgId, a, input.scenario_id);
  const values = itemValues(input);
  await checkItemRefs(tx, input);
  const id = newId();
  await tx.insert(org.forecastItems).values({
    id,
    scenarioId: s.id,
    ...values,
    source: a.actor === "user" ? "person" : "assistant",
    createdBy: a.userId,
    createdByActor: a.actor,
  });
  const row = await mustGetItem(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.item.create",
    targetType: "forecast_item",
    targetId: id,
    after: itemView(row),
  });
  return row;
}

export async function updateItemTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  patch: Partial<Omit<ItemInput, "scenario_id">>,
) {
  const cur = await mustGetItem(tx, id);
  const s = await mustGetScenario(tx, cur.scenarioId);
  assertCanWriteScenario(a, s);
  if (cur.archivedAt) throw conflict("That planned item is archived.", "item_archived");
  const have = itemView(cur);
  const merged: ItemInput = {
    kind: cur.kind,
    name: cur.name,
    direction: cur.direction,
    amount: cur.amount,
    unit: cur.unit,
    interval: cur.interval,
    anchor_day: cur.anchorDay,
    start_date: cur.startDate,
    end_date: cur.endDate,
    max_occurrences: cur.maxOccurrences,
    account_id: cur.accountId,
    contact_id: cur.contactId,
    bank_account_id: cur.bankAccountId,
    notes: cur.notes,
  };
  for (const [k, v] of Object.entries(patch))
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  // Switching to a one-off drops the repeat fields.
  if (patch.unit === null) Object.assign(merged, { anchor_day: null, end_date: null, max_occurrences: null });
  const values = itemValues(merged);
  await checkItemRefs(tx, patch);
  await tx
    .update(org.forecastItems)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(org.forecastItems.id, id));
  const row = await mustGetItem(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "forecast.item.update",
    targetType: "forecast_item",
    targetId: id,
    before: have,
    after: itemView(row),
  });
  return row;
}

export async function archiveItemTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const cur = await mustGetItem(tx, id);
  assertCanWriteScenario(a, await mustGetScenario(tx, cur.scenarioId));
  if (cur.archivedAt) return cur;
  const now = new Date().toISOString();
  await tx
    .update(org.forecastItems)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(org.forecastItems.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.item.archive",
    targetType: "forecast_item",
    targetId: id,
    before: itemView(cur),
  });
  return mustGetItem(tx, id);
}

/** Say a planned item still holds, so it stops showing as unconfirmed. */
export async function confirmItemTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const cur = await mustGetItem(tx, id);
  assertCanWriteScenario(a, await mustGetScenario(tx, cur.scenarioId));
  const now = new Date().toISOString();
  await tx
    .update(org.forecastItems)
    .set({ lastConfirmedAt: now, updatedAt: now })
    .where(eq(org.forecastItems.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.item.confirm",
    targetType: "forecast_item",
    targetId: id,
    before: { last_confirmed_at: cur.lastConfirmedAt },
    after: { last_confirmed_at: now },
  });
  return mustGetItem(tx, id);
}

export async function listItems(db: Reader, scenarioId?: string | null, includeArchived = false) {
  const s = await scenarioForRead(db, scenarioId);
  if (!s) return [];
  const rows = await db
    .select()
    .from(org.forecastItems)
    .where(
      and(
        eq(org.forecastItems.scenarioId, s.id),
        includeArchived ? undefined : isNull(org.forecastItems.archivedAt),
      ),
    )
    .orderBy(asc(org.forecastItems.startDate), asc(org.forecastItems.id))
    .all();
  return rows.map((r) => itemView(r));
}

// ----------------------------------------------------------------------------- overrides

export function overrideView(r: OverrideRow): OverrideView {
  return {
    id: r.id,
    scenario_id: r.scenarioId,
    target_type: r.targetType as OverrideTarget,
    target_id: r.targetId,
    target_date: r.targetDate || null,
    action: r.action,
    shift_days: r.shiftDays,
    created_by_actor: r.createdByActor,
    created_at: r.createdAt,
  };
}

export async function listOverrides(db: Reader, scenarioId?: string | null) {
  const s = await scenarioForRead(db, scenarioId);
  if (!s) return [];
  const rows = await db
    .select()
    .from(org.forecastOverrides)
    .where(eq(org.forecastOverrides.scenarioId, s.id))
    .orderBy(asc(org.forecastOverrides.createdAt), asc(org.forecastOverrides.id))
    .all();
  return rows.map(overrideView);
}

async function assertTargetExists(tx: Reader, type: OverrideTarget, id: string) {
  const found =
    type === "invoice"
      ? await tx.select({ id: org.invoices.id }).from(org.invoices).where(eq(org.invoices.id, id)).get()
      : type === "bill"
        ? await tx.select({ id: org.bills.id }).from(org.bills).where(eq(org.bills.id, id)).get()
        : type === "recurring_template"
          ? await tx
              .select({ id: org.recurringTemplates.id })
              .from(org.recurringTemplates)
              .where(eq(org.recurringTemplates.id, id))
              .get()
          : type === "forecast_item"
            ? await tx
                .select({ id: org.forecastItems.id })
                .from(org.forecastItems)
                .where(eq(org.forecastItems.id, id))
                .get()
            : // reserve_part: checked by the reserves module once it exists.
              { id };
  if (!found) throw notFound("The item to override");
}

/** Exclude or shift something in a scenario; the same target again replaces the earlier override. */
export async function setOverrideTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: {
    scenario_id?: string | null;
    target_type: OverrideTarget;
    target_id: string;
    target_date?: string | null;
    action: "exclude" | "shift";
    shift_days?: number | null;
  },
) {
  const s = await writableScenarioTx(tx, orgId, a, input.scenario_id);
  await assertTargetExists(tx, input.target_type, input.target_id);
  if (input.target_date != null && !isIsoDate(input.target_date))
    throw unprocessable("Enter a valid date.", "invalid_date");
  if (input.action === "shift") {
    const d = input.shift_days;
    if (d == null || !Number.isInteger(d) || d === 0 || Math.abs(d) > 366)
      throw unprocessable("Shift by 1 to 366 days, earlier or later.", "invalid_shift");
  }
  const date = input.target_date ?? "";
  await tx
    .delete(org.forecastOverrides)
    .where(
      and(
        eq(org.forecastOverrides.scenarioId, s.id),
        eq(org.forecastOverrides.targetType, input.target_type),
        eq(org.forecastOverrides.targetId, input.target_id),
        eq(org.forecastOverrides.targetDate, date),
      ),
    );
  const id = newId();
  await tx.insert(org.forecastOverrides).values({
    id,
    scenarioId: s.id,
    targetType: input.target_type,
    targetId: input.target_id,
    targetDate: date,
    action: input.action,
    shiftDays: input.action === "shift" ? input.shift_days! : null,
    createdBy: a.userId,
    createdByActor: a.actor,
  });
  const row = (await tx.select().from(org.forecastOverrides).where(eq(org.forecastOverrides.id, id)).get())!;
  await appendAudit(tx, orgId, a, {
    action: "forecast.override.create",
    targetType: "forecast_override",
    targetId: id,
    after: overrideView(row),
  });
  return row;
}

export async function deleteOverrideTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const o = await tx.select().from(org.forecastOverrides).where(eq(org.forecastOverrides.id, id)).get();
  if (!o) throw notFound("Override");
  assertCanWriteScenario(a, await mustGetScenario(tx, o.scenarioId));
  await tx.delete(org.forecastOverrides).where(eq(org.forecastOverrides.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.override.delete",
    targetType: "forecast_override",
    targetId: id,
    before: overrideView(o),
  });
}

// ----------------------------------------------------------------------------- links

export function linkView(r: LinkRow): LinkView {
  return {
    id: r.id,
    item_id: r.itemId,
    occurrence_date: r.occurrenceDate,
    status: r.status,
    target_type: r.targetType,
    target_id: r.targetId || null,
    created_by_actor: r.createdByActor,
    created_at: r.createdAt,
  };
}

/**
 * Record what happened to one occurrence of a planned item. `linked` and `skipped` stop it
 * counting; `rejected` only hides that suggestion. Repeating a link returns the existing row.
 */
export async function createLinkTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  itemId: string,
  input: {
    occurrence_date: string;
    status: LinkRow["status"];
    target_type?: LinkTarget | null;
    target_id?: string | null;
  },
) {
  const item = await mustGetItem(tx, itemId);
  assertCanWriteScenario(a, await mustGetScenario(tx, item.scenarioId));
  if (!isIsoDate(input.occurrence_date)) throw unprocessable("Enter a valid date.", "invalid_date");
  if (!itemOccurrences(itemSchedule(item), input.occurrence_date, input.occurrence_date).length)
    throw unprocessable("The item has no occurrence on that date.", "invalid_occurrence");
  const needsTarget = input.status !== "skipped";
  if (needsTarget && (!input.target_type || !input.target_id))
    throw unprocessable("Name the invoice, bill, or bank transaction.", "invalid_target");
  if (!needsTarget && (input.target_type || input.target_id))
    throw unprocessable("A skipped occurrence has no target.", "invalid_target");
  const targetId = input.target_id ?? "";
  if (needsTarget) {
    const t = input.target_type!;
    const found =
      t === "invoice"
        ? await tx
            .select({ id: org.invoices.id })
            .from(org.invoices)
            .where(eq(org.invoices.id, targetId))
            .get()
        : t === "bill"
          ? await tx.select({ id: org.bills.id }).from(org.bills).where(eq(org.bills.id, targetId)).get()
          : await tx
              .select({ id: org.bankTransactions.id })
              .from(org.bankTransactions)
              .where(eq(org.bankTransactions.id, targetId))
              .get();
    if (!found) throw notFound("The invoice, bill, or bank transaction");
  }
  const same = await tx
    .select()
    .from(org.forecastLinks)
    .where(
      and(
        eq(org.forecastLinks.itemId, itemId),
        eq(org.forecastLinks.occurrenceDate, input.occurrence_date),
        eq(org.forecastLinks.status, input.status),
        eq(org.forecastLinks.targetId, targetId),
      ),
    )
    .get();
  if (same) return same;
  if (input.status !== "rejected") {
    const settled = await tx
      .select()
      .from(org.forecastLinks)
      .where(
        and(
          eq(org.forecastLinks.itemId, itemId),
          eq(org.forecastLinks.occurrenceDate, input.occurrence_date),
          ne(org.forecastLinks.status, "rejected"),
        ),
      )
      .get();
    if (settled)
      throw conflict(
        "That occurrence is already linked or skipped. Remove that first.",
        "occurrence_settled",
      );
  }
  if (input.status === "linked") {
    const taken = await tx
      .select({ id: org.forecastLinks.id })
      .from(org.forecastLinks)
      .where(
        and(
          eq(org.forecastLinks.status, "linked"),
          eq(org.forecastLinks.targetType, input.target_type!),
          eq(org.forecastLinks.targetId, targetId),
        ),
      )
      .get();
    if (taken) throw conflict("That document is already linked to a planned item.", "target_taken");
  }
  const id = newId();
  await tx.insert(org.forecastLinks).values({
    id,
    itemId,
    occurrenceDate: input.occurrence_date,
    status: input.status,
    targetType: needsTarget ? input.target_type! : null,
    targetId,
    createdBy: a.userId,
    createdByActor: a.actor,
  });
  const row = (await tx.select().from(org.forecastLinks).where(eq(org.forecastLinks.id, id)).get())!;
  await appendAudit(tx, orgId, a, {
    action: "forecast.link.create",
    targetType: "forecast_link",
    targetId: id,
    after: linkView(row),
  });
  return row;
}

export async function deleteLinkTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const l = await tx.select().from(org.forecastLinks).where(eq(org.forecastLinks.id, id)).get();
  if (!l) throw notFound("Link");
  const item = await mustGetItem(tx, l.itemId);
  assertCanWriteScenario(a, await mustGetScenario(tx, item.scenarioId));
  await tx.delete(org.forecastLinks).where(eq(org.forecastLinks.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.link.delete",
    targetType: "forecast_link",
    targetId: id,
    before: linkView(l),
  });
}

// ----------------------------------------------------------------------------- windows

export const BUILTIN_WINDOWS = [
  { id: "w13", name: "13 weeks", bucket: "week" as const, periods: 13 },
  { id: "m12", name: "12 months", bucket: "month" as const, periods: 12 },
];

export function windowView(r: WindowRow): WindowView {
  return { id: r.id, name: r.name, bucket: r.bucket, periods: r.periods, created_at: r.createdAt };
}

export async function listWindows(db: Reader) {
  const rows = await db
    .select()
    .from(org.forecastWindows)
    .orderBy(asc(org.forecastWindows.createdAt), asc(org.forecastWindows.id))
    .all();
  return rows.map(windowView);
}

function checkPeriods(bucket: string, periods: number) {
  if (!(FORECAST_BUCKETS as readonly string[]).includes(bucket))
    throw unprocessable("The bucket is week or month.", "invalid_window");
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_FORECAST_PERIODS)
    throw unprocessable(`Use 1 to ${MAX_FORECAST_PERIODS} periods.`, "invalid_window");
}

export async function createWindowTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: { name: string; bucket: ForecastBucket; periods: number },
) {
  checkPeriods(input.bucket, input.periods);
  const id = newId();
  await tx.insert(org.forecastWindows).values({
    id,
    name: cleanName(input.name, "A window"),
    bucket: input.bucket,
    periods: input.periods,
    createdBy: a.userId,
  });
  const row = (await tx.select().from(org.forecastWindows).where(eq(org.forecastWindows.id, id)).get())!;
  await appendAudit(tx, orgId, a, {
    action: "forecast.window.create",
    targetType: "forecast_window",
    targetId: id,
    after: windowView(row),
  });
  return row;
}

export async function deleteWindowTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const w = await tx.select().from(org.forecastWindows).where(eq(org.forecastWindows.id, id)).get();
  if (!w) throw notFound("Window");
  await tx.delete(org.forecastWindows).where(eq(org.forecastWindows.id, id));
  await appendAudit(tx, orgId, a, {
    action: "forecast.window.delete",
    targetType: "forecast_window",
    targetId: id,
    before: windowView(w),
  });
}

/** `w13`, `m12`, a saved window's id, or a custom bucket and period count; 13 weeks by default. */
export async function resolveWindow(db: Reader, spec: WindowSpec = {}): Promise<ResolvedWindow> {
  if (spec.bucket || spec.periods != null) {
    const bucket = spec.bucket ?? "week";
    const periods = spec.periods ?? 13;
    checkPeriods(bucket, periods);
    return { key: "custom", name: `${periods} ${bucket}s`, bucket, periods };
  }
  const key = spec.window || "w13";
  const builtin = BUILTIN_WINDOWS.find((w) => w.id === key);
  if (builtin) return { key, name: builtin.name, bucket: builtin.bucket, periods: builtin.periods };
  const w = await db.select().from(org.forecastWindows).where(eq(org.forecastWindows.id, key)).get();
  if (!w) throw notFound("Window");
  return { key: w.id, name: w.name, bucket: w.bucket, periods: w.periods };
}

// ----------------------------------------------------------------------------- flow gatherers

/** What the gatherers share: today, the window's last day, the assumptions, and the cash accounts. */
interface Ctx {
  db: Reader;
  today: string;
  end: string;
  assumptions: ForecastAssumptions;
  /** Ledger accounts of cash accounts (not cards or liability-typed ones), the dashboard's split. */
  cashAccounts: Set<string>;
}

const clamp = (d: string, t: string) => (d < t ? t : d);

async function invoiceFlows(c: Ctx): Promise<{ flows: Flow[]; overdue: AttentionItem[] }> {
  const rows = await c.db
    .select({
      id: org.invoices.id,
      number: org.invoices.number,
      dueDate: org.invoices.dueDate,
      customer: org.contacts.name,
    })
    .from(org.invoices)
    .innerJoin(org.contacts, eq(org.contacts.id, org.invoices.customerId))
    .where(and(inArray(org.invoices.status, ["sent", "partial"]), isNull(org.invoices.voidedAt)))
    .orderBy(asc(org.invoices.dueDate), asc(org.invoices.number))
    .all();
  const { collection_lag_days: lag, late_share_pct: pct, late_days: lateDays } = c.assumptions;
  const flows: Flow[] = [];
  const overdue: AttentionItem[] = [];
  for (const r of rows) {
    const { open } = await openBalance(c.db, "invoice", r.id, true);
    if (open <= 0) continue;
    const daysOverdue = Math.max(0, diffDays(c.today, r.dueDate));
    const due = addDays(r.dueDate, lag);
    const { late, onTime } = splitLate(open, pct);
    const base = {
      source: "invoice" as const,
      ref: r.id,
      firmness: "booked" as const,
      target: { type: "invoice", id: r.id },
      days_overdue: daysOverdue,
    };
    const label = `Invoice ${r.number} (${r.customer})`;
    if (onTime > 0)
      flows.push({ ...base, id: `inv:${r.id}`, date: clamp(due, c.today), amount: onTime, label });
    if (late > 0)
      flows.push({
        ...base,
        id: `inv:${r.id}:late`,
        date: clamp(addDays(due, lateDays), c.today),
        amount: late,
        label: `${label}, late share`,
      });
    if (daysOverdue > 0)
      overdue.push({
        kind: "invoice_overdue",
        ref: r.id,
        message: `Invoice ${r.number} (${r.customer}) is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue. The forecast counts ${(open / 100).toFixed(2)} as coming in ${due < c.today ? "today" : `on ${due}`}.`,
      });
  }
  return { flows, overdue };
}

async function billFlows(c: Ctx): Promise<Flow[]> {
  const rows = await c.db
    .select({
      id: org.bills.id,
      number: org.bills.billNumber,
      dueDate: org.bills.dueDate,
      vendor: org.contacts.name,
    })
    .from(org.bills)
    .innerJoin(org.contacts, eq(org.contacts.id, org.bills.vendorId))
    .where(and(inArray(org.bills.status, ["open", "partial"]), isNull(org.bills.voidedAt)))
    .orderBy(asc(org.bills.dueDate))
    .all();
  const flows: Flow[] = [];
  for (const r of rows) {
    const { open } = await openBalance(c.db, "bill", r.id, true);
    if (open <= 0) continue;
    flows.push({
      id: `bill:${r.id}`,
      date: clamp(r.dueDate, c.today),
      amount: -open,
      source: "bill",
      ref: r.id,
      label: `Bill ${r.number ? `${r.number} ` : ""}(${r.vendor})`,
      firmness: "booked",
      target: { type: "bill", id: r.id },
    });
  }
  return flows;
}

/** Occurrences are capped per template; a daily template over two years is the most a window holds. */
const MAX_TEMPLATE_OCCURRENCES = 800;

async function activeTemplates(db: Reader) {
  return db
    .select()
    .from(org.recurringTemplates)
    .where(eq(org.recurringTemplates.status, "active"))
    .orderBy(asc(org.recurringTemplates.name), asc(org.recurringTemplates.id))
    .all();
}

async function templateFlows(c: Ctx): Promise<Flow[]> {
  const flows: Flow[] = [];
  for (const t of await activeTemplates(c.db)) {
    const body = bodyOf(t);
    const s = scheduleOf(t);
    // A bill or invoice runs on the occurrence date and is due `due_days` later; an entry moves cash that day.
    let amount: number;
    let lag = 0;
    if (t.kind === "entry") {
      amount = body.lines.reduce(
        (sum, l) => sum + (c.cashAccounts.has(l.account_id) ? (l.amount ?? 0) : 0),
        0,
      );
    } else {
      const total = templateTotal(t.kind, body);
      amount = t.kind === "invoice" ? total : -total;
      lag = body.due_days ?? 0;
    }
    if (amount === 0) continue;
    for (let n = t.nextIndex, k = 0; k < MAX_TEMPLATE_OCCURRENCES; n++, k++) {
      const d = occurrence(s as Schedule, n);
      if (!d) break;
      const date = addDays(d, lag);
      if (d > c.end && date > c.end) break;
      flows.push({
        id: `tpl:${t.id}:${n}`,
        date: clamp(date, c.today),
        amount,
        source: "recurring",
        ref: t.id,
        label: t.name,
        firmness: "scheduled",
        target: { type: "recurring_template", id: t.id },
      });
    }
  }
  return flows;
}

/** Entries waiting in review that move cash: payments, categorizations, proposed owner draws. */
async function pendingEntryFlows(c: Ctx): Promise<Flow[]> {
  if (!c.cashAccounts.size) return [];
  const rows = await c.db
    .select({
      id: org.journalEntries.id,
      date: org.journalEntries.date,
      memo: org.journalEntries.memo,
      sourceType: org.journalEntries.sourceType,
      amount: sql<number>`sum(${org.journalLines.amount})`,
    })
    .from(org.journalEntries)
    .innerJoin(org.journalLines, eq(org.journalLines.entryId, org.journalEntries.id))
    .where(
      and(
        eq(org.journalEntries.status, "pending_review"),
        inArray(org.journalLines.accountId, [...c.cashAccounts]),
      ),
    )
    .groupBy(org.journalEntries.id)
    .orderBy(asc(org.journalEntries.date), asc(org.journalEntries.id))
    .all();
  return rows
    .filter((r) => Number(r.amount) !== 0)
    .map((r) => ({
      id: `pend:${r.id}`,
      date: clamp(r.date, c.today),
      amount: Number(r.amount),
      source: "pending" as const,
      ref: r.id,
      label: `${r.sourceType === "owner_draw" ? "Owner draw" : "Waiting in review"}: ${r.memo ?? r.sourceType}`,
      firmness: "pending" as const,
    }));
}

interface PlannedResult {
  flows: Flow[];
  attention: AttentionItem[];
  /** Unlinked occurrences, for suggested matching. */
  open: { item: ItemRow; date: string }[];
}

async function plannedFlows(c: Ctx, items: ItemRow[]): Promise<PlannedResult> {
  const out: PlannedResult = { flows: [], attention: [], open: [] };
  if (!items.length) return out;
  const links = await c.db
    .select()
    .from(org.forecastLinks)
    .where(
      inArray(
        org.forecastLinks.itemId,
        items.map((i) => i.id),
      ),
    )
    .all();
  const settled = new Set(
    links.filter((l) => l.status !== "rejected").map((l) => `${l.itemId}|${l.occurrenceDate}`),
  );
  const from = addDays(c.today, -PLANNED_LOOKBACK_DAYS);
  const staleBefore = addDays(c.today, -PLANNED_STALE_DAYS);
  for (const it of items) {
    let pastDue: string | null = null;
    // A repeating item's occurrences from before it was added are history, not money still
    // expected: a weekly item started in January and added today must not pile its past weeks
    // onto today. A one-off entered with a past date is still expected, so it keeps the lookback.
    const added = it.createdAt.slice(0, 10);
    const since = it.unit && added > from ? added : from;
    for (const d of itemOccurrences(itemSchedule(it), since, c.end)) {
      if (settled.has(`${it.id}|${d}`)) continue;
      out.open.push({ item: it, date: d });
      if (d < c.today) pastDue ??= d;
      out.flows.push({
        id: `item:${it.id}:${d}`,
        date: clamp(d, c.today),
        amount: it.direction === "in" ? it.amount : -it.amount,
        source: it.kind === "draw" ? "draw" : "planned",
        ref: it.id,
        label: it.name,
        firmness: it.kind === "draw" ? "draw" : "planned",
        target: { type: "forecast_item", id: it.id },
        last_confirmed_at: it.lastConfirmedAt,
      });
    }
    if (pastDue)
      out.attention.push({
        kind: "planned_past_due",
        ref: it.id,
        item_id: it.id,
        occurrence_date: pastDue,
        message: `${it.name} was planned for a date that has passed and isn't linked to anything. The forecast counts it today. Link it to what happened, mark it as skipped, or edit it.`,
      });
    if ((it.lastConfirmedAt ?? it.createdAt) < `${staleBefore}T00:00:00`)
      out.attention.push({
        kind: "planned_unconfirmed",
        ref: it.id,
        item_id: it.id,
        message: `${it.name} hasn't been confirmed in over ${PLANNED_STALE_DAYS} days. Confirm it still holds, or change or archive it.`,
      });
  }
  return out;
}

// ----------------------------------------------------------------------------- attention and suggestions

const within = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.abs(b) * tol;

/** The best invoice, bill, or bank transaction for each unlinked planned occurrence; never automatic. */
async function suggestMatches(c: Ctx, open: PlannedResult["open"]): Promise<Suggestion[]> {
  if (!open.length) return [];
  const lo = addDays(c.today, -PLANNED_LOOKBACK_DAYS - MATCH_DOC_DAYS);
  const hi = addDays(c.end, MATCH_DOC_DAYS);
  const invoices = await c.db
    .select()
    .from(org.invoices)
    .where(
      and(
        inArray(org.invoices.status, ["sent", "partial", "paid"]),
        isNull(org.invoices.voidedAt),
        lte(org.invoices.dueDate, hi),
        gte(org.invoices.dueDate, lo),
      ),
    )
    .all();
  const bills = await c.db
    .select()
    .from(org.bills)
    .where(
      and(
        inArray(org.bills.status, ["open", "partial", "paid"]),
        isNull(org.bills.voidedAt),
        lte(org.bills.dueDate, hi),
        gte(org.bills.dueDate, lo),
      ),
    )
    .all();
  const txns = await c.db
    .select()
    .from(org.bankTransactions)
    .where(
      and(
        ne(org.bankTransactions.status, "excluded"),
        gte(org.bankTransactions.date, addDays(c.today, -PLANNED_LOOKBACK_DAYS - MATCH_TXN_DAYS)),
        lte(org.bankTransactions.date, addDays(c.end, MATCH_TXN_DAYS)),
      ),
    )
    .all();
  const all = await c.db.select().from(org.forecastLinks).all();
  const taken = new Set(all.filter((l) => l.status === "linked").map((l) => `${l.targetType}|${l.targetId}`));
  const rejected = new Set(
    all
      .filter((l) => l.status === "rejected")
      .map((l) => `${l.itemId}|${l.occurrenceDate}|${l.targetType}|${l.targetId}`),
  );
  const used = new Set<string>();
  const out: Suggestion[] = [];
  for (const { item, date } of open) {
    const inflow = item.direction === "in";
    type Cand = Suggestion & { diff: number; apart: number };
    const cands: Cand[] = [];
    const consider = (
      type: LinkTarget,
      id: string,
      label: string,
      docDate: string,
      amount: number,
      apart: number,
      contactOk: boolean,
    ) => {
      const key = `${type}|${id}`;
      if (!contactOk || taken.has(key) || used.has(key)) return;
      if (rejected.has(`${item.id}|${date}|${type}|${id}`)) return;
      if (!within(amount, item.amount, MATCH_AMOUNT_TOLERANCE)) return;
      cands.push({
        item_id: item.id,
        item_name: item.name,
        occurrence_date: date,
        amount: item.amount,
        target_type: type,
        target_id: id,
        target_label: label,
        target_date: docDate,
        target_amount: amount,
        diff: Math.abs(amount - item.amount) / item.amount,
        apart,
      });
    };
    if (inflow) {
      for (const i of invoices) {
        const apart = Math.min(Math.abs(diffDays(i.dueDate, date)), Math.abs(diffDays(i.issueDate, date)));
        if (apart <= MATCH_DOC_DAYS)
          consider(
            "invoice",
            i.id,
            `Invoice ${i.number}`,
            i.dueDate,
            i.total,
            apart,
            !item.contactId || item.contactId === i.customerId,
          );
      }
    } else {
      for (const b of bills) {
        const apart = Math.min(Math.abs(diffDays(b.dueDate, date)), Math.abs(diffDays(b.issueDate, date)));
        if (apart <= MATCH_DOC_DAYS)
          consider(
            "bill",
            b.id,
            `Bill ${b.billNumber ?? ""}`.trim(),
            b.dueDate,
            b.total,
            apart,
            !item.contactId || item.contactId === b.vendorId,
          );
      }
    }
    for (const t of txns) {
      if (inflow ? t.amount <= 0 : t.amount >= 0) continue;
      const apart = Math.abs(diffDays(t.date, date));
      if (apart <= MATCH_TXN_DAYS)
        consider(
          "bank_transaction",
          t.id,
          `Bank transaction: ${t.description}`,
          t.date,
          Math.abs(t.amount),
          apart,
          true,
        );
    }
    cands.sort((x, y) => x.diff - y.diff || x.apart - y.apart || x.target_id.localeCompare(y.target_id));
    const best = cands[0];
    if (!best) continue;
    used.add(`${best.target_type}|${best.target_id}`);
    const { diff: _d, apart: _a, ...s } = best;
    out.push(s);
  }
  return out;
}

async function attentionFromBooks(c: Ctx, items: ItemRow[]): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  const banks = await listBankAccounts(c.db);
  const types = await accountMap(c.db);
  const named = new Set(items.map((i) => i.bankAccountId).filter(Boolean));
  const stale = new Date(`${c.today}T00:00:00Z`).getTime() - FEED_STALE_DAYS * 86_400_000;
  for (const b of banks) {
    if (!b.is_active) continue;
    const isCard = b.kind === "credit_card" || types.get(b.ledger_account_id)?.type === "liability";
    if (isCard) {
      if (b.balance !== 0 && !named.has(b.id))
        out.push({
          kind: "card_balance",
          ref: b.id,
          message: `${b.name} owes ${(b.balance / 100).toFixed(2)}. Card balances aren't projected, so a payment toward it isn't in the forecast unless you plan one.`,
        });
      continue;
    }
    if (!b.connection_id) continue;
    const last = b.last_successful_sync_at ? Date.parse(b.last_successful_sync_at) : null;
    if (b.last_sync_status === "error" || last === null || last < stale)
      out.push({
        kind: "bank_feed_stale",
        ref: b.id,
        message: `${b.name}'s bank feed ${b.last_sync_status === "error" ? "is in error" : `hasn't synced successfully in ${FEED_STALE_DAYS} days`}, so its balance may be out of date.`,
      });
  }
  // A planned item that looks like something a recurring template already creates.
  const templates = await activeTemplates(c.db);
  for (const it of items) {
    if (it.kind === "draw") continue;
    for (const t of templates) {
      if (t.kind === "entry" || (t.kind === "invoice") !== (it.direction === "in")) continue;
      const body = bodyOf(t);
      const sameParty =
        (it.contactId && t.contactId === it.contactId) ||
        (it.accountId && body.lines.some((l) => l.account_id === it.accountId));
      if (sameParty && within(it.amount, templateTotal(t.kind, body), MATCH_AMOUNT_TOLERANCE)) {
        out.push({
          kind: "template_overlap",
          ref: it.id,
          item_id: it.id,
          message: `${it.name} looks like the recurring ${t.kind} "${t.name}", which is already in the forecast. Archive the planned item to avoid counting it twice.`,
        });
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- the forecast

async function cashAccountIds(db: Reader) {
  const types = await accountMap(db);
  const banks = await listBankAccounts(db);
  const ids = new Set<string>();
  let total = 0;
  for (const b of banks) {
    if (!b.is_active && b.balance === 0) continue;
    const isLiability = b.kind === "credit_card" || types.get(b.ledger_account_id)?.type === "liability";
    if (isLiability) continue;
    ids.add(b.ledger_account_id);
    total += b.balance;
  }
  return { ids, total };
}

export interface ForecastQuery extends WindowSpec {
  scenario_id?: string | null;
}

/** Items and overrides in effect for a scenario: the baseline's, then the scenario's own. */
async function overlay(db: Reader, scenario: ScenarioRow | null) {
  const base = await baselineRow(db);
  const scenarios = [...new Set([base?.id, scenario?.id].filter((x): x is string => Boolean(x)))];
  const items = scenarios.length
    ? await db
        .select()
        .from(org.forecastItems)
        .where(and(inArray(org.forecastItems.scenarioId, scenarios), isNull(org.forecastItems.archivedAt)))
        .orderBy(asc(org.forecastItems.startDate), asc(org.forecastItems.id))
        .all()
    : [];
  // The scenario's overrides come first, so they win over the baseline's for the same target.
  const overrideRows = scenarios.length
    ? await db
        .select()
        .from(org.forecastOverrides)
        .where(inArray(org.forecastOverrides.scenarioId, scenarios))
        .all()
    : [];
  overrideRows.sort((x, y) => Number(y.scenarioId === scenario?.id) - Number(x.scenarioId === scenario?.id));
  const overrides: ForecastOverride[] = overrideRows.map((o) => ({
    target_type: o.targetType,
    target_id: o.targetId,
    target_date: o.targetDate,
    action: o.action,
    shift_days: o.shiftDays,
  }));
  const assumptions: ForecastAssumptions = {
    ...DEFAULT_ASSUMPTIONS,
    ...(base ? parseAssumptions(base.assumptionsJson) : {}),
    ...(scenario && !scenario.isBaseline ? parseAssumptions(scenario.assumptionsJson) : {}),
  };
  return { items, overrides, assumptions };
}

export async function forecast(db: Reader, q: ForecastQuery = {}, asOf = today()): Promise<ForecastResult> {
  const scenario = await scenarioForRead(db, q.scenario_id);
  const window = await resolveWindow(db, q);
  const ov = await overlay(db, scenario);
  const cash = await cashAccountIds(db);
  const settings = await db.select().from(org.orgSettings).where(eq(org.orgSettings.id, 1)).get();
  const ranges = bucketRanges(asOf, window.bucket, window.periods);
  const c: Ctx = {
    db,
    today: asOf,
    end: ranges[ranges.length - 1]!.end,
    assumptions: ov.assumptions,
    cashAccounts: cash.ids,
  };

  const inv = await invoiceFlows(c);
  const planned = await plannedFlows(c, ov.items);
  const flows = applyOverrides(
    [
      ...inv.flows,
      ...(await billFlows(c)),
      ...(await templateFlows(c)),
      ...(await pendingEntryFlows(c)),
      ...planned.flows,
    ],
    ov.overrides,
  );
  const core = buildForecast({
    today: asOf,
    window,
    openingCash: cash.total,
    flows,
    assumptions: ov.assumptions,
  });

  const suggestions = await suggestMatches(c, planned.open);
  const attention: AttentionItem[] = [
    ...planned.attention,
    ...inv.overdue,
    ...(await attentionFromBooks(c, ov.items)),
    ...suggestions.map(
      (s): AttentionItem => ({
        kind: "suggested_match",
        ref: s.item_id,
        item_id: s.item_id,
        occurrence_date: s.occurrence_date,
        target_type: s.target_type,
        target_id: s.target_id,
        message: `${s.item_name} on ${s.occurrence_date} may be ${s.target_label} (${(s.target_amount / 100).toFixed(2)} on ${s.target_date}). Link it, or say it isn't.`,
      }),
    ),
  ];
  return {
    ...core,
    as_of: asOf,
    currency: settings?.baseCurrency ?? "USD",
    scenario: scenario
      ? { id: scenario.id, name: scenario.name, is_baseline: scenario.isBaseline }
      : { id: BASELINE_ALIAS, name: "Baseline", is_baseline: true },
    window: { ...window, start: core.start, end: core.end },
    opening_cash: cash.total,
    assumptions: ov.assumptions,
    attention,
    suggestions,
  };
}

// ----------------------------------------------------------------------------- owner draws

/** What a draw proposal records for the reviewer: the forecast at the moment it was proposed. */
export function forecastSnapshot(f: ForecastResult, amount: number) {
  return {
    computed_at: new Date().toISOString(),
    scenario: f.scenario,
    window: f.window,
    opening_cash: f.opening_cash,
    low_point: f.low_point,
    draw_capacity: f.draw_capacity,
    assumptions: f.assumptions,
    drivers: f.drivers.slice(0, 5),
    attention_count: f.attention.length,
    exceeds_capacity: amount > f.draw_capacity.amount,
  };
}

export type ForecastSnapshot = ReturnType<typeof forecastSnapshot>;

/**
 * Propose an owner draw: Dr Owner Draw / Cr the bank account's ledger account, through the review
 * policy, with the forecast the server computed attached to the review item. A draw over capacity
 * is never refused; the result says so.
 */
export async function proposeOwnerDrawTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: {
    date: string;
    amount: number;
    bank_account_id: string;
    memo?: string | null;
    scenario_id?: string | null;
    window?: WindowSpec;
    rationale?: string | null;
    lock_override_note?: string | null;
  },
): Promise<{ result: SubmitResult; forecast_snapshot: ForecastSnapshot; exceeds_capacity: boolean }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw unprocessable("The draw must be a positive amount.", "invalid_amount");
  if (!isIsoDate(input.date)) throw unprocessable("Enter a valid date.", "invalid_date");
  const bank = await mustGetBankAccount(tx, input.bank_account_id);
  const f = await forecast(tx, { scenario_id: input.scenario_id, ...input.window });
  const snapshot = forecastSnapshot(f, input.amount);
  const result = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: input.date,
      memo: input.memo?.trim() || "Owner draw",
      lines: [
        { accountId: await systemAccountId(tx, "owner_draw"), amount: input.amount },
        { accountId: bank.ledgerAccountId, amount: -input.amount },
      ],
      sourceType: "owner_draw",
      rationale: input.rationale ?? null,
      lockOverrideNote: input.lock_override_note ?? null,
    },
    { reviewContext: { forecast_snapshot: snapshot } },
  );
  return { result, forecast_snapshot: snapshot, exceeds_capacity: snapshot.exceeds_capacity };
}
