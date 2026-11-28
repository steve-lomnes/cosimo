import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId, org } from "@cosimo/db";
import { addDays, fiscalYearStart, today } from "@cosimo/shared";
import { strFromU8, unzipSync } from "fflate";
import { auditHead, ledgerHead } from "../src/services/chain.ts";
import { fiscalYearPeriod, orgSlug } from "../src/services/year-end.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;

async function accounts(orgId: string) {
  const r = await owner.json("GET", `/api/v1/orgs/${orgId}/accounts`);
  return Object.fromEntries(r.body.data.map((a: any) => [a.code, a.id])) as Record<string, string>;
}

async function post(orgId: string, date: string, lines: [string, number][], memo = "Test") {
  const r = await owner.json("POST", `/api/v1/orgs/${orgId}/entries`, {
    date,
    memo,
    lines: lines.map(([account_id, amount]) => ({ account_id, amount })),
  });
  if (r.status !== 201 && r.status !== 202 && r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
}

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "insights-owner@example.com");
});

afterAll(async () => {
  await env.close();
});

describe(`year-end package (${DB_MODE})`, () => {
  let orgId: string;
  const base = () => `/api/v1/orgs/${orgId}`;

  beforeAll(async () => {
    orgId = await createOrg(env, owner, "Year End & Co.", { basis: "cash", books_start_date: "2025-01-01" });
    const a = await accounts(orgId);
    const checking = (
      await owner.json("POST", `${base()}/bank-accounts`, {
        name: "Checking",
        kind: "checking",
        ledger_account_id: a["1000"],
      })
    ).body;
    await post(orgId, "2025-03-10", [
      [a["1000"]!, 80_000],
      [a["4000"]!, -80_000],
    ]);
    await post(orgId, "2025-12-05", [
      [a["6100"]!, 10_000],
      [a["1000"]!, -10_000],
    ]);
    const start = await owner.json("POST", `${base()}/reconciliations`, {
      account_id: checking.ledger_account_id,
      statement_end_date: "2025-12-31",
      statement_ending_balance: 70_000,
    });
    expect(start.status).toBe(201);
    const detail = await owner.json("GET", `${base()}/reconciliations/${start.body.id}`);
    await owner.json("POST", `${base()}/reconciliations/${start.body.id}/lines`, {
      line_ids: detail.body.lines.map((l: any) => l.id),
      cleared: true,
    });
    const form = new FormData();
    form.append("file", new File(["%PDF-1.4\n% statement\n"], "dec.pdf", { type: "application/pdf" }));
    form.append("target_type", "reconciliation");
    form.append("target_id", start.body.id);
    expect((await owner.req("POST", `${base()}/attachments`, form)).status).toBe(201);
    const done = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/complete`);
    expect(done.body.status).toBe("completed");
  });

  test("ZIP holds every report as PDF and CSV, README.txt and chain.json", async () => {
    const res = await owner.req("GET", `${base()}/year-end?year=2025`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="year-end-co-2025-year-end.zip"',
    );
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files).sort();
    const reports = [
      "01-profit-and-loss",
      "02-balance-sheet",
      "03-trial-balance",
      "04-general-ledger",
      "05-tax-line-summary",
      "06-1099-vendor-summary",
      "07-ar-aging",
      "08-ap-aging",
      "09-reconciliations/reconciliation-Business-Checking-2025-12-31",
    ];
    expect(names).toEqual(
      [
        ...reports.flatMap((r) => [`${r}.csv`, `${r}.pdf`]),
        "09-reconciliations/reconciliation-Business-Checking-2025-12-31-statement.pdf",
        "README.txt",
        "chain.json",
      ].sort(),
    );
    expect(
      strFromU8(files["09-reconciliations/reconciliation-Business-Checking-2025-12-31-statement.pdf"]!),
    ).toStartWith("%PDF-1.4");
    for (const n of names.filter((x) => x.endsWith(".pdf")))
      expect(strFromU8(files[n]!.slice(0, 5))).toBe("%PDF-");

    // chain.json matches the live chain heads (nothing has been written since).
    const chain = JSON.parse(strFromU8(files["chain.json"]!));
    const h = (await env.ctx.orgs.mustOpen(orgId)).db;
    expect(chain.ledger).toEqual(await ledgerHead(h, orgId));
    expect(chain.audit).toEqual(await auditHead(h, orgId));
    expect(chain.org_id).toBe(orgId);
    expect(chain.ledger.seq).toBe(2);
    const cps = await owner.json("GET", `${base()}/checkpoints`);
    const ye = cps.body.data.filter((c: any) => c.reason === "year_end");
    expect(ye.map((c: any) => c.head_hash).sort()).toEqual([chain.ledger.hash, chain.audit.hash].sort());

    const readme = strFromU8(files["README.txt"]!);
    expect(readme).toContain("Year End & Co.");
    expect(readme).toContain("2025-01-01 to 2025-12-31");
    expect(readme).toContain("Basis:         Cash");
    expect(readme).toContain(chain.ledger.hash);
    expect(readme).toContain("tamper-evident, not tamper-proof");
    expect(readme).toContain("02-balance-sheet.pdf");

    // The balance sheet CSV equals the report API for the same date (apart from the timestamp).
    const api = await (
      await owner.req("GET", `${base()}/reports/balance_sheet?as_of=2025-12-31&format=csv`)
    ).text();
    const strip = (s: string) =>
      s
        .split("\r\n")
        .filter((l) => !l.startsWith("Generated "))
        .join("\r\n");
    expect(strip(strFromU8(files["02-balance-sheet.csv"]!))).toBe(strip(api));
    expect(api).toContain("700.00");

    const pnl = strFromU8(files["01-profit-and-loss.csv"]!);
    expect(pnl).toContain("2025-01-01 to 2025-12-31");
    expect(pnl).toContain("Net Income,700.00");
  });

  test("viewers cannot download it; accountants can", async () => {
    const viewer = await login(env, "insights-viewer@example.com");
    await addMember(env, orgId, viewer.userId, "viewer");
    expect((await viewer.req("GET", `${base()}/year-end?year=2025`)).status).toBe(403);
    const acct = await login(env, "insights-accountant@example.com");
    await addMember(env, orgId, acct.userId, "accountant");
    expect((await acct.req("GET", `${base()}/year-end?year=2025`)).status).toBe(200);
    expect((await acct.req("GET", `${base()}/year-end`)).status).toBe(400);
  });

  test("fiscal year is the one ending in the given calendar year", () => {
    expect(fiscalYearPeriod(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(fiscalYearPeriod(2026, 7)).toEqual({ from: "2025-07-01", to: "2026-06-30" });
    expect(orgSlug("  ", "fallback")).toBe("fallback");
  });
});

describe(`dashboard (${DB_MODE})`, () => {
  let orgId: string;
  const base = () => `/api/v1/orgs/${orgId}`;
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const fyStart = fiscalYearStart(t, 1);
  const earlier = monthStart > fyStart;

  beforeAll(async () => {
    orgId = await createOrg(env, owner, "Dash Co", { basis: "accrual", books_start_date: fyStart });
    const a = await accounts(orgId);
    await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Checking",
      kind: "checking",
      ledger_account_id: a["1000"],
    });
    await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Card",
      kind: "credit_card",
      ledger_account_id: a["2100"],
    });
    if (earlier)
      await post(orgId, fyStart, [
        [a["1000"]!, 50_000],
        [a["4000"]!, -50_000],
      ]);
    await post(orgId, monthStart, [
      [a["1000"]!, 100_000],
      [a["4000"]!, -100_000],
    ]);
    await post(orgId, monthStart, [
      [a["6100"]!, 20_000],
      [a["1000"]!, -20_000],
    ]);
    await post(orgId, monthStart, [
      [a["6180"]!, 5_000],
      [a["2100"]!, -5_000],
    ]);
    // At or above the review threshold: held for review, no effect on balances.
    const held = await post(orgId, monthStart, [
      [a["6130"]!, 300_000],
      [a["1000"]!, -300_000],
    ]);
    expect(held.status).toBe("pending_review");

    const customer = (await owner.json("POST", `${base()}/contacts`, { kind: "customer", name: "Globex" }))
      .body.id;
    const inv = await owner.json("POST", `${base()}/invoices`, {
      customer_id: customer,
      issue_date: monthStart,
      due_date: addDays(t, -1),
      lines: [{ description: "Work", quantity_milli: 1000, unit_price: 30_000, account_id: a["4000"] }],
    });
    expect(inv.status).toBe(201);
    const f = await owner.json("POST", `${base()}/invoices/${inv.body.id}/finalize`, {});
    expect(f.body.invoice.status).toBe("sent");

    const vendor = (await owner.json("POST", `${base()}/contacts`, { kind: "vendor", name: "Initech" })).body
      .id;
    const bill = await owner.json("POST", `${base()}/bills`, {
      vendor_id: vendor,
      issue_date: monthStart,
      due_date: addDays(t, 3),
      lines: [{ description: "Supplies", amount: 7_000, account_id: a["6090"] }],
    });
    expect(bill.status).toBe(201);
  });

  test("summarizes cash, income and expense, work waiting, and receivables", async () => {
    const viewer = await login(env, "dash-viewer@example.com");
    await addMember(env, orgId, viewer.userId, "viewer");
    const r = await viewer.json("GET", `${base()}/dashboard`);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.as_of).toBe(t);
    expect(d.basis).toBe("accrual");
    const cash = (earlier ? 50_000 : 0) + 100_000 - 20_000;
    expect(d.cash.total).toBe(cash);
    expect(d.cash.accounts.map((x: any) => [x.name, x.balance])).toEqual([["Checking", cash]]);
    expect(d.credit_cards.total).toBe(5_000);
    expect(d.credit_cards.accounts[0].name).toBe("Card");
    expect(d.month).toEqual({ from: monthStart, to: t, income: 130_000, expense: 32_000, net: 98_000 });
    const ytdIncome = 130_000 + (earlier ? 50_000 : 0);
    expect(d.year_to_date).toEqual({
      from: fyStart,
      to: t,
      income: ytdIncome,
      expense: 32_000,
      net: ytdIncome - 32_000,
    });
    expect(d.review_pending).toBe(1);
    expect(d.bank_needs_review).toBe(0);
    expect(d.overdue_invoices.count).toBe(1);
    expect(d.overdue_invoices.total).toBe(30_000);
    expect(d.overdue_invoices.top[0]).toMatchObject({
      customer_name: "Globex",
      balance_due: 30_000,
      days_overdue: 1,
    });
    expect(d.bills.overdue).toEqual({ count: 0, total: 0 });
    expect(d.bills.due_soon).toEqual({ count: 1, total: 7_000, days: 7 });
    expect(d.bank_connections).toEqual([]);
  });

  test("bank rows to review are counted", async () => {
    const banks = (await owner.json("GET", `${base()}/bank-accounts`)).body.data;
    const checking = banks.find((b: any) => b.name === "Checking");
    const date = `${t.slice(5, 7)}/${t.slice(8, 10)}/${t.slice(0, 4)}`;
    const imp = await owner.json("POST", `${base()}/bank-accounts/${checking.id}/import`, {
      filename: "chk.csv",
      content: `Date,Description,Amount\n${date},COFFEE SHOP,-4.50\n${date},CLIENT PAY,12.00\n`,
    });
    expect(imp.status).toBe(200);
    const d = (await owner.json("GET", `${base()}/dashboard`)).body;
    expect(d.bank_needs_review).toBe(2);
  });

  test("pending bank rows are reported separately and don't count as needing review", async () => {
    const banks = (await owner.json("GET", `${base()}/bank-accounts`)).body.data;
    const checking = banks.find((b: any) => b.name === "Checking");
    const h = await env.ctx.orgs.mustOpen(orgId);
    const id = newId();
    await h.write((tx) =>
      tx.insert(org.bankTransactions).values({
        id,
        bankAccountId: checking.id,
        date: t,
        amount: -2500,
        description: "PENDING CHARGE",
        normalizedDescription: "PENDING CHARGE",
        isPending: true,
        dedupeHash: `pending-${id}`,
      }),
    );
    const d = (await owner.json("GET", `${base()}/dashboard`)).body;
    expect(d.bank_needs_review).toBe(2);
    expect(d.bank_pending).toEqual({ count: 1, total: -2500 });
  });
});
