import { describe, expect, test } from "bun:test";
import { dueNote, type ForecastFlow } from "./forecast";
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
  test("a due date is searchable as well as the expected date", () => {
    const inv = flow({ source: "invoice", firmness: "booked", amount: 50_000, due_date: "2026-11-30" });
    expect(flowMatches(inv, parseQuery("due nov"))).toBe(true);
    expect(flowMatches(inv, parseQuery("dec"))).toBe(true);
    expect(m("due")).toBe(false);
  });
  test("amounts typed with or without separators, and size bounds", () => {
    expect(m("9000")).toBe(true);
    expect(m("9,000")).toBe(true);
    expect(m(">5000")).toBe(true);
    expect(m("<5,000")).toBe(false);
    expect(m(">1000 <10000 contractor")).toBe(true);
  });
});

describe("due note", () => {
  test("says the due date and how far the expected date is from it", () => {
    expect(dueNote({ date: "2026-12-05", due_date: "2026-11-30" })).toEndWith(" · expected 5 days late");
    expect(dueNote({ date: "2026-11-29", due_date: "2026-11-30" })).toEndWith(" · expected 1 day early");
    expect(dueNote({ date: "2026-11-30", due_date: "2026-11-30" })).toStartWith("Due ");
    expect(dueNote({ date: "2026-11-30", due_date: "2026-11-30" })).not.toContain("expected");
    expect(dueNote({ date: "2026-11-30", due_date: null })).toBeNull();
  });
});
