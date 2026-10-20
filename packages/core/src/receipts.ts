/**
 * Receipt matching (#89): whether a receipt captured at the counter fits a bank transaction that
 * arrives later. Pure functions; the server applies them to rows.
 *
 * A charge fits a receipt when it is an outflow dated from a day before the receipt to a week
 * after it, for the receipt's amount exactly, or, when the receipt names a pre-tip total, for that
 * total plus a tip of up to 35%. A tip-tolerant fit also needs the merchant to match the
 * transaction's description or payee.
 */
import { addDays, diffDays } from "@cosimo/shared";
import { normalizeDescription } from "./import/normalize.ts";

/** A charge posts from a day before the receipt's date to a week after it. */
export const RECEIPT_EARLY_DAYS = 1;
export const RECEIPT_LATE_DAYS = 7;
/** The largest tip a tip-tolerant match allows, as a percentage of the pre-tip total. */
export const RECEIPT_MAX_TIP_PCT = 35;
/** A receipt still in the inbox after this many days is stale (dashboard). */
export const RECEIPT_STALE_DAYS = 30;

const MERCHANT_STOP = new Set(["THE", "LLC", "INC", "STORE", "CORP", "COMPANY", "SHOP"]);

/** Merchant tokens that count for matching: 4+ characters, not a stop word. */
export function merchantTokens(merchant: string): string[] {
  return normalizeDescription(merchant)
    .split(" ")
    .filter((w) => w.length >= 4 && !MERCHANT_STOP.has(w) && !/^\d+$/.test(w));
}

/**
 * Whether the receipt's merchant appears in the transaction's description or payee: any merchant
 * token of 4+ characters (stop words aside) among the transaction's normalized tokens.
 */
export function merchantMatches(
  merchant: string | null | undefined,
  description: string | null | undefined,
  payee?: string | null,
): boolean {
  if (!merchant) return false;
  const wanted = merchantTokens(merchant);
  if (!wanted.length) return false;
  const have = new Set(
    [description, payee]
      .filter((s): s is string => Boolean(s))
      .flatMap((s) => normalizeDescription(s).split(" ")),
  );
  return wanted.some((w) => have.has(w));
}

export type AmountFit = "exact" | "tip";

/** floor(pre-tip total * 1.35), in integer arithmetic. */
export function maxWithTip(preTip: number): number {
  return Math.floor((preTip * (100 + RECEIPT_MAX_TIP_PCT)) / 100);
}

/**
 * How a charge of `absAmount` (positive cents) fits the receipt: `exact` for the amount charged,
 * `tip` for the pre-tip total plus a tip of up to 35% (rounded down), else null.
 */
export function amountFit(
  r: { amount?: number | null; pre_tip_amount?: number | null },
  absAmount: number,
): AmountFit | null {
  if (r.amount != null && absAmount === r.amount) return "exact";
  const pre = r.pre_tip_amount;
  if (pre != null && pre > 0 && absAmount >= pre && absAmount <= maxWithTip(pre)) return "tip";
  return null;
}

/** Whether a transaction dated `txnDate` falls in the receipt's window (both YYYY-MM-DD). */
export function inDateWindow(receiptDate: string, txnDate: string): boolean {
  return (
    txnDate >= addDays(receiptDate, -RECEIPT_EARLY_DAYS) && txnDate <= addDays(receiptDate, RECEIPT_LATE_DAYS)
  );
}

/** The window as a [from, to] pair, for queries. */
export function dateWindow(receiptDate: string): [string, string] {
  return [addDays(receiptDate, -RECEIPT_EARLY_DAYS), addDays(receiptDate, RECEIPT_LATE_DAYS)];
}

export interface ReceiptFitInput {
  amount?: number | null;
  pre_tip_amount?: number | null;
  receipt_date: string;
  merchant?: string | null;
}

export interface TxnFitInput {
  date: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string;
  payee?: string | null;
}

/**
 * How a transaction fits a receipt, or null when it doesn't: an outflow in the date window with an
 * exact amount, or a tip-tolerant amount and a merchant match.
 */
export function receiptFit(
  r: ReceiptFitInput,
  t: TxnFitInput,
): { fit: AmountFit; merchant: boolean; days: number } | null {
  if (t.amount >= 0 || !inDateWindow(r.receipt_date, t.date)) return null;
  const fit = amountFit(r, -t.amount);
  if (!fit) return null;
  const merchant = merchantMatches(r.merchant, t.description, t.payee);
  if (fit === "tip" && !merchant) return null;
  return { fit, merchant, days: Math.abs(diffDays(t.date, r.receipt_date)) };
}

/** Order candidates best first: closest date, then a merchant match, then ID. */
export function rankCandidates<T extends { id: string; days: number; merchant: boolean }>(xs: T[]): T[] {
  return [...xs].sort(
    (a, b) => a.days - b.days || Number(b.merchant) - Number(a.merchant) || a.id.localeCompare(b.id),
  );
}

/**
 * The memo a receipt suggests for its transaction: its own memo, else "Merchant: purpose", else the
 * merchant alone (null when it has none of these).
 */
export function receiptMemo(r: {
  memo?: string | null;
  merchant?: string | null;
  business_purpose?: string | null;
}): string | null {
  const memo = r.memo?.trim();
  if (memo) return memo;
  const merchant = r.merchant?.trim();
  const purpose = r.business_purpose?.trim();
  if (merchant && purpose) return `${merchant}: ${purpose}`;
  return merchant || purpose || null;
}
