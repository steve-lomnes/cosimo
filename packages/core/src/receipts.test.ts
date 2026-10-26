import { describe, expect, test } from "bun:test";
import {
  amountFit,
  inDateWindow,
  merchantMatches,
  merchantTokens,
  rankCandidates,
  receiptFit,
  receiptMemo,
} from "./receipts.ts";

// Professor Java's: subtotal 7.00, tax 0.56, total 7.56, tip 1.13, charged 8.69.
const receipt = {
  amount: 869,
  pre_tip_amount: 756,
  receipt_date: "2026-10-20",
  merchant: "Professor Java's",
};

describe("receipt matching", () => {
  test("merchant tokens: short words and stop words don't count", () => {
    // "Professor Java's" normalizes to PROFESSOR JAVA S; the S is dropped.
    expect(merchantTokens("Professor Java's")).toEqual(["PROFESSOR", "JAVA"]);
    expect(merchantTokens("The Coffee Shop LLC")).toEqual(["COFFEE"]);
    expect(merchantTokens("A&B Co")).toEqual([]);
  });

  test("merchant matches the description or payee", () => {
    expect(merchantMatches("Professor Java's", "PROFESSOR JAVAS ALBANY NY")).toBe(true);
    expect(merchantMatches("Professor Java's", "SQ *PROFESSOR JAVAS")).toBe(true);
    expect(merchantMatches("Professor Java's", "POS DEBIT 1234", "Professor Javas")).toBe(true);
    expect(merchantMatches("Professor Java's", "JAVAS HUT")).toBe(false);
    expect(merchantMatches("Professor Java's", "PROF JAVAS")).toBe(false);
    expect(merchantMatches("The Store", "THE STORE")).toBe(false);
    expect(merchantMatches(null, "PROFESSOR JAVAS")).toBe(false);
  });

  test("amount fit: exact, or tip-tolerant up to 35% of the pre-tip total", () => {
    expect(amountFit(receipt, 869)).toBe("exact");
    expect(amountFit(receipt, 756)).toBe("tip");
    expect(amountFit(receipt, 1020)).toBe("tip"); // floor(756 * 1.35) = 1020
    expect(amountFit(receipt, 1021)).toBeNull();
    expect(amountFit(receipt, 755)).toBeNull();
    expect(amountFit({ amount: 869 }, 870)).toBeNull();
    expect(amountFit({ amount: null, pre_tip_amount: null }, 869)).toBeNull();
  });

  test("date window edges: -1 and +7 accepted, -2 and +8 rejected", () => {
    expect(inDateWindow("2026-10-20", "2026-10-19")).toBe(true);
    expect(inDateWindow("2026-10-20", "2026-10-27")).toBe(true);
    expect(inDateWindow("2026-10-20", "2026-10-18")).toBe(false);
    expect(inDateWindow("2026-10-20", "2026-10-28")).toBe(false);
    // Across a month end.
    expect(inDateWindow("2026-10-28", "2026-11-04")).toBe(true);
    expect(inDateWindow("2026-10-28", "2026-11-05")).toBe(false);
  });

  test("receipt fit: outflows only, and a tip fit needs the merchant", () => {
    const t = { date: "2026-10-22", amount: -869, description: "SQ *PROFESSOR JAVAS" };
    expect(receiptFit(receipt, t)).toEqual({ fit: "exact", merchant: true, days: 2 });
    expect(receiptFit(receipt, { ...t, amount: 869 })).toBeNull();
    expect(receiptFit(receipt, { ...t, description: "CARD 4411" })).toEqual({
      fit: "exact",
      merchant: false,
      days: 2,
    });
    expect(receiptFit(receipt, { ...t, amount: -900 })).toMatchObject({ fit: "tip" });
    expect(receiptFit(receipt, { ...t, amount: -900, description: "CARD 4411" })).toBeNull();
    expect(receiptFit(receipt, { ...t, date: "2026-10-28" })).toBeNull();
  });

  test("ranking: closest date, then merchant, then ID", () => {
    const ranked = rankCandidates([
      { id: "c", days: 1, merchant: false },
      { id: "b", days: 1, merchant: true },
      { id: "a", days: 3, merchant: true },
      { id: "d", days: 1, merchant: true },
    ]);
    expect(ranked.map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
  });

  test("memo: the receipt's own, else merchant and purpose, else the merchant", () => {
    expect(receiptMemo({ memo: "Client lunch", merchant: "Professor Java's" })).toBe("Client lunch");
    expect(receiptMemo({ merchant: "Professor Java's", business_purpose: "Meeting with David" })).toBe(
      "Professor Java's: Meeting with David",
    );
    expect(receiptMemo({ merchant: "Professor Java's", memo: "  " })).toBe("Professor Java's");
    expect(receiptMemo({})).toBeNull();
  });

  test("memo: a paid-with note is appended", () => {
    expect(receiptMemo({ merchant: "Staples", paid_with_note: "Steve's personal Amex" })).toBe(
      "Staples (paid with Steve's personal Amex)",
    );
    expect(receiptMemo({ merchant: "Staples", paid_with_note: "  " })).toBe("Staples");
    expect(receiptMemo({ paid_with_note: "cash" })).toBe("Paid with cash");
  });
});
