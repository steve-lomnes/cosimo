import { describe, expect, test } from "bun:test";
import { chartOfAccounts, isPaymentAccount, TAX_LINES } from "./coa";

const TEMPLATES = ["schedule_c", "form_1065", "form_1120s", "minimal"] as const;

describe("chart of accounts templates", () => {
  test("codes are unique and every tax line is known", () => {
    for (const t of TEMPLATES) {
      const chart = chartOfAccounts(t);
      expect(new Set(chart.map((a) => a.code)).size).toBe(chart.length);
      for (const a of chart) if (a.taxLine) expect(TAX_LINES[a.taxLine]).toBeDefined();
    }
  });

  test("tax templates keep formation costs apart, on the other-expenses line", () => {
    const expected = { schedule_c: "schc.27a", form_1065: "f1065.21", form_1120s: "f1120s.20" };
    for (const [t, line] of Object.entries(expected)) {
      const a = chartOfAccounts(t as keyof typeof expected).find((x) => x.code === "6340");
      expect(a?.name).toBe("Organization and Startup Costs");
      expect(a?.taxLine).toBe(line);
      expect(a?.description).toContain("180 months");
    }
    expect(chartOfAccounts("minimal").some((a) => a.code === "6340")).toBe(false);
  });

  test("tax templates carry a current liability for reimbursing owners", () => {
    const expected = {
      schedule_c: "Due to Owner",
      form_1065: "Due to Partners",
      form_1120s: "Due to Shareholders",
    };
    for (const [t, name] of Object.entries(expected)) {
      const a = chartOfAccounts(t as keyof typeof expected).find((x) => x.code === "2400");
      expect(a).toMatchObject({ name, type: "liability", subtype: "other_current_liability" });
      expect(a?.taxLine).toBeUndefined();
    }
    expect(chartOfAccounts("form_1120s").find((x) => x.code === "2400")?.description).toContain(
      "accountable plan",
    );
    expect(chartOfAccounts("minimal").some((a) => a.code === "2400")).toBe(false);
  });
});

describe("isPaymentAccount", () => {
  const ok = [
    ["asset", "bank"],
    ["asset", "other_current_asset"],
    ["liability", "credit_card"],
    ["liability", "other_current_liability"],
    ["equity", "owner_equity"],
  ] as const;
  for (const [type, subtype] of ok)
    test(`${type}/${subtype} is allowed`, () => expect(isPaymentAccount({ type, subtype })).toBe(true));
  const no = [
    ["asset", "accounts_receivable"],
    ["asset", "fixed_asset"],
    ["liability", "accounts_payable"],
    ["liability", "long_term_liability"],
    ["equity", "retained_earnings"],
    ["income", "income"],
    ["expense", "expense"],
    ["asset", null],
  ] as const;
  for (const [type, subtype] of no)
    test(`${type}/${subtype} is refused`, () => expect(isPaymentAccount({ type, subtype })).toBe(false));
});
