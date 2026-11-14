/**
 * Geometry for the projected-cash chart: the balance at the end of each day that moves cash,
 * round y-axis ticks, and date ticks. Pure, so it is tested without a browser.
 */
import type { ForecastFlow } from "./forecast";

export type ChartStep = {
  /** The day; the first step is the opening balance on the forecast's first day. */
  date: string;
  /** Balance at the end of the day. */
  balance: number;
  /** What moved cash that day (empty for the opening step). */
  flows: ForecastFlow[];
};

/** Opening balance, then one step per day with a net movement, in date order. */
export function balanceSteps(opening: number, start: string, flows: ForecastFlow[]): ChartStep[] {
  const byDate = new Map<string, ForecastFlow[]>();
  for (const fl of flows) byDate.set(fl.date, [...(byDate.get(fl.date) ?? []), fl]);
  const steps: ChartStep[] = [{ date: start, balance: opening, flows: [] }];
  let running = opening;
  for (const [date, fls] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    running += fls.reduce((s, f) => s + f.amount, 0);
    steps.push({ date, balance: running, flows: fls });
  }
  return steps;
}

/** Days from a to b (ISO dates). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** About `count` round tick values spanning [lo, hi], in cents (steps of 1, 2, or 5 × 10^n dollars). */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) hi = lo + 100;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const first = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  if (ticks.length && ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** "$12k", "-$3.5k", "$1.2M": short enough for a y-axis. */
export function compactMoney(cents: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/** Every `stride`th period start, so date labels don't collide at narrow widths. */
export function dateTicks(starts: string[], maxLabels: number): string[] {
  if (starts.length <= maxLabels) return starts;
  const stride = Math.ceil(starts.length / Math.max(1, maxLabels));
  return starts.filter((_, i) => i % stride === 0);
}
