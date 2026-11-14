/**
 * Cash forecast (#113). Pure, shared by the server and tests: bucket ranges, planned-item
 * occurrences, the late-payment split, scenario overrides, and the roll-up of flows into buckets,
 * the low point, and how much can be drawn. All amounts are integer cents; a flow's amount is
 * signed (positive is money in).
 */
import { addDays, type IsoDate, parseIsoDate } from "@cosimo/shared";
import { firstIndexOnOrAfter, occurrence, type Schedule } from "./recurrence.ts";

export const FORECAST_BUCKETS = ["week", "month"] as const;
export type ForecastBucket = (typeof FORECAST_BUCKETS)[number];
export const MAX_FORECAST_PERIODS = 104;

/** How firm a flow is, from a booked document to a plan someone typed in. */
export const FIRMNESS = ["booked", "scheduled", "pending", "planned", "draw", "reserve"] as const;
export type Firmness = (typeof FIRMNESS)[number];

export interface ForecastWindow {
  bucket: ForecastBucket;
  periods: number;
}

export interface ForecastAssumptions {
  /** Days added to an open invoice's due date before the money is expected. */
  collection_lag_days: number;
  /** Share (0-100) of each open invoice that arrives `late_days` later still. */
  late_share_pct: number;
  late_days: number;
  /** Cash to keep on hand, in cents. */
  min_cash_buffer: number;
}

export const DEFAULT_ASSUMPTIONS: ForecastAssumptions = {
  collection_lag_days: 0,
  late_share_pct: 0,
  late_days: 30,
  min_cash_buffer: 0,
};

/** What a flow comes from, for overrides: a booked document, a template, a planned item, a reserve part. */
export interface FlowTarget {
  type: string;
  id: string;
  /** Only `reserve_part` flows: the due date an override matches. */
  date?: string;
}

export interface Flow {
  /** Unique within one forecast, for keys and drilling in. */
  id: string;
  date: IsoDate;
  /** Signed cents: positive is money in. */
  amount: number;
  source: "invoice" | "bill" | "recurring" | "pending" | "planned" | "draw" | "reserve";
  ref: string | null;
  label: string;
  firmness: Firmness;
  target?: FlowTarget;
  /** Planned items: when a person last said it still holds. */
  last_confirmed_at?: string | null;
  /** Invoices: days past the due date today. */
  days_overdue?: number | null;
}

export interface ForecastOverride {
  target_type: string;
  target_id: string;
  /** '' matches every date. */
  target_date?: string | null;
  action: "exclude" | "shift";
  shift_days?: number | null;
}

export interface BucketRange {
  start: IsoDate;
  end: IsoDate;
}

