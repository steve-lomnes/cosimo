import { describe, expect, test } from "bun:test";
import { applyOverrides, bucketRanges, buildForecast, type Flow, itemOccurrences } from "./forecast.ts";

const flow = (id: string, date: string, amount: number, extra: Partial<Flow> = {}): Flow => ({
  id,
  date,
  amount,
  source: "planned",
  ref: null,
  label: id,
  firmness: "planned",
  ...extra,
});

describe("bucketRanges", () => {
  test("weeks run Monday to Sunday, and the first is a partial week from today", () => {
    // 2026-11-12 is a Thursday.
    const r = bucketRanges("2026-11-12", "week", 3);
    expect(r).toEqual([
      { start: "2026-11-12", end: "2026-11-15" },
      { start: "2026-11-16", end: "2026-11-22" },
      { start: "2026-11-23", end: "2026-11-29" },
    ]);
  });

  test("a Sunday start makes a one-day first week; a Monday start a full one", () => {
    expect(bucketRanges("2026-11-15", "week", 2)[0]).toEqual({ start: "2026-11-15", end: "2026-11-15" });
    expect(bucketRanges("2026-11-16", "week", 1)[0]).toEqual({ start: "2026-11-16", end: "2026-11-22" });
  });

  test("months are calendar months, the first from today, across a year end and a leap February", () => {
    expect(bucketRanges("2027-12-20", "month", 3)).toEqual([
      { start: "2027-12-20", end: "2027-12-31" },
      { start: "2028-01-01", end: "2028-01-31" },
      { start: "2028-02-01", end: "2028-02-29" },
    ]);
  });
});

describe("occurrences", () => {
  test("a one-off counts only inside the range, a schedule lists its dates", () => {
    const once = { unit: null, interval: 1, start_date: "2026-12-01" } as const;
    expect(itemOccurrences(once, "2026-11-01", "2026-12-01")).toEqual(["2026-12-01"]);
    expect(itemOccurrences(once, "2026-12-02", "2027-01-01")).toEqual([]);
    const monthly = { unit: "month", interval: 1, anchor_day: 31, start_date: "2026-01-31" } as const;
    expect(itemOccurrences(monthly, "2026-02-01", "2026-04-30")).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    const limited = { ...monthly, max_occurrences: 2 };
    expect(itemOccurrences(limited, "2026-02-01", "2026-12-31")).toEqual(["2026-02-28"]);
  });
});

describe("applyOverrides", () => {
  test("exclude drops a flow, shift moves it, and a flow with no target is untouched", () => {
    const flows = [
      flow("a", "2026-11-13", -100, { target: { type: "bill", id: "b1" } }),
      flow("b", "2026-11-13", -200, { target: { type: "bill", id: "b2" } }),
      flow("c", "2026-11-13", -300),
    ];
    const out = applyOverrides(flows, [
      { target_type: "bill", target_id: "b1", action: "exclude" },
      { target_type: "bill", target_id: "b2", action: "shift", shift_days: 10 },
    ]);
    expect(out.map((f) => [f.id, f.date])).toEqual([
      ["b", "2026-11-23"],
      ["c", "2026-11-13"],
    ]);
  });

  test("a shift moves the expected date and keeps the due date", () => {
    const flows = [
      flow("i", "2026-12-05", 100, { target: { type: "invoice", id: "i1" }, due_date: "2026-11-30" }),
    ];
    const [out] = applyOverrides(flows, [
      { target_type: "invoice", target_id: "i1", action: "shift", shift_days: 3 },
    ]);
    expect(out).toMatchObject({ date: "2026-12-08", due_date: "2026-11-30" });
  });

  test("a dated override matches only that date", () => {
    const flows = [
      flow("p1", "2027-01-15", -100, { target: { type: "reserve_part", id: "p", date: "2027-01-15" } }),
      flow("p2", "2027-04-15", -100, { target: { type: "reserve_part", id: "p", date: "2027-04-15" } }),
    ];
    const out = applyOverrides(flows, [
      { target_type: "reserve_part", target_id: "p", target_date: "2027-04-15", action: "exclude" },
    ]);
    expect(out.map((f) => f.id)).toEqual(["p1"]);
  });
});

