/**
 * Search-anywhere for forecast transactions: every word typed must match somewhere in the row (its
 * name, type, how firm it is, its date in any common spelling, or its amount), and `>1000` / `<50`
 * keep rows by size. Matching is the same keyword matcher the account and contact pickers use.
 */
import type { ForecastFlow } from "./forecast";
import { FIRMNESS_LABEL, SOURCE_CHIP } from "./forecast";
import { matchScore } from "./search";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** The words a flow can be found by, beyond its label. */
export function flowKeywords(f: ForecastFlow): string {
  const [y, m, d] = f.date.split("-");
  const month = MONTHS[Number(m) - 1] ?? "";
  const abs = Math.abs(f.amount);
  const dollars = Math.floor(abs / 100);
  return [
    SOURCE_CHIP[f.source],
    FIRMNESS_LABEL[f.firmness],
    f.amount >= 0 ? "in money-in incoming receipt" : "out money-out outgoing payment",
    f.date,
    `${y} ${month} ${month.slice(0, 3)} ${Number(d)}`,
    String(dollars),
    `${dollars.toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`,
  ].join(" ");
}

interface Parsed {
  text: string;
  min: number | null;
  max: number | null;
}

/** Split `>1000 <5,000 rent` into size bounds (in cents) and the words left over. */
export function parseQuery(q: string): Parsed {
  let min: number | null = null;
  let max: number | null = null;
  const rest: string[] = [];
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([<>])=?\$?([\d,]+(?:\.\d{1,2})?)$/.exec(tok);
    if (m) {
      const cents = Math.round(Number(m[2]!.replace(/,/g, "")) * 100);
      if (m[1] === ">") min = cents;
      else max = cents;
    } else rest.push(tok);
  }
  return { text: rest.join(" "), min, max };
}

export function flowMatches(f: ForecastFlow, q: Parsed): boolean {
  const abs = Math.abs(f.amount);
  if (q.min !== null && abs < q.min) return false;
  if (q.max !== null && abs > q.max) return false;
  if (!q.text) return true;
  return matchScore({ value: f.id, label: f.label, keywords: flowKeywords(f) }, q.text) !== null;
}