function weekdayOf(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function monthEnd(d: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(d);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/**
 * Buckets starting today. Weekly buckets run Monday to Sunday and the first is today through
 * Sunday; monthly buckets are calendar months and the first is today through the month's end.
 */
export function bucketRanges(today: IsoDate, bucket: ForecastBucket, periods: number): BucketRange[] {
  const out: BucketRange[] = [];
  let start = today;
  for (let i = 0; i < periods; i++) {
    const end = bucket === "week" ? addDays(start, (7 - weekdayOf(start)) % 7) : monthEnd(start);
    out.push({ start, end });
    start = addDays(end, 1);
  }
  return out;
}

/** A planned item's schedule: `unit` null is a one-off on `start_date`. */
export interface ItemSchedule {
  unit: Schedule["unit"] | null;
  interval: number;
  anchor_day?: number | null;
  start_date: IsoDate;
  end_date?: IsoDate | null;
  max_occurrences?: number | null;
}

/** Dates of an item's occurrences from `from` to `to`, both inclusive. */
export function itemOccurrences(item: ItemSchedule, from: IsoDate, to: IsoDate): IsoDate[] {
  if (to < from) return [];
  if (!item.unit) return item.start_date >= from && item.start_date <= to ? [item.start_date] : [];
  const s: Schedule = { ...item, unit: item.unit };
  const out: IsoDate[] = [];
  // The cap guards a daily item over a long span; no schedule needs more in one window.
  for (let n = firstIndexOnOrAfter(s, from), k = 0; k < 5000; n++, k++) {
    const d = occurrence(s, n);
    if (!d || d > to) break;
    out.push(d);
  }
  return out;
}

/** Split an amount into the part that is late (rounded) and the part that comes on time. */
export function splitLate(amount: number, pct: number): { late: number; onTime: number } {
  const late = Math.round((amount * pct) / 100);
  return { late, onTime: amount - late };
}

/** Apply a scenario's exclude and shift overrides to flows that carry a `target`. */
export function applyOverrides(flows: Flow[], overrides: ForecastOverride[]): Flow[] {
  if (!overrides.length) return flows;
  const out: Flow[] = [];
  for (const f of flows) {
    const t = f.target;
    const o = t
      ? (overrides.find(
          (x) => x.target_type === t.type && x.target_id === t.id && (x.target_date || "") === (t.date ?? ""),
        ) ?? overrides.find((x) => x.target_type === t.type && x.target_id === t.id && !x.target_date))
      : undefined;
    if (!o) out.push(f);
    else if (o.action === "shift") out.push({ ...f, date: addDays(f.date, o.shift_days ?? 0) });
    // exclude: dropped
  }
  return out;
}

export interface ForecastBucketResult extends BucketRange {
  inflow: number;
  /** Money out, as a positive amount. */
  outflow: number;
  net: number;
  ending: number;
  flows: Flow[];
}

export interface LowPoint {
  balance: number;
  date: IsoDate;
}

export interface DrawCapacity {
  amount: number;
  breakdown: { low_point: number; buffer: number };
  /** The largest outflows dated on or before the low point. */
  binding: Flow[];
}

export interface ForecastCore {
  start: IsoDate;
  end: IsoDate;
  buckets: ForecastBucketResult[];
  low_point: LowPoint;
  draw_capacity: DrawCapacity;
  drivers: Flow[];
}

const byAbsDesc = (a: Flow, b: Flow) =>
  Math.abs(b.amount) - Math.abs(a.amount) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

export function buildForecast(input: {
  today: IsoDate;
  window: ForecastWindow;
  openingCash: number;
  flows: Flow[];
  assumptions: Pick<ForecastAssumptions, "min_cash_buffer">;
}): ForecastCore {
  const { today, openingCash } = input;
  const ranges = bucketRanges(today, input.window.bucket, input.window.periods);
  const start = ranges[0]!.start;
  const end = ranges[ranges.length - 1]!.end;
  // A date before today is money still expected (or owed): it lands today.
  const flows = input.flows
    .map((f) => (f.date < today ? { ...f, date: today } : f))
    .filter((f) => f.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const buckets: ForecastBucketResult[] = [];
  let i = 0;
  let balance = openingCash;
  let low: LowPoint = { balance: openingCash, date: today };
  for (const r of ranges) {
    const b: ForecastBucketResult = { ...r, inflow: 0, outflow: 0, net: 0, ending: 0, flows: [] };
    for (; i < flows.length && flows[i]!.date <= r.end; i++) {
      const f = flows[i]!;
      b.flows.push(f);
      if (f.amount >= 0) b.inflow += f.amount;
      else b.outflow -= f.amount;
      balance += f.amount;
      // The balance a day closes at: wait for the last flow of the date.
      if (flows[i + 1]?.date !== f.date && balance < low.balance) low = { balance, date: f.date };
    }
    b.net = b.inflow - b.outflow;
    b.ending = balance;
    buckets.push(b);
  }

  const buffer = Math.max(0, input.assumptions.min_cash_buffer);
  const binding = flows
    .filter((f) => f.amount < 0 && f.date <= low.date)
    .sort(byAbsDesc)
    .slice(0, 5);
  return {
    start,
    end,
    buckets,
    low_point: low,
    draw_capacity: {
      amount: Math.max(0, low.balance - buffer),
      breakdown: { low_point: low.balance, buffer },
      binding,
    },
    drivers: [...flows].sort(byAbsDesc).slice(0, 10),
  };
}
