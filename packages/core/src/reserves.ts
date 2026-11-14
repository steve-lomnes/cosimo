/**
 * Reserves (#114). Pure, shared by the server and tests: tax years, due dates, a part's target,
 * the projected annual amount, and the outflows a reserve adds to the cash forecast. Cosimo never
 * computes tax: the person supplies the rates and due dates, and the base is net income. Amounts are
 * integer cents; rates are basis points (1% = 100).
 */
import { addDays, daysInMonth, diffDays, type IsoDate, parseIsoDate } from "@cosimo/shared";
import type { Flow } from "./forecast.ts";

export const RESERVE_MODES = ["track", "book"] as const;
export type ReserveMode = (typeof RESERVE_MODES)[number];
export const RESERVE_BASES = ["net_income"] as const;
export type ReserveBase = (typeof RESERVE_BASES)[number];
export const TRUE_UP_SCHEDULES = ["manual", "monthly"] as const;
export type TrueUpSchedule = (typeof TRUE_UP_SCHEDULES)[number];
export const MAX_RATE_BP = 10_000;

/**
 * A due date as a month and day. `year_offset` 0 is the date inside the tax year; 1 is the same date
 * a year later (a January installment that belongs to the year before).
 */
export interface DueDate {
  month: number;
  day: number;
  year_offset: 0 | 1;
}

const iso = (y: number, m: number, d: number): IsoDate =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The tax year (named by the calendar year it starts in) that a date falls in. */
export function taxYearOf(date: IsoDate, startMonth: number): number {
  const { year, month } = parseIsoDate(date);
  return month >= startMonth ? year : year - 1;
}

/** First and last day of tax year `year`. */
export function taxYearRange(year: number, startMonth: number): { start: IsoDate; end: IsoDate } {
  const start = iso(year, startMonth, 1);
  return { start, end: addDays(iso(year + 1, startMonth, 1), -1) };
}

/** A problem with a due date, or null when it is valid. Feb 29 is allowed (it becomes Feb 28). */
export function dueDateError(d: DueDate): string | null {
  if (!Number.isInteger(d.month) || d.month < 1 || d.month > 12) return "The month is 1 to 12.";
  if (d.year_offset !== 0 && d.year_offset !== 1) return "The year offset is 0 or 1.";
  if (!Number.isInteger(d.day) || d.day < 1 || d.day > daysInMonth(2024, d.month))
    return `Day ${d.day} isn't in month ${d.month}.`;
  return null;
}

/** The dates of a part's due dates for tax year `year`, sorted. */
export function dueDatesFor(part: { due_dates: DueDate[] }, year: number, startMonth: number): IsoDate[] {
  const out = part.due_dates.map((d) => {
    // A month before the start month falls in the calendar year after the one the tax year starts in.
    const y = year + (d.month >= startMonth ? 0 : 1) + d.year_offset;
    return iso(y, d.month, Math.min(d.day, daysInMonth(y, d.month)));
  });
  return [...new Set(out)].sort();
}

/** The amount a part should have set aside: the rate of net income, never below zero. */
export function partTarget(netIncome: number, rateBp: number): number {
  return Math.round((Math.max(0, netIncome) * rateBp) / MAX_RATE_BP);
}

/**
 * The part's target for the whole year, if net income keeps its pace: the target scaled by the
 * days in the year over the days elapsed (at least 1). After the year ends it is the target.
 */
export function projectedAnnual(
  netIncome: number,
  rateBp: number,
  range: { start: IsoDate; end: IsoDate },
  asOf: IsoDate,
): number {
  const days = diffDays(range.end, range.start) + 1;
  const to = asOf < range.end ? asOf : range.end;
  const elapsed = Math.max(1, diffDays(to, range.start) + 1);
  return Math.round((Math.max(0, netIncome) * rateBp * days) / (elapsed * MAX_RATE_BP));
}

export interface Installment {
  date: IsoDate;
  amount: number;
}

/**
 * The installments of one tax year still to come (dated on or after `asOf`). The next one takes
 * what is owed now (`target − paid`); the later ones share what the rest of the year is projected
 * to add (`projected − target`) evenly, the last taking the remainder. For a year that has ended
 * `projected` equals `target`, so only the next date carries an amount.
 */
