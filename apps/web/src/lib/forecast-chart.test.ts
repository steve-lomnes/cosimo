import { describe, expect, test } from "bun:test";
import type { ForecastFlow } from "./forecast";
import { balanceSteps, dateTicks, niceTicks } from "./forecast-chart";

const flow = (date: string, amount: number, label = "x") =>
  ({ id: `${date}${label}`, date, amount, label, source: "planned", firmness: "planned" }) as ForecastFlow;

describe("balanceSteps", () => {
  test("opens with the opening balance, then one step per day in date order", () => {
    const steps = balanceSteps(10_000, "2026-11-14", [
      flow("2026-11-20", -3_000, "rent"),
      flow("2026-11-16", 5_000, "fee"),
      flow("2026-11-20", -1_000, "card"),
    ]);
    expect(steps.map((s) => [s.date, s.balance, s.flows.length])).toEqual([
      ["2026-11-14", 10_000, 0],
      ["2026-11-16", 15_000, 1],
      ["2026-11-20", 11_000, 2],
    ]);
  });
});

describe("niceTicks", () => {
  test("round steps that cover the range", () => {
    const t = niceTicks(-120_000, 1_430_000);
    expect(t[0]!).toBeLessThanOrEqual(-120_000);
    expect(t[t.length - 1]!).toBeGreaterThanOrEqual(1_430_000);
    const step = t[1]! - t[0]!;
    expect(t.every((v, i) => i === 0 || v - t[i - 1]! === step)).toBe(true);
    expect([1, 2, 5].some((m) => Number.isInteger(Math.log10(step / m)))).toBe(true);
    expect(t.length).toBeLessThanOrEqual(7);
  });
  test("a flat range still gets ticks", () => {
    expect(niceTicks(0, 0).length).toBeGreaterThan(1);
  });
});

describe("dateTicks", () => {
  test("thins labels to fit", () => {
    const s = Array.from({ length: 13 }, (_, i) => `d${i}`);
    expect(dateTicks(s, 20)).toHaveLength(13);
    expect(dateTicks(s, 5).length).toBeLessThanOrEqual(5);
    expect(dateTicks(s, 5)[0]).toBe("d0");
  });
});
