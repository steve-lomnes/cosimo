/**
 * Reserves (#114): targets from a posted P&L on both bases, parts with different rates, payments
 * with and without a bank account, book-mode true-ups (lines, source, the pending conflict, booked
 * including pending), a rejected payment entry removing its record, a posted one refusing delete,
 * reserve flows in the forecast with the capacity breakdown, propose_owner_draw with true-ups and
 * with a reserve payment, the monthly true-up job, MCP staying out of configuration, roles, and an
 * export round trip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taxYearOf, taxYearRange } from "@cosimo/core";
import { org } from "@cosimo/db";
import { addDays, parseIsoDate, today } from "@cosimo/shared";
import { eq } from "drizzle-orm";
import { runReserveTrueUps } from "../src/jobs/reserve-jobs.ts";
import { exportOrg, importOrgArchive } from "../src/services/export.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;
let viewer: Client;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-reserves-"));
const T = today();
const Y = taxYearOf(T, 1);
/** The tax year starts in today's month, so dates a few weeks out stay inside it whatever today is. */
const START = parseIsoDate(T).month;

interface Org {
  id: string;
  base: string;
  acct: Record<string, string>;
  bank: string;
  liabA: string;
  liabB: string;
  ownerDraw: string;
}

/** An org with $2,000 in checking (from equity, so no net income) and two liability accounts. */
async function freshOrg(name: string): Promise<Org> {
  const id = await createOrg(env, owner, name);
  await addMember(env, id, viewer.userId, "viewer");
  const base = `/api/v1/orgs/${id}`;
  const accounts = (await owner.json("GET", `${base}/accounts`)).body.data;
  const acct = Object.fromEntries(accounts.map((a: any) => [a.code, a.id])) as Record<string, string>;
  const liab = async (code: string, n: string) => {
    const r = await owner.json("POST", `${base}/accounts`, {
      code,
      name: n,
      type: "liability",
      subtype: "other_current_liability",
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const o: Org = {
    id,
    base,
    acct,
    bank: (
      await owner.json("POST", `${base}/bank-accounts`, {
        name: "Checking",
        kind: "checking",
        ledger_account_id: acct["1000"],
      })
    ).body.id,
    liabA: await liab("2450", "Tax Distributions Payable: Federal"),
    liabB: await liab("2460", "Tax Distributions Payable: State"),
    ownerDraw: accounts.find((a: any) => a.system_key === "owner_draw").id,
  };
  await entry(o, T, [
    [acct["1000"]!, 200_000],
    [acct["3100"]!, -200_000],
  ]);
  return o;
}

async function entry(o: Org, date: string, lines: [string, number][], memo = "Test") {
  const r = await owner.json("POST", `${o.base}/entries`, {
    date,
    memo,
    lines: lines.map(([account_id, amount]) => ({ account_id, amount })),
  });
  if (![200, 201, 202].includes(r.status)) throw new Error(JSON.stringify(r.body));
  return r.body;
}

/** Posted income received in cash. */
const income = (o: Org, amount: number, date = T) =>
  entry(o, date, [
    [o.acct["1000"]!, amount],
    [o.acct["4000"]!, -amount],
  ]);

/** A due date as month and day of `d`, inside the tax year when `year_offset` is 0. */
const due = (d: string, year_offset: 0 | 1 = 0) => {
  const { month, day } = parseIsoDate(d);
  return { month, day, year_offset };
};

async function reserve(o: Org, body: Record<string, unknown>, c = owner) {
  const r = await c.json("POST", `${o.base}/reserves`, body);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

const view = async (o: Org, id: string, q = "") => {
  const r = await owner.json("GET", `${o.base}/reserves/${id}/view${q}`);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
};
const getForecast = async (o: Org, q = "") => {
  const r = await owner.json("GET", `${o.base}/forecast${q}`);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
};
const flowsOf = (f: any) => f.buckets.flatMap((b: any) => b.flows) as any[];

async function auditFor(o: Org, action: string) {
  const h = await env.ctx.orgs.mustOpen(o.id);
  return h.db.select().from(org.auditLog).where(eq(org.auditLog.action, action)).all();
}

async function mcpToken(o: Org) {
  const t = await owner.json("POST", "/api/v1/tokens", {
    org_id: o.id,
    name: "assistant",
    role: "bookkeeper",
    propose_only: true,
  });
  return t.body.token as string;
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await env.app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return (body.result ?? { isError: true, content: [{ text: JSON.stringify(body.error) }] }) as {
    isError: boolean;
    structuredContent?: any;
    content: any[];
  };
}

const twoParts = (o: Org, mode: "track" | "book", dates = [due(addDays(T, 10))]) => ({
  name: "Owner taxes",
  mode,
  parts: [
    {
      label: "Federal",
      rate_bp: 2500,
      due_dates: dates,
      liability_account_id: mode === "book" ? o.liabA : null,
    },
    {
      label: "State",
      rate_bp: 1000,
      due_dates: dates,
      liability_account_id: mode === "book" ? o.liabB : null,
    },
  ],
});

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "reserves-owner@example.com");
  viewer = await login(env, "reserves-viewer@example.com");
});
afterAll(async () => {
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe(`reserves (${DB_MODE})`, () => {
  test("targets follow the posted P&L on the org's basis, per part rate; negative income gives 0", async () => {
    const o = await freshOrg("Reserve Target Co");
    const r = await reserve(o, twoParts(o, "track"));
    expect(r).toMatchObject({ mode: "track", tax_year_start_month: 1, true_up_schedule: "manual" });
    const v0 = await view(o, r.id);
    expect(v0.totals.target).toBe(0);

    await income(o, 100_000);
    // An unpaid invoice is income on the accrual basis only.
    const inv = await owner.json("POST", `${o.base}/invoices`, {
      customer_id: (await owner.json("POST", `${o.base}/contacts`, { kind: "customer", name: "Globex" })).body
        .id,
      issue_date: T,
      due_date: addDays(T, 30),
      lines: [{ description: "Work", quantity_milli: 1000, unit_price: 50_000, account_id: o.acct["4000"] }],
    });
    await owner.json("POST", `${o.base}/invoices/${inv.body.id}/finalize`, {});

    const cash = await view(o, r.id);
    expect(cash).toMatchObject({ basis: "cash", net_income: 100_000, tax_year: Y });
    expect(cash.parts.map((p: any) => [p.label, p.target, p.remaining])).toEqual([
      ["Federal", 25_000, 25_000],
      ["State", 10_000, 10_000],
    ]);
    expect(cash.totals).toMatchObject({ target: 35_000, paid: 0, booked: null, true_up_due: null });
    // The due date is 10 days out unless that is next year, when this year's date has passed.
    if (addDays(T, 10).startsWith(String(Y)))
      expect(cash.parts[0].next_due).toEqual({ date: addDays(T, 10), amount: 25_000 });

    expect((await owner.json("PATCH", `/api/v1/orgs/${o.id}`, { default_basis: "accrual" })).status).toBe(
      200,
    );
    const accrual = await view(o, r.id);
    expect(accrual).toMatchObject({ basis: "accrual", net_income: 150_000 });
    expect(accrual.parts.map((p: any) => p.target)).toEqual([37_500, 15_000]);

    // A loss gives a target of 0, not a refund.
    await entry(o, T, [
      [o.acct["6090"]!, 200_000],
      [o.acct["1000"]!, -200_000],
    ]);
    expect((await view(o, r.id)).totals.target).toBe(0);
  });

  test("validation: rates in range, real due dates, book mode needs its own liability account per part", async () => {
    const o = await freshOrg("Reserve Validation Co");
    const post = (b: Record<string, unknown>) => owner.json("POST", `${o.base}/reserves`, b);
    const part = { label: "Federal", rate_bp: 2500, due_dates: [due(addDays(T, 10))] };
    expect((await post({ name: "x", parts: [{ ...part, rate_bp: 10_001 }] })).status).toBe(400);
    expect(
      (await post({ name: "x", parts: [{ ...part, due_dates: [{ month: 2, day: 30, year_offset: 0 }] }] }))
        .status,
    ).toBe(422);
    expect((await post({ name: "x", mode: "book", parts: [part] })).status).toBe(422);
    expect(
      (await post({ name: "x", mode: "book", parts: [{ ...part, liability_account_id: o.acct["1000"] }] }))
        .status,
    ).toBe(422);
    expect(
      (
        await post({
          name: "x",
          mode: "book",
          parts: [
            { ...part, liability_account_id: o.liabA },
            { ...part, label: "State", liability_account_id: o.liabA },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await post({ name: "x", true_up_schedule: "monthly", parts: [part] })).status).toBe(422);

    // Editing: a part left out is archived; its id can't come back from another reserve.
    const r = await reserve(o, { name: "Taxes", parts: [part, { ...part, label: "State" }] });
    const patched = await owner.json("PATCH", `${o.base}/reserves/${r.id}`, {
      parts: [{ id: r.parts[0].id, label: "Federal", rate_bp: 3000, due_dates: part.due_dates }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.parts).toHaveLength(1);
    expect(patched.body.parts[0]).toMatchObject({ id: r.parts[0].id, rate_bp: 3000 });
    expect((await auditFor(o, "reserve.update")).length).toBe(1);
    const archived = await owner.json("DELETE", `${o.base}/reserves/${r.id}`);
    expect(archived.body.archived_at).not.toBeNull();
    expect((await owner.json("GET", `${o.base}/reserves`)).body.data).toHaveLength(0);
  });

  test("track mode: a payment paid personally is only a record; from a bank account it is an entry", async () => {
    const o = await freshOrg("Reserve Track Pay Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "track"));
    const fed = r.parts[0].id;

    const personal = await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: fed,
      tax_year: Y,
      date: T,
      amount: 5_000,
      note: "Paid from personal account",
    });
    expect(personal.status).toBe(201);
    expect(personal.body.entry).toBeNull();
    expect(personal.body.payment).toMatchObject({ entry_id: null, can_delete: true, tax_year: Y });
    expect((await auditFor(o, "reserve.payment.create")).length).toBe(1);

    const fromBank = await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: fed,
      tax_year: Y,
      date: T,
      amount: 3_000,
      from_bank_account_id: o.bank,
    });
    expect(fromBank.status).toBe(201);
    expect(fromBank.body.entry.entry).toMatchObject({
      source_type: "reserve_payment",
      source_id: fromBank.body.payment.id,
      status: "posted",
    });
    const lines = fromBank.body.entry.entry.lines.map((l: any) => [l.account_id, l.amount]);
    expect(lines).toContainEqual([o.ownerDraw, 3_000]);
    expect(lines).toContainEqual([o.acct["1000"], -3_000]);

    // A payment for the year before (made in January, say) counts in that year, not this one.
    await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: fed,
      tax_year: Y - 1,
      date: T,
      amount: 1_000,
    });
    const v = await view(o, r.id);
    expect(v.parts[0]).toMatchObject({ target: 25_000, paid: 8_000, remaining: 17_000 });
    expect((await view(o, r.id, `?tax_year=${Y - 1}`)).parts[0].paid).toBe(1_000);
    const listed = (await owner.json("GET", `${o.base}/reserves/${r.id}/payments?tax_year=${Y}`)).body.data;
    expect(listed).toHaveLength(2);

    // The posted one can't be deleted until its entry is reversed.
    const posted = fromBank.body.payment.id;
    const del = await owner.json("DELETE", `${o.base}/reserve-payments/${posted}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("payment_has_entry");
    const rev = await owner.json("POST", `${o.base}/entries/${fromBank.body.payment.entry_id}/reverse`, {});
    expect([200, 201]).toContain(rev.status);
    expect((await owner.json("DELETE", `${o.base}/reserve-payments/${posted}`)).status).toBe(200);
    expect(
      (await owner.json("DELETE", `${o.base}/reserve-payments/${personal.body.payment.id}`)).status,
    ).toBe(200);
    expect((await auditFor(o, "reserve.payment.delete")).length).toBe(2);
    expect((await view(o, r.id)).parts[0].paid).toBe(0);
  });

  test("book mode: true-up lines and source, booked counts pending, the pending conflict, then a later true-up", async () => {
    const o = await freshOrg("Reserve Book Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "book"));
    const token = await mcpToken(o);

    const proposed = await call(token, "propose_reserve_true_up", {
      reserve_id: r.id,
      rationale: "Month end",
    });
    expect(proposed.isError).toBe(false);
    expect(proposed.structuredContent.status).toBe("pending_review");
    const e = (await owner.json("GET", `${o.base}/entries/${proposed.structuredContent.entry_id}`)).body;
    expect(e).toMatchObject({ source_type: "reserve_true_up", source_id: r.id, date: T });
    expect(e.memo).toBe(`Reserve true-up: Owner taxes through ${T}`);
    const lines = e.lines.map((l: any) => [l.account_id, l.amount]);
    expect(lines).toEqual([
      [o.ownerDraw, 25_000],
      [o.liabA, -25_000],
      [o.ownerDraw, 10_000],
      [o.liabB, -10_000],
    ]);

    const pending = await view(o, r.id);
    expect(pending.true_up_pending).toBe(true);
    expect(pending.parts[0]).toMatchObject({
      booked: 25_000,
      booked_pending: 25_000,
      true_up_due: 0,
      liability_balance: 0,
    });

    const again = await owner.json("POST", `${o.base}/reserves/${r.id}/true-up`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("true_up_pending");

    const review = proposed.structuredContent.review_item_id;
    const item = (await owner.json("GET", `${o.base}/review/${review}`)).body;
    expect(item.payload.reserve_true_up).toMatchObject({ reserve_id: r.id, tax_year: Y });
    expect((await owner.json("POST", `${o.base}/review/${review}/approve`, {})).status).toBe(200);
    const posted = await view(o, r.id);
    expect(posted.parts[0]).toMatchObject({ booked: 25_000, booked_pending: 0, liability_balance: 25_000 });

    // More income: the next true-up books only the difference.
    await income(o, 20_000);
    const more = await owner.json("POST", `${o.base}/reserves/${r.id}/true-up`, {});
    expect(more.status).toBe(201);
    expect(more.body.entry.lines.map((l: any) => l.amount)).toEqual([5_000, -5_000, 2_000, -2_000]);
    expect((await owner.json("POST", `${o.base}/reserves/${r.id}/true-up`, {})).body.error.code).toBe(
      "nothing_to_true_up",
    );

    // A book-mode payment debits the liability, and held is booked less paid.
    const pay = await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: r.parts[0].id,
      tax_year: Y,
      date: T,
      amount: 12_000,
      from_bank_account_id: o.bank,
    });
    expect(pay.body.entry.entry.lines.map((l: any) => [l.account_id, l.amount])).toContainEqual([
      o.liabA,
      12_000,
    ]);
    const v = await view(o, r.id);
    expect(v.parts[0]).toMatchObject({
      target: 30_000,
      booked: 30_000,
      paid: 12_000,
      held: 18_000,
      true_up_due: 0,
      liability_balance: 18_000,
    });

    // Reversing a true-up takes it out of booked.
    const rev = await owner.json("POST", `${o.base}/entries/${more.body.entry.id}/reverse`, {});
    expect([200, 201]).toContain(rev.status);
    expect((await view(o, r.id)).parts[0]).toMatchObject({ booked: 25_000, true_up_due: 5_000 });

    // Track mode has no true-ups.
    const t = await reserve(o, { ...twoParts(o, "track"), name: "Tracked" });
    expect((await owner.json("POST", `${o.base}/reserves/${t.id}/true-up`, {})).body.error.code).toBe(
      "not_book_mode",
    );
  });

  test("a rejected payment entry removes the payment record, audited", async () => {
    const o = await freshOrg("Reserve Reject Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "book"));
    const token = await mcpToken(o);
    const paid = await call(token, "record_reserve_payment", {
      part_id: r.parts[0].id,
      tax_year: Y,
      date: T,
      amount: 4_000,
      from_bank_account_id: o.bank,
      rationale: "Estimated payment",
    });
    expect(paid.isError).toBe(false);
    expect(paid.structuredContent).toMatchObject({ status: "pending_review", payment: { amount: 4_000 } });
    const id = paid.structuredContent.payment.id;
    expect((await view(o, r.id)).parts[0].paid).toBe(4_000);
    // Waiting in review, the record can't be deleted by itself.
    expect((await owner.json("DELETE", `${o.base}/reserve-payments/${id}`)).status).toBe(409);

    const item = (await owner.json("GET", `${o.base}/review/${paid.structuredContent.review_item_id}`)).body;
    expect(item.payload.reserve_payment).toMatchObject({
      payment_id: id,
      part_label: "Federal",
      tax_year: Y,
    });
    expect(
      (
        await owner.json("POST", `${o.base}/review/${paid.structuredContent.review_item_id}/reject`, {
          note: "No",
        })
      ).status,
    ).toBe(200);
    expect((await owner.json("GET", `${o.base}/reserves/${r.id}/payments`)).body.data).toHaveLength(0);
    expect((await view(o, r.id)).parts[0].paid).toBe(0);
    const audit = await auditFor(o, "reserve.payment.delete");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.afterJson ?? "{}")).toMatchObject({ reason: "entry_rejected" });

    // Paid personally in book mode: an earlier draw settled the declared distribution, so the
    // payment proposes debit the liability, credit Owner Draw. Otherwise the liability would stay
    // on the balance sheet and the draw would count twice in equity.
    const personal = await call(token, "record_reserve_payment", {
      part_id: r.parts[1].id,
      tax_year: Y,
      date: T,
      amount: 2_000,
      rationale: "Paid from the owner's own account",
    });
    expect(personal.isError).toBe(false);
    expect(personal.structuredContent.entry_id).toBeTruthy();
    const pe = await owner.json("GET", `${o.base}/entries/${personal.structuredContent.entry_id}`);
    const ownerDraw = (await owner.json("GET", `${o.base}/accounts`)).body.data.find(
      (x: any) => x.subtype === "owner_draw",
    ).id;
    expect(
      pe.body.lines.map((l: any) => [l.account_id, l.amount]).sort((x: any, y: any) => x[1] - y[1]),
    ).toEqual([
      [ownerDraw, -2_000],
      [r.parts[1].liability_account_id, 2_000],
    ]);
    expect((await view(o, r.id)).parts[1].paid).toBe(2_000);
  });
});

describe(`reserves in the forecast (${DB_MODE})`, () => {
  test("installments of this year and the previous year's still to come, and what the window doesn't pay", async () => {
    const o = await freshOrg("Reserve Forecast Co");
    const range = taxYearRange(Y, START);
    // Income in the previous tax year and this one.
    await income(o, 40_000, addDays(range.start, -15));
    await income(o, 100_000);
    const soon = addDays(T, 10);
    const later = addDays(T, 40);
    const r = await reserve(o, {
      name: "Taxes",
      tax_year_start_month: START,
      parts: [{ label: "Federal", rate_bp: 2500, due_dates: [due(soon, 1), due(later, 0)] }],
    });
    const prevYear = taxYearOf(T, START) - 1;
    await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: r.parts[0].id,
      tax_year: prevYear,
      date: T,
      amount: 4_000,
    });

    const f = await getForecast(o);
    const res = flowsOf(f).filter((x: any) => x.source === "reserve");
    // The previous year owes 10,000 less 4,000 paid, on its year_offset 1 date; this year owes 25,000 on its next date.
    expect(res.map((x: any) => [x.date, x.amount, x.tax_year, x.firmness])).toEqual([
      [soon, -6_000, prevYear, "reserve"],
      [later, -25_000, prevYear + 1, "reserve"],
    ]);
    expect(res[0].target).toEqual({ type: "reserve_part", id: r.parts[0].id, date: soon });
    const opening = 200_000 + 40_000 + 100_000;
    expect(f.opening_cash).toBe(opening);
    expect(f.draw_capacity.breakdown).toEqual({
      low_point: opening - 31_000,
      buffer: 0,
      reserves_not_in_window: 0,
    });
    expect(f.draw_capacity.amount).toBe(opening - 31_000);

    // A one-week window pays neither; this year's 25,000 is held back, the previous year's isn't.
    const week = await getForecast(o, "?bucket=week&periods=1");
    expect(week.draw_capacity.breakdown.reserves_not_in_window).toBe(25_000);
    expect(week.draw_capacity.amount).toBe(week.low_point.balance - 25_000);

    // Excluding this year's installment in the baseline holds it back too; shifting the old one moves it.
    for (const body of [
      { target_type: "reserve_part", target_id: r.parts[0].id, target_date: later, action: "exclude" },
      {
        target_type: "reserve_part",
        target_id: r.parts[0].id,
        target_date: soon,
        action: "shift",
        shift_days: 3,
      },
    ])
      expect((await owner.json("POST", `${o.base}/forecast/overrides`, body)).status).toBe(201);
    expect(
      (
        await owner.json("POST", `${o.base}/forecast/overrides`, {
          target_type: "reserve_part",
          target_id: "nope",
          action: "exclude",
        })
      ).status,
    ).toBe(404);
    const after = await getForecast(o);
    expect(
      flowsOf(after)
        .filter((x: any) => x.source === "reserve")
        .map((x: any) => [x.date, x.amount]),
    ).toEqual([[addDays(soon, 3), -6_000]]);
    expect(after.draw_capacity.breakdown.reserves_not_in_window).toBe(25_000);
    expect(after.draw_capacity.amount).toBe(opening - 6_000 - 25_000);
  });

  test("propose_owner_draw with include_true_ups and with pay_reserves", async () => {
    const o = await freshOrg("Reserve Draw Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "book"));
    const token = await mcpToken(o);

    const d = await call(token, "propose_owner_draw", {
      date: T,
      amount: 20_000,
      bank_account_id: o.bank,
      include_true_ups: true,
      rationale: "Monthly draw",
    });
    expect(d.isError).toBe(false);
    expect(d.structuredContent.draw.status).toBe("pending_review");
    expect(d.structuredContent.true_ups).toHaveLength(1);
    const tu = d.structuredContent.true_ups[0];
    expect(tu).toMatchObject({ reserve_id: r.id, status: "pending_review" });
    const tuItem = (await owner.json("GET", `${o.base}/review/${tu.review_item_id}`)).body;
    expect(tuItem.payload.forecast_snapshot.draw_capacity).toBeDefined();
    expect(tuItem.payload.entry.source_type).toBe("reserve_true_up");
    const drawItem = (await owner.json("GET", `${o.base}/review/${d.structuredContent.draw.review_item_id}`))
      .body;
    expect(drawItem.payload.entry.source_type).toBe("owner_draw");

    // Booked counts the pending true-up, so nothing is off target now.
    const d1 = await call(token, "propose_owner_draw", {
      date: T,
      amount: 1_000,
      bank_account_id: o.bank,
      include_true_ups: true,
      rationale: "Another",
    });
    expect(d1.structuredContent.true_ups).toEqual([]);
    // More income while that true-up still waits: this one is skipped, not refused.
    await income(o, 10_000);
    const d2 = await call(token, "propose_owner_draw", {
      date: T,
      amount: 1_000,
      bank_account_id: o.bank,
      include_true_ups: true,
      rationale: "Another",
    });
    expect(d2.isError).toBe(false);
    expect(d2.structuredContent.true_ups).toEqual([
      expect.objectContaining({ reserve_id: r.id, status: "skipped" }),
    ]);

    // pay_reserves: part of the draw pays out tax money held for the owner (Dr the part's
    // liability / Cr bank), and the remainder is an ordinary owner draw.
    const p = await call(token, "propose_owner_draw", {
      date: T,
      amount: 10_000,
      bank_account_id: o.bank,
      pay_reserves: [{ part_id: r.parts[0].id, tax_year: Y, amount: 7_000 }],
      rationale: "Estimated tax and a draw",
    });
    expect(p.isError).toBe(false);
    const pay = p.structuredContent.reserve_payments;
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ status: "pending_review", payment: { amount: 7_000, tax_year: Y } });
    const pe = (await owner.json("GET", `${o.base}/entries/${pay[0].entry_id}`)).body;
    expect(pe).toMatchObject({ source_type: "reserve_payment", source_id: pay[0].payment.id, date: T });
    expect(pe.lines.map((l: any) => [l.account_id, l.amount])).toEqual([
      [o.liabA, 7_000],
      [o.acct["1000"], -7_000],
    ]);
    const payItem = (await owner.json("GET", `${o.base}/review/${pay[0].review_item_id}`)).body;
    expect(payItem.payload.forecast_snapshot).toBeDefined();
    expect(payItem.payload.reserve_payment.payment_id).toBe(pay[0].payment.id);
    const de = (await owner.json("GET", `${o.base}/entries/${p.structuredContent.draw.entry_id}`)).body;
    expect(de.source_type).toBe("owner_draw");
    expect(de.lines.map((l: any) => l.amount).sort((a: number, b: number) => a - b)).toEqual([-3_000, 3_000]);

    // REST takes the same options. Payments that take the whole amount leave no draw entry.
    const rest = await owner.json("POST", `${o.base}/forecast/draws`, {
      date: T,
      amount: 3_000,
      bank_account_id: o.bank,
      pay_reserves: [
        { part_id: r.parts[0].id, tax_year: Y, amount: 1_000 },
        { part_id: r.parts[1].id, tax_year: Y, amount: 2_000 },
      ],
    });
    expect(rest.status).toBe(201);
    expect(rest.body.draw).toBeNull();
    expect(rest.body.payments.map((x: any) => [x.payment.part_id, x.payment.amount])).toEqual([
      [r.parts[0].id, 1_000],
      [r.parts[1].id, 2_000],
    ]);
    const restEntry = (await owner.json("GET", `${o.base}/entries/${rest.body.payments[1].entry_id}`)).body;
    expect(restEntry.source_type).toBe("reserve_payment");
    expect(restEntry.lines.map((l: any) => [l.account_id, l.amount])).toEqual([
      [o.liabB, 2_000],
      [o.acct["1000"], -2_000],
    ]);

    // Payments over the draw amount are refused, and nothing is proposed.
    const before = (await owner.json("GET", `${o.base}/entries?source_type=reserve_payment`)).body.data
      .length;
    const over = await owner.json("POST", `${o.base}/forecast/draws`, {
      date: T,
      amount: 1_000,
      bank_account_id: o.bank,
      pay_reserves: [{ part_id: r.parts[0].id, tax_year: Y, amount: 1_001 }],
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("invalid_amount");
    expect((await owner.json("GET", `${o.base}/entries?source_type=reserve_payment`)).body.data).toHaveLength(
      before,
    );
  });
});

describe(`reserve true-up job, MCP, roles, and export (${DB_MODE})`, () => {
  test("the monthly job proposes on the 1st, once, and skips while one is pending", async () => {
    const o = await freshOrg("Reserve Job Co");
    const first = `${T.slice(0, 7)}-01`;
    const through = addDays(first, -1);
    await income(o, 80_000, through);
    const r = await reserve(o, { ...twoParts(o, "book"), true_up_schedule: "monthly" });
    expect(await runReserveTrueUps(env.ctx, o.id, addDays(first, 1))).toEqual({
      proposed: 0,
      skipped: 0,
      unchanged: 0,
    });
    expect(await runReserveTrueUps(env.ctx, o.id, first)).toMatchObject({ proposed: 1 });
    const entries = (await owner.json("GET", `${o.base}/entries?source_type=reserve_true_up`)).body.data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "pending_review", date: through, source_id: r.id });
    expect(await runReserveTrueUps(env.ctx, o.id, first)).toMatchObject({ proposed: 0, skipped: 1 });
    expect((await owner.json("GET", `${o.base}/entries?source_type=reserve_true_up`)).body.data).toHaveLength(
      1,
    );
  });

  test("MCP reads reserves but can't create or configure one; viewers read and are refused writes", async () => {
    const o = await freshOrg("Reserve Roles Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "track"));
    const token = await mcpToken(o);

    const tools = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = ((await tools.json()) as any).result.tools.map((t: any) => t.name) as string[];
    expect(names.filter((n) => n.includes("reserve")).sort()).toEqual([
      "get_reserves",
      "propose_reserve_true_up",
      "record_reserve_payment",
    ]);
    expect((await call(token, "create_reserve", { name: "x" })).isError).toBe(true);
    const got = await call(token, "get_reserves", {});
    expect(got.isError).toBe(false);
    expect(got.structuredContent.data[0]).toMatchObject({
      reserve: { id: r.id },
      totals: { target: 35_000 },
    });

    expect((await viewer.json("GET", `${o.base}/reserves`)).status).toBe(200);
    expect((await viewer.json("GET", `${o.base}/reserves/${r.id}/view`)).status).toBe(200);
    expect((await viewer.json("POST", `${o.base}/reserves`, twoParts(o, "track"))).status).toBe(403);
    expect((await viewer.json("PATCH", `${o.base}/reserves/${r.id}`, { name: "y" })).status).toBe(403);
    expect(
      (
        await viewer.json("POST", `${o.base}/reserves/${r.id}/payments`, {
          part_id: r.parts[0].id,
          tax_year: Y,
          date: T,
          amount: 1,
        })
      ).status,
    ).toBe(403);
    expect((await viewer.json("POST", `${o.base}/reserves/${r.id}/true-up`, {})).status).toBe(403);
  });

  test("export and import keep reserves, parts, and payments", async () => {
    const o = await freshOrg("Reserve Export Co");
    await income(o, 100_000);
    const r = await reserve(o, twoParts(o, "book"));
    await owner.json("POST", `${o.base}/reserves/${r.id}/true-up`, {});
    await owner.json("POST", `${o.base}/reserves/${r.id}/payments`, {
      part_id: r.parts[0].id,
      tax_year: Y,
      date: T,
      amount: 3_000,
      from_bank_account_id: o.bank,
    });
    const before = await view(o, r.id);
    const zip = join(tmp, "reserves.zip");
    const manifest = await exportOrg(env.ctx, o.id, zip);
    expect(manifest.tables.reserves!.rows).toBe(1);
    expect(manifest.tables.reserve_parts!.rows).toBe(2);
    expect(manifest.tables.reserve_payments!.rows).toBe(1);
    await env.ctx.orgs.destroy(o.id);
    const res = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), { userId: owner.userId });
    expect(res.chains_ok).toBe(true);
    const after = await view(o, r.id);
    expect(after.parts).toEqual(before.parts);
  });
});
