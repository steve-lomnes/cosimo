import { describe, expect, test } from "bun:test";
import { applyOverrides, buildForecast } from "./forecast.ts";
import {
  type DueDate,
  dueDateError,
  dueDatesFor,
  partTarget,
  projectedAnnual,
  reserveFlows,
  reservesNotInWindow,
  taxYearOf,
  taxYearRange,
  yearInstallments,
} from "./reserves.ts";

const US: DueDate[] = [
  { month: 4, day: 15, year_offset: 0 },
  { month: 6, day: 15, year_offset: 0 },
  { month: 9, day: 15, year_offset: 0 },
  { month: 1, day: 15, year_offset: 1 },
];

describe("tax years", () => {
  test("a calendar tax year", () => {
    expect(taxYearOf("2026-11-14", 1)).toBe(2026);
    expect(taxYearRange(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  test("a tax year starting in another month is named by the year it starts in", () => {
    expect(taxYearOf("2026-06-30", 7)).toBe(2025);
    expect(taxYearOf("2026-07-01", 7)).toBe(2026);
    expect(taxYearRange(2026, 7)).toEqual({ start: "2026-07-01", end: "2027-06-30" });
    expect(taxYearRange(2026, 12)).toEqual({ start: "2026-12-01", end: "2027-11-30" });
  });

  test("due dates: months before the start month fall in the next calendar year, and year_offset adds one", () => {
    expect(dueDatesFor({ due_dates: US }, 2026, 1)).toEqual([
      "2026-04-15",
      "2026-06-15",
      "2026-09-15",
      "2027-01-15",
    ]);
    // A July tax year: October is in 2026, March is in 2027, and a year_offset 1 date in August is 2027.
    expect(
      dueDatesFor(
        {
          due_dates: [
            { month: 3, day: 1, year_offset: 0 },
            { month: 10, day: 1, year_offset: 0 },
            { month: 8, day: 1, year_offset: 1 },
          ],
        },
        2026,
        7,
      ),
    ).toEqual(["2026-10-01", "2027-03-01", "2027-08-01"]);
    // Feb 29 becomes Feb 28 in a year that has none.
    expect(dueDatesFor({ due_dates: [{ month: 2, day: 29, year_offset: 0 }] }, 2026, 1)).toEqual([
      "2026-02-28",
    ]);
  });

  test("due date validation", () => {
    expect(dueDateError({ month: 4, day: 15, year_offset: 0 })).toBeNull();
    expect(dueDateError({ month: 2, day: 29, year_offset: 1 })).toBeNull();
    expect(dueDateError({ month: 2, day: 30, year_offset: 0 })).not.toBeNull();
    expect(dueDateError({ month: 13, day: 1, year_offset: 0 })).not.toBeNull();
    expect(dueDateError({ month: 1, day: 1, year_offset: 2 as 0 })).not.toBeNull();
  });
});

describe("targets", () => {
  test("negative net income gives 0, and the target rounds to the cent", () => {
    expect(partTarget(-50_000, 2500)).toBe(0);
    expect(partTarget(0, 2500)).toBe(0);
    // 12,345 cents × 15.3% = 1888.785 → 1889
    expect(partTarget(12_345, 1530)).toBe(1889);
    expect(partTarget(10_000, 10_000)).toBe(10_000);
  });

  test("projected annual scales by days in the year over days elapsed, at least 1", () => {
    const y = taxYearRange(2026, 1);
    // Day 1 of 365: the whole year at that pace.
    expect(projectedAnnual(100, 10_000, y, "2026-01-01")).toBe(36_500);
    // Before the year starts, days elapsed is still 1.
    expect(projectedAnnual(100, 10_000, y, "2025-12-01")).toBe(36_500);
    // Half way (July 2 is day 183): 18,300 × 365 / 183.
    expect(projectedAnnual(18_300, 10_000, y, "2026-07-02")).toBe(36_500);
    // After the year ends, it is the target.
    expect(projectedAnnual(18_300, 2500, y, "2027-03-01")).toBe(partTarget(18_300, 2500));
    expect(projectedAnnual(-1, 2500, y, "2026-07-02")).toBe(0);
  });
});

describe("installments", () => {
  test("the next date takes what is owed now; later dates share the projected rest, the last the remainder", () => {
    const r = yearInstallments({
      dates: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
      asOf: "2026-05-01",
      target: 10_000,
      paid: 3_000,
      projected: 20_000,
    });
    expect(r).toEqual([
      { date: "2026-06-15", amount: 7_000 },
      { date: "2026-09-15", amount: 5_000 },
      { date: "2027-01-15", amount: 5_000 },
    ]);
    const odd = yearInstallments({
      dates: ["2026-06-15", "2026-09-15", "2027-01-15"],
      asOf: "2026-05-01",
      target: 0,
      paid: 0,
      projected: 100,
    });
    expect(odd.map((x) => x.amount)).toEqual([0, 50, 50]);
    const three = yearInstallments({
      dates: ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"],
      asOf: "2026-05-01",
      target: 0,
      paid: 0,
      projected: 100,
    });
    expect(three.map((x) => x.amount)).toEqual([0, 33, 33, 34]);
  });

  test("overpaid gives 0, and nothing is left once every date has passed", () => {
    expect(
      yearInstallments({ dates: ["2026-06-15"], asOf: "2026-05-01", target: 100, paid: 500, projected: 100 }),
    ).toEqual([{ date: "2026-06-15", amount: 0 }]);
    expect(
      yearInstallments({ dates: ["2026-04-15"], asOf: "2026-05-01", target: 100, paid: 0, projected: 100 }),
    ).toEqual([]);
  });
});

describe("reserve flows in the forecast", () => {
  const reserve = { id: "r1", name: "Taxes", tax_year_start_month: 1 };
  const part = { id: "p1", label: "Federal", rate_bp: 2500, due_dates: US, paid: 0, prev_paid: 0 };

  test("the previous year's January installment still to come, and the current year's next date", () => {
    // Jan 5, 2026: the 2025 Jan 15 installment is still ahead; 2026 has earned nothing yet.
    const flows = reserveFlows({
      reserve,
      parts: [{ ...part, prev_paid: 10_000 }],
      today: "2026-01-05",
      net_income: 0,
      prev_net_income: 100_000,
    });
    expect(flows).toEqual([
      expect.objectContaining({
        id: "res:p1:2025:2026-01-15",
        date: "2026-01-15",
        amount: -15_000,
        source: "reserve",
        firmness: "reserve",
        tax_year: 2025,
        target: { type: "reserve_part", id: "p1", date: "2026-01-15" },
      }),
    ]);
  });

  test("current-year installments: owed now on the next date, the projected rest after", () => {
    // Day 100 of 2026 is April 10. Net income 100,000 → target 25,000; projected 25,000 × 365/100.
    const flows = reserveFlows({
      reserve,
      parts: [{ ...part, paid: 5_000 }],
      today: "2026-04-10",
      net_income: 100_000,
      prev_net_income: 0,
    });
    const projected = Math.round((100_000 * 2500 * 365) / (100 * 10_000));
    expect(projected).toBe(91_250);
    expect(flows.map((f) => [f.date, f.amount])).toEqual([
      ["2026-04-15", -20_000],
      ["2026-06-15", -22_083],
      ["2026-09-15", -22_083],
      ["2027-01-15", -22_084],
    ]);
  });

  test("reserves not in the window, after an override, reduce draw capacity", () => {
    const today = "2026-04-10";
    const flows = reserveFlows({
      reserve,
      parts: [part],
      today,
      net_income: 100_000,
      prev_net_income: 0,
    });
    const parts = [{ id: "p1", tax_year: 2026, target: 25_000, paid: 0 }];
    // The Apr 15 installment pays all that is owed now.
    expect(reservesNotInWindow(parts, flows, "2026-04-30")).toBe(0);
    // A window ending before it holds it back.
    expect(reservesNotInWindow(parts, flows, "2026-04-12")).toBe(25_000);
    // Excluding it in a scenario holds it back too.
    const excluded = applyOverrides(flows, [
      { target_type: "reserve_part", target_id: "p1", target_date: "2026-04-15", action: "exclude" },
    ]);
    expect(excluded.some((f) => f.date === "2026-04-15")).toBe(false);
    expect(reservesNotInWindow(parts, excluded, "2026-04-30")).toBe(25_000);
    // The previous year's flows don't count toward this year's.
    expect(
      reservesNotInWindow(
        parts,
        flows.map((f) => ({ ...f, tax_year: 2025 })),
        "2026-12-31",
      ),
    ).toBe(25_000);

    const f = buildForecast({
      today,
      window: { bucket: "week", periods: 1 },
      openingCash: 100_000,
      flows: [],
      assumptions: { min_cash_buffer: 10_000 },
      reservesNotInWindow: 25_000,
    });
    expect(f.draw_capacity).toMatchObject({
      amount: 65_000,
      breakdown: { low_point: 100_000, buffer: 10_000, reserves_not_in_window: 25_000 },
    });
  });
});