describe("buildForecast", () => {
  const base = { today: "2026-11-12", window: { bucket: "week", periods: 3 } as const };
  const noBuffer = { min_cash_buffer: 0 };

  test("the low point is the opening balance when cash only grows", () => {
    const r = buildForecast({
      ...base,
      openingCash: 1000,
      flows: [flow("in", "2026-11-14", 500)],
      assumptions: noBuffer,
    });
    expect(r.low_point).toEqual({ balance: 1000, date: "2026-11-12" });
    expect(r.draw_capacity.amount).toBe(1000);
    expect(r.buckets[0]!.ending).toBe(1500);
    expect(r.buckets[2]!.ending).toBe(1500);
  });

  test("the low point is mid-window, and binding lists the outflows up to it", () => {
    const r = buildForecast({
      ...base,
      openingCash: 1000,
      flows: [
        flow("rent", "2026-11-17", -900, { source: "bill" }),
        flow("small", "2026-11-18", -50),
        flow("late-in", "2026-11-25", 2000),
        flow("after", "2026-11-26", -10),
      ],
      assumptions: noBuffer,
    });
    expect(r.low_point).toEqual({ balance: 50, date: "2026-11-18" });
    expect(r.draw_capacity.amount).toBe(50);
    expect(r.draw_capacity.binding.map((f) => f.id)).toEqual(["rent", "small"]);
    expect(r.buckets.map((b) => b.ending)).toEqual([1000, 50, 2040]);
    expect(r.buckets[1]).toMatchObject({ inflow: 0, outflow: 950, net: -950 });
  });

  test("two flows on one day count once, at the end of the day", () => {
    const r = buildForecast({
      ...base,
      openingCash: 100,
      flows: [flow("out", "2026-11-13", -500), flow("in", "2026-11-13", 500)],
      assumptions: noBuffer,
    });
    expect(r.low_point.balance).toBe(100);
  });

  test("a past date lands today, and a flow outside the window is dropped", () => {
    const r = buildForecast({
      ...base,
      openingCash: 0,
      flows: [flow("old", "2026-10-01", 300), flow("far", "2027-06-01", 999)],
      assumptions: noBuffer,
    });
    expect(r.buckets[0]!.flows.map((f) => [f.id, f.date])).toEqual([["old", "2026-11-12"]]);
    expect(r.buckets.flatMap((b) => b.flows).length).toBe(1);
    expect(r.buckets[2]!.ending).toBe(300);
  });

  test("a shift override moves a flow into another bucket", () => {
    const flows = applyOverrides(
      [flow("bill", "2026-11-14", -400, { target: { type: "bill", id: "x" } })],
      [{ target_type: "bill", target_id: "x", action: "shift", shift_days: 7 }],
    );
    const r = buildForecast({ ...base, openingCash: 1000, flows, assumptions: noBuffer });
    expect(r.buckets[0]!.flows).toEqual([]);
    expect(r.buckets[1]!.flows.map((f) => f.id)).toEqual(["bill"]);
  });

  test("capacity is clamped at 0 by the buffer and by a negative low point", () => {
    const flows = [flow("big", "2026-11-13", -1500)];
    const r = buildForecast({ ...base, openingCash: 1000, flows, assumptions: { min_cash_buffer: 200 } });
    expect(r.low_point.balance).toBe(-500);
    expect(r.draw_capacity).toMatchObject({ amount: 0, breakdown: { low_point: -500, buffer: 200 } });
    const ok = buildForecast({
      ...base,
      openingCash: 1000,
      flows: [],
      assumptions: { min_cash_buffer: 300 },
    });
    expect(ok.draw_capacity.amount).toBe(700);
  });

  test("drivers are the ten largest flows by absolute amount", () => {
    const flows = Array.from({ length: 12 }, (_, i) =>
      flow(`f${i}`, "2026-11-13", (i + 1) * (i % 2 ? 1 : -1)),
    );
    const r = buildForecast({ ...base, openingCash: 0, flows, assumptions: noBuffer });
    expect(r.drivers.length).toBe(10);
    expect(r.drivers[0]!.id).toBe("f11");
  });
});