export function yearInstallments(input: {
  dates: IsoDate[];
  asOf: IsoDate;
  target: number;
  paid: number;
  projected: number;
}): Installment[] {
  const dates = input.dates.filter((d) => d >= input.asOf);
  if (!dates.length) return [];
  const out: Installment[] = [{ date: dates[0]!, amount: Math.max(0, input.target - input.paid) }];
  const later = dates.slice(1);
  if (later.length) {
    const rest = Math.max(0, input.projected - input.target);
    const each = Math.floor(rest / later.length);
    for (const [i, date] of later.entries())
      out.push({ date, amount: i === later.length - 1 ? rest - each * (later.length - 1) : each });
  }
  return out;
}

/** What the forecast needs to know about one part. */
export interface ReservePartState {
  id: string;
  label: string;
  rate_bp: number;
  due_dates: DueDate[];
  /** Payments attributed to the current tax year, and to the one before. */
  paid: number;
  prev_paid: number;
}

export interface ReserveFlowsInput {
  reserve: { id: string; name: string; tax_year_start_month: number };
  parts: ReservePartState[];
  today: IsoDate;
  /** Net income of the current tax year to date, and of the whole previous tax year. */
  net_income: number;
  prev_net_income: number;
}

/**
 * The reserve's outflows for the forecast (firmness `reserve`): each part's installments of the
 * current tax year, plus the previous year's installments still to come (its `year_offset` 1
 * dates on or after today). Zero amounts are left out. The flow ids carry the part and tax year
 * (`res:<part>:<year>:<date>`), and `target` names the part and date for overrides.
 */
export function reserveFlows(input: ReserveFlowsInput): Flow[] {
  const { reserve, today } = input;
  const year = taxYearOf(today, reserve.tax_year_start_month);
  const range = taxYearRange(year, reserve.tax_year_start_month);
  const flows: Flow[] = [];
  for (const p of input.parts) {
    const target = partTarget(input.net_income, p.rate_bp);
    const prevTarget = partTarget(input.prev_net_income, p.rate_bp);
    const years = [
      {
        y: year - 1,
        list: yearInstallments({
          dates: dueDatesFor(p, year - 1, reserve.tax_year_start_month),
          asOf: today,
          target: prevTarget,
          paid: p.prev_paid,
          projected: prevTarget,
        }),
      },
      {
        y: year,
        list: yearInstallments({
          dates: dueDatesFor(p, year, reserve.tax_year_start_month),
          asOf: today,
          target,
          paid: p.paid,
          projected: projectedAnnual(input.net_income, p.rate_bp, range, today),
        }),
      },
    ];
    for (const { y, list } of years)
      for (const it of list) {
        if (it.amount <= 0) continue;
        flows.push({
          id: `res:${p.id}:${y}:${it.date}`,
          date: it.date,
          amount: -it.amount,
          source: "reserve",
          ref: reserve.id,
          label: `${reserve.name}: ${p.label} (tax year ${y})`,
          firmness: "reserve",
          target: { type: "reserve_part", id: p.id, date: it.date },
          tax_year: y,
        });
      }
  }
  return flows;
}

/**
 * What reserves still owe now that the forecast window doesn't pay: for each part,
 * `max(0, (target − paid) − Σ its current-year reserve outflows in the window)`, where the current
 * year is the part's `tax_year`. Pass the flows after overrides, so an excluded or shifted
 * installment counts as not in the window. A flow dated before today counts (the forecast moves it
 * to today).
 */
export function reservesNotInWindow(
  parts: { id: string; tax_year: number; target: number; paid: number }[],
  flows: Flow[],
  end: IsoDate,
): number {
  let total = 0;
  for (const p of parts) {
    const inWindow = flows
      .filter(
        (f) =>
          f.source === "reserve" &&
          f.target?.type === "reserve_part" &&
          f.target.id === p.id &&
          f.tax_year === p.tax_year &&
          f.date <= end,
      )
      .reduce((s, f) => s - f.amount, 0);
    total += Math.max(0, p.target - p.paid - inWindow);
  }
  return total;
}
