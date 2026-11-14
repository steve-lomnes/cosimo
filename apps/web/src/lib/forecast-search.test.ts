import { describe, expect, test } from "bun:test";
import type { ForecastFlow } from "./forecast";
import { flowMatches, parseQuery } from "./forecast-search";

const flow = (o: Partial<ForecastFlow>): ForecastFlow =>
  ({
    id: "x",
    date: "2026-12-24",
    amount: -900_000,
    source: "planned",
    ref: "i1",
    label: "Contractor",
    firmness: "planned",
    ...o,
  }) as ForecastFlow;

describe("forecast search", () => {
  const f = flow({});
  const m = (q: string) => flowMatches(f, parseQuery(q));
  test("name, type, firmness, and direction", () => {
    expect(m("contr")).toBe(true);
    expect(m("planned out")).toBe(true);
    expect(m("invoice")).toBe(false);
    expect(m("in")).toBe(false);
  });
  test("dates in any common spelling", () => {
    expect(m("dec")).toBe(true);
    expect(m("december 24")).toBe(true);
    expect(m("2026-12")).toBe(true);
    expect(m("nov")).toBe(false);
  });
  test("amounts typed with or without separators, and size bounds", () => {
    expect(m("9000")).toBe(true);
    expect(m("9,000")).toBe(true);
    expect(m(">5000")).toBe(true);
    expect(m("<5,000")).toBe(false);
    expect(m(">1000 <10000 contractor")).toBe(true);
  });
});
