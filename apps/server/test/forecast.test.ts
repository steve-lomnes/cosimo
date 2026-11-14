/**
 * Cash forecast (#113): roles, the lazily created baseline, flows from open invoices and bills (with
 * their lags and due dates), recurring templates, and entries waiting in review, scenario overlays,
 * duplicate and promote, links to what happened, suggested matches, attention items, the agent
 * ownership rule over MCP, owner draws with their forecast snapshot, and an export round trip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { org } from "@cosimo/db";
import { addDays, today } from "@cosimo/shared";
import { eq } from "drizzle-orm";
import { exportOrg, importOrgArchive } from "../src/services/export.ts";
import {
  addMember,
  type Client,
  createOrg,
  createTestEnv,
  DB_MODE,
  login,
  type TestEnv,
  tokenClient,
} from "./harness.ts";

let env: TestEnv;
let owner: Client;
let viewer: Client;
let bookkeeper: Client;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-forecast-"));
const T = today();

interface Org {
  id: string;
  base: string;
  acct: Record<string, string>;
  bank: string;
  customer: string;
  vendor: string;
}

/** An org with a checking account holding $2,000, a customer, and a vendor. */
async function freshOrg(name: string): Promise<Org> {
  const id = await createOrg(env, owner, name);
  await addMember(env, id, viewer.userId, "viewer");
  await addMember(env, id, bookkeeper.userId, "bookkeeper");
  const base = `/api/v1/orgs/${id}`;
  const acct = Object.fromEntries(
    (await owner.json("GET", `${base}/accounts`)).body.data.map((a: any) => [a.code, a.id]),
  ) as Record<string, string>;
  const bank = (
    await owner.json("POST", `${base}/bank-accounts`, {
      name: "Checking",
      kind: "checking",
      ledger_account_id: acct["1000"],
    })
  ).body.id;
  const o = {
    id,
    base,
    acct,
    bank,
    customer: (await owner.json("POST", `${base}/contacts`, { kind: "customer", name: "Globex" })).body.id,
    vendor: (await owner.json("POST", `${base}/contacts`, { kind: "vendor", name: "Landlord LLC" })).body.id,
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

async function invoice(o: Org, amount: number, dueDate: string) {
  const r = await owner.json("POST", `${o.base}/invoices`, {
    customer_id: o.customer,
    issue_date: addDays(T, -20),
    due_date: dueDate,
    lines: [{ description: "Work", quantity_milli: 1000, unit_price: amount, account_id: o.acct["4000"] }],
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await owner.json("POST", `${o.base}/invoices/${r.body.id}/finalize`, {});
  return r.body;
}

async function bill(o: Org, amount: number, dueDate: string) {
  const r = await owner.json("POST", `${o.base}/bills`, {
    vendor_id: o.vendor,
    bill_number: "B-1",
    issue_date: addDays(T, -10),
    due_date: dueDate,
    lines: [{ description: "Rent", amount, account_id: o.acct["6090"] }],
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.bill;
}

const get = async (o: Org, q = "") => {
  const r = await owner.json("GET", `${o.base}/forecast${q}`);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
};
const flowsOf = (f: any) => f.buckets.flatMap((b: any) => b.flows) as any[];
const item = async (o: Org, body: Record<string, unknown>, c = owner) => {
  const r = await c.json("POST", `${o.base}/forecast/items`, body);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
};

async function auditFor(o: Org, action: string) {
  const h = await env.ctx.orgs.mustOpen(o.id);
  return h.db.select().from(org.auditLog).where(eq(org.auditLog.action, action)).all();
}

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "forecast-owner@example.com");
  viewer = await login(env, "forecast-viewer@example.com");
  bookkeeper = await login(env, "forecast-bk@example.com");
});
afterAll(async () => {
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe(`forecast flows and scenarios (${DB_MODE})`, () => {
  test("roles: a viewer reads the forecast and is refused writes; the baseline is created on the first write", async () => {
    const o = await freshOrg("Forecast Roles Co");
    const list0 = (await viewer.json("GET", `${o.base}/forecast/scenarios`)).body.data;
    expect(list0).toHaveLength(1);
    expect(list0[0]).toMatchObject({ is_baseline: true, exists: false });
    const f0 = await viewer.json("GET", `${o.base}/forecast`);
    expect(f0.status).toBe(200);
    expect(f0.body).toMatchObject({ opening_cash: 200_000, scenario: { is_baseline: true } });
    expect(f0.body.window).toMatchObject({ key: "w13", bucket: "week", periods: 13 });
    expect(f0.body.buckets).toHaveLength(13);
    expect(f0.body.draw_capacity.amount).toBe(200_000);

    const body = { name: "Retainer", direction: "in", amount: 1000, start_date: addDays(T, 3) };
    expect((await viewer.json("POST", `${o.base}/forecast/items`, body)).status).toBe(403);
    expect((await viewer.json("POST", `${o.base}/forecast/scenarios`, { name: "x" })).status).toBe(403);
    expect((await owner.json("GET", `${o.base}/forecast/scenarios`)).body.data[0].exists).toBe(false);

    expect((await bookkeeper.json("POST", `${o.base}/forecast/items`, body)).status).toBe(201);
    const list1 = (await owner.json("GET", `${o.base}/forecast/scenarios`)).body.data;
    expect(list1).toHaveLength(1);
    expect(list1[0]).toMatchObject({ is_baseline: true, exists: true });
    expect((await auditFor(o, "forecast.item.create")).length).toBe(1);
    expect((await auditFor(o, "forecast.scenario.create")).length).toBe(1);
  });

  test("open invoices and bills (with their lags), recurring templates, and pending cash entries become flows", async () => {
    const o = await freshOrg("Forecast Flows Co");
    const due = addDays(T, 5);
    const inv = await invoice(o, 100_000, due);
    const b = await bill(o, 30_000, addDays(T, 2));
    const overdue = await invoice(o, 20_000, addDays(T, -9));
    // A monthly bill template whose first run is in the future, due 10 days after.
    const next = addDays(T, 7);
    const tpl = await owner.json("POST", `${o.base}/recurring-templates`, {
      kind: "bill",
      name: "Rent",
      contact_id: o.vendor,
      run_mode: "draft",
      schedule: { unit: "month", interval: 1, start_date: next },
      template: {
        due_days: 10,
        lines: [{ description: "Rent", amount: 50_000, account_id: o.acct["6090"] }],
      },
    });
    expect(tpl.status).toBe(201);
    // 300000 is over the review threshold, so it waits in review and counts as a pending inflow.
    await entry(o, addDays(T, 1), [
      [o.acct["1000"]!, 300_000],
      [o.acct["3100"]!, -300_000],
    ]);

    await owner.json("PATCH", `${o.base}/forecast/scenarios/baseline`, {
      assumptions: { collection_lag_days: 3, bill_lag_days: 2 },
    });
    const f = await get(o);
    expect(f.assumptions).toEqual({ collection_lag_days: 3, bill_lag_days: 2, min_cash_buffer: 0 });
    const flows = flowsOf(f);
    const by = (id: string) => flows.find((x: any) => x.id === id);
    expect(by(`inv:${inv.id}`)).toMatchObject({
      amount: 100_000,
      date: addDays(due, 3),
      due_date: due,
      firmness: "booked",
    });
    expect(by(`bill:${b.id}`)).toMatchObject({
      amount: -30_000,
      date: addDays(T, 4),
      due_date: addDays(T, 2),
      source: "bill",
    });
    // Overdue by 9 days, plus 3 days of lag, is still before today: it lands today.
    expect(by(`inv:${overdue.id}`)).toMatchObject({
      amount: 20_000,
      date: T,
      days_overdue: 9,
      due_date: addDays(T, -9),
    });
    // The template's bill is due 10 days after it runs, and paid the bill lag after that.
    const rent = flows.find((x: any) => x.ref === tpl.body.id);
    expect(rent).toMatchObject({
      amount: -50_000,
      date: addDays(next, 12),
      due_date: addDays(next, 10),
      firmness: "scheduled",
    });
    const pendingFlow = flows.find((x: any) => x.firmness === "pending");
    expect(pendingFlow).toMatchObject({ amount: 300_000, date: addDays(T, 1), source: "pending" });
    expect(pendingFlow.due_date ?? null).toBeNull();
    expect(f.attention.some((a: any) => a.kind === "invoice_overdue" && a.ref === overdue.id)).toBe(true);
    // The low point is the opening balance until money comes in; the pending inflow lifts it.
    expect(f.low_point.balance).toBeLessThanOrEqual(200_000);
    expect(f.buckets.at(-1).ending).toBe(f.buckets.reduce((s: number, x: any) => s + x.net, 0) + 200_000);
    expect(f.draw_capacity.breakdown).toEqual({
      low_point: f.low_point.balance,
      buffer: 0,
      reserves_not_in_window: 0,
    });
    // Totals reconcile: inflow minus outflow of the buckets equals the last ending less the opening.
    expect(f.drivers.length).toBeGreaterThan(0);
  });

  test("lags default to 0, a lag moves invoices and bills, negative lags clamp to today, old keys are ignored", async () => {
    const o = await freshOrg("Forecast Lag Co");
    const inv = await invoice(o, 10_000, addDays(T, 2));
    const b = await bill(o, 4_000, addDays(T, 6));
    let f = await get(o);
    expect(f.assumptions).toEqual({ collection_lag_days: 0, bill_lag_days: 0, min_cash_buffer: 0 });
    let flows = flowsOf(f);
    expect(flows.find((x: any) => x.ref === inv.id)).toMatchObject({
      date: addDays(T, 2),
      due_date: addDays(T, 2),
    });
    expect(flows.find((x: any) => x.ref === b.id)).toMatchObject({
      date: addDays(T, 6),
      due_date: addDays(T, 6),
    });

    // Paying early: a bill 4 days early lands 2 days out; an invoice 4 days early lands today, not before.
    expect(
      (
        await owner.json("PATCH", `${o.base}/forecast/scenarios/baseline`, {
          assumptions: { collection_lag_days: -4, bill_lag_days: -4 },
        })
      ).status,
    ).toBe(200);
    flows = flowsOf(await get(o));
    expect(flows.find((x: any) => x.ref === inv.id)!.date).toBe(T);
    expect(flows.find((x: any) => x.ref === b.id)!.date).toBe(addDays(T, 2));
    expect(
      (
        await owner.json("PATCH", `${o.base}/forecast/scenarios/baseline`, {
          assumptions: { bill_lag_days: -91 },
        })
      ).status,
    ).toBe(400);

    // A shift override moves the expected date and never the due date.
    const sc = (await owner.json("POST", `${o.base}/forecast/scenarios`, { name: "Late payer" })).body;
    await owner.json("POST", `${o.base}/forecast/overrides`, {
      scenario_id: sc.id,
      target_type: "invoice",
      target_id: inv.id,
      action: "shift",
      shift_days: 10,
    });
    const shifted = flowsOf(await get(o, `?scenario_id=${sc.id}`)).find((x: any) => x.ref === inv.id);
    expect(shifted).toMatchObject({ date: addDays(T, 10), due_date: addDays(T, 2) });

    // Stored assumptions from before the late share was dropped still read: the old keys are ignored.
    const h = await env.ctx.orgs.mustOpen(o.id);
    await h.write((tx) =>
      tx
        .update(org.forecastScenarios)
        .set({
          assumptionsJson: JSON.stringify({ collection_lag_days: 1, late_share_pct: 50, late_days: 30 }),
        })
        .where(eq(org.forecastScenarios.isBaseline, true)),
    );
    f = await get(o);
    expect(f.assumptions).toEqual({ collection_lag_days: 1, bill_lag_days: 0, min_cash_buffer: 0 });
    expect(flowsOf(f).filter((x: any) => x.ref === inv.id)).toHaveLength(1);
    const baseline = (await owner.json("GET", `${o.base}/forecast/scenarios`)).body.data[0];
    expect(baseline.assumptions).toEqual({ collection_lag_days: 1 });
  });

  test("a payment waiting in review leaves the invoice's open balance, so it isn't counted twice", async () => {
    const o = await freshOrg("Forecast Pending Pay Co");
    const inv = await invoice(o, 40_000, addDays(T, 4));
    // A payment entry waits in review when an assistant records it: here, over the threshold path
    // is avoided, so mark it pending through the API with a propose-only token.
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: o.id,
      name: "assistant",
      role: "bookkeeper",
      propose_only: true,
    });
    const tc = tokenClient(env, t.body.token);
    const pay = await tc.json("POST", `${o.base}/payments`, {
      direction: "received",
      contact_id: o.customer,
      date: T,
      amount: 40_000,
      account_id: o.acct["1000"],
      applications: [{ document_id: inv.id, amount: 40_000 }],
    });
    expect(pay.status).toBeLessThan(300);
    const flows = flowsOf(await get(o));
    expect(flows.filter((x: any) => x.ref === inv.id)).toEqual([]);
    expect(flows.filter((x: any) => x.firmness === "pending").map((x: any) => x.amount)).toEqual([40_000]);
  });

  test("scenarios hold only their changes: an item, an exclude override, an assumption override", async () => {
    const o = await freshOrg("Forecast Overlay Co");
    const b = await bill(o, 30_000, addDays(T, 2));
    const sc = (await owner.json("POST", `${o.base}/forecast/scenarios`, { name: "Quiet month" })).body;
    expect(sc).toMatchObject({ is_baseline: false, created_by_actor: "user" });
    await item(o, {
      scenario_id: sc.id,
      name: "New laptop",
      direction: "out",
      amount: 25_000,
      start_date: addDays(T, 4),
    });
    await owner.json("POST", `${o.base}/forecast/overrides`, {
      scenario_id: sc.id,
      target_type: "bill",
      target_id: b.id,
      action: "exclude",
    });
    await owner.json("PATCH", `${o.base}/forecast/scenarios/${sc.id}`, {
      assumptions: { min_cash_buffer: 10_000 },
    });

    const base = await get(o);
    expect(flowsOf(base).map((x: any) => x.label)).toEqual([`Bill B-1 (Landlord LLC)`]);
    expect(base.assumptions.min_cash_buffer).toBe(0);
    const f = await get(o, `?scenario_id=${sc.id}`);
    expect(flowsOf(f).map((x: any) => x.label)).toEqual(["New laptop"]);
    expect(f).toMatchObject({ scenario: { id: sc.id, name: "Quiet month" } });
    expect(f.assumptions.min_cash_buffer).toBe(10_000);
    expect(f.draw_capacity).toMatchObject({
      amount: 200_000 - 25_000 - 10_000,
      breakdown: { buffer: 10_000 },
    });

    // A shift moves the flow to another bucket.
    const shift = await owner.json("POST", `${o.base}/forecast/overrides`, {
      scenario_id: sc.id,
      target_type: "bill",
      target_id: b.id,
      action: "shift",
      shift_days: 14,
    });
    expect(shift.status).toBe(201);
    const moved = flowsOf(await get(o, `?scenario_id=${sc.id}`)).find((x: any) => x.ref === b.id);
    expect(moved.date).toBe(addDays(T, 16));
    const overrides = (await owner.json("GET", `${o.base}/forecast/overrides?scenario_id=${sc.id}`)).body
      .data;
    expect(overrides).toHaveLength(1);

    // Duplicate copies the items, overrides, and assumptions.
    const dup = (await owner.json("POST", `${o.base}/forecast/scenarios/${sc.id}/duplicate`, {})).body;
    expect(dup).toMatchObject({ name: "Copy of Quiet month", assumptions: { min_cash_buffer: 10_000 } });
    const dupItems = (await owner.json("GET", `${o.base}/forecast/items?scenario_id=${dup.id}`)).body.data;
    expect(dupItems.map((i: any) => i.name)).toEqual(["New laptop"]);
    expect(dupItems[0].id).not.toBe(
      (await owner.json("GET", `${o.base}/forecast/items?scenario_id=${sc.id}`)).body.data[0].id,
    );
    expect(
      (await owner.json("GET", `${o.base}/forecast/overrides?scenario_id=${dup.id}`)).body.data,
    ).toHaveLength(1);
    expect((await owner.json("POST", `${o.base}/forecast/scenarios/baseline/duplicate`, {})).status).toBe(
      422,
    );

    // Promote moves the chosen items, overrides, and assumption values into the baseline.
    const itemId = dupItems[0].id;
    const p = await owner.json("POST", `${o.base}/forecast/scenarios/${dup.id}/promote`, {
      item_ids: [itemId],
      override_ids: overrides.length
        ? [(await owner.json("GET", `${o.base}/forecast/overrides?scenario_id=${dup.id}`)).body.data[0].id]
        : [],
      assumptions: true,
    });
    expect(p.body).toMatchObject({ items: 1, overrides: 1, assumptions: ["min_cash_buffer"] });
    const after = await get(o);
    expect(flowsOf(after).map((x: any) => x.label)).toEqual([`New laptop`, `Bill B-1 (Landlord LLC)`]);
    expect(after.assumptions.min_cash_buffer).toBe(10_000);
    expect((await owner.json("GET", `${o.base}/forecast/items?scenario_id=${dup.id}`)).body.data).toEqual([]);
    expect(
      (await owner.json("GET", `${o.base}/forecast/scenarios`)).body.data.find((s: any) => s.id === dup.id)
        .assumptions,
    ).toEqual({});
    expect((await auditFor(o, "forecast.scenario.promote")).length).toBe(1);
    expect((await auditFor(o, "forecast.scenario.duplicate")).length).toBe(1);

    // Archiving hides a scenario from the list.
    expect((await owner.json("DELETE", `${o.base}/forecast/scenarios/${sc.id}`)).status).toBe(200);
    expect(
      (await owner.json("GET", `${o.base}/forecast/scenarios`)).body.data.map((s: any) => s.id),
    ).not.toContain(sc.id);
  });

  test("saved windows and custom windows", async () => {
    const o = await freshOrg("Forecast Windows Co");
    const m = await get(o, "?window=m12");
    expect(m.buckets).toHaveLength(12);
    expect(m.buckets[0].start).toBe(T);
    const w = await owner.json("POST", `${o.base}/forecast/windows`, {
      name: "Next 6 months",
      bucket: "month",
      periods: 6,
    });
    expect(w.status).toBe(201);
    expect((await get(o, `?window=${w.body.id}`)).buckets).toHaveLength(6);
    expect((await get(o, "?bucket=week&periods=4")).window).toMatchObject({ key: "custom", periods: 4 });
    expect((await owner.json("GET", `${o.base}/forecast?bucket=week&periods=500`)).status).toBe(400);
    expect((await owner.json("GET", `${o.base}/forecast?window=nope`)).status).toBe(404);
    expect((await owner.json("GET", `${o.base}/forecast/windows`)).body.data).toHaveLength(1);
    expect((await owner.json("DELETE", `${o.base}/forecast/windows/${w.body.id}`)).status).toBe(200);
    expect((await auditFor(o, "forecast.window.delete")).length).toBe(1);
  });
});

describe(`planned items, links, and suggestions (${DB_MODE})`, () => {
  test("a repeating item counts every occurrence in the window; linked and skipped stop counting, rejected doesn't", async () => {
    const o = await freshOrg("Forecast Links Co");
    const it = await item(o, {
      name: "Software",
      direction: "out",
      amount: 5_000,
      unit: "week",
      interval: 1,
      start_date: addDays(T, 1),
      max_occurrences: 3,
    });
    expect(it.schedule_text).toStartWith("Weekly");
    const dates = [1, 8, 15].map((n) => addDays(T, n));
    const count = async () =>
      flowsOf(await get(o, "?bucket=week&periods=8")).filter((x: any) => x.ref === it.id);
    expect((await count()).map((x: any) => x.date)).toEqual(dates);

    const bk = (await bill(o, 5_000, addDays(T, 1))).id;
    const l1 = await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
      occurrence_date: dates[0],
      status: "linked",
      target_type: "bill",
      target_id: bk,
    });
    expect(l1.status).toBe(201);
    expect((await count()).map((x: any) => x.date)).toEqual([dates[1], dates[2]]);
    // The same document can't be linked twice, and a settled occurrence can't be skipped.
    expect(
      (
        await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
          occurrence_date: dates[1],
          status: "linked",
          target_type: "bill",
          target_id: bk,
        })
      ).status,
    ).toBe(409);
    const skip = await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
      occurrence_date: dates[1],
      status: "skipped",
    });
    expect(skip.status).toBe(201);
    expect(skip.body.target_id).toBeNull();
    expect((await count()).map((x: any) => x.date)).toEqual([dates[2]]);
    const rej = await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
      occurrence_date: dates[2],
      status: "rejected",
      target_type: "bill",
      target_id: bk,
    });
    expect(rej.status).toBe(201);
    expect((await count()).map((x: any) => x.date)).toEqual([dates[2]]);
    // Only dates the item actually has.
    expect(
      (
        await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
          occurrence_date: addDays(T, 2),
          status: "skipped",
        })
      ).status,
    ).toBe(422);
    // Removing the skip brings the occurrence back.
    expect((await owner.json("DELETE", `${o.base}/forecast/links/${skip.body.id}`)).status).toBe(200);
    expect((await count()).map((x: any) => x.date)).toEqual([dates[1], dates[2]]);
  });

  test("a repeating item added today doesn't count its occurrences from before it was added", async () => {
    const o = await freshOrg("Forecast History Co");
    const it = await item(o, {
      name: "Weekly cleaning",
      direction: "out",
      amount: 8_000,
      unit: "week",
      interval: 1,
      start_date: addDays(T, -35),
    });
    const f = await get(o, "?bucket=week&periods=2");
    const mine = flowsOf(f).filter((x: any) => x.ref === it.id);
    // Only occurrences from today on; none of the five past weeks lands on today.
    expect(mine.every((x: any) => x.date >= T)).toBe(true);
    expect(mine.filter((x: any) => x.date === T).length).toBeLessThanOrEqual(1);
    expect(f.attention.some((a: any) => a.kind === "planned_past_due" && a.item_id === it.id)).toBe(false);
  });

  test("a suggested match on a bank transaction: never automatic, and 'not this' hides it", async () => {
    const o = await freshOrg("Forecast Suggest Co");
    const when = addDays(T, -3);
    const it = await item(o, { name: "Contractor", direction: "out", amount: 12_000, start_date: when });
    const imp = await owner.json("POST", `${o.base}/bank-accounts/${o.bank}/import`, {
      filename: "x.csv",
      content: `Date,Description,Amount\n${addDays(T, -2)},ACME CONTRACTOR,-123.45\n${addDays(T, -2)},LUNCH,-5.00\n`,
      profile: {
        hasHeader: true,
        skipRows: 0,
        dateFormat: "YYYY-MM-DD",
        amountMode: "signed",
        signConvention: "positive_is_deposit",
        columns: { date: 0, description: 1, amount: 2 },
      },
    });
    expect(imp.status).toBeLessThan(300);
    const f = await get(o);
    expect(f.suggestions).toHaveLength(1);
    expect(f.suggestions[0]).toMatchObject({
      item_id: it.id,
      occurrence_date: when,
      target_type: "bank_transaction",
      target_amount: 12_345,
    });
    const kinds = f.attention.map((a: any) => a.kind);
    expect(kinds).toContain("suggested_match");
    // The occurrence is past due, so it counts today and is flagged.
    expect(kinds).toContain("planned_past_due");
    expect(flowsOf(f).find((x: any) => x.ref === it.id)).toMatchObject({ date: T, amount: -12_000 });

    const s = f.suggestions[0];
    await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
      occurrence_date: when,
      status: "rejected",
      target_type: s.target_type,
      target_id: s.target_id,
    });
    const after = await get(o);
    expect(after.suggestions).toEqual([]);
    expect(flowsOf(after).find((x: any) => x.ref === it.id)).toBeDefined();
  });

  test("planned items not confirmed for 60 days are flagged until confirmed; a planned item that duplicates a template is flagged", async () => {
    const o = await freshOrg("Forecast Attention Co");
    const it = await item(o, {
      name: "Rent",
      direction: "out",
      amount: 50_000,
      contact_id: o.vendor,
      start_date: addDays(T, 20),
    });
    const h = await env.ctx.orgs.mustOpen(o.id);
    await h.write((tx) =>
      tx
        .update(org.forecastItems)
        .set({ createdAt: `${addDays(T, -70)}T12:00:00.000Z` })
        .where(eq(org.forecastItems.id, it.id)),
    );
    let f = await get(o);
    expect(f.attention.find((a: any) => a.kind === "planned_unconfirmed")).toMatchObject({ ref: it.id });
    expect(
      (await owner.json("POST", `${o.base}/forecast/items/${it.id}/confirm`, {})).body.last_confirmed_at,
    ).not.toBeNull();
    f = await get(o);
    expect(f.attention.some((a: any) => a.kind === "planned_unconfirmed")).toBe(false);
    expect((await auditFor(o, "forecast.item.confirm")).length).toBe(1);

    await owner.json("POST", `${o.base}/recurring-templates`, {
      kind: "bill",
      name: "Monthly rent",
      contact_id: o.vendor,
      run_mode: "draft",
      schedule: { unit: "month", interval: 1, start_date: addDays(T, 25) },
      template: { lines: [{ description: "Rent", amount: 52_000, account_id: o.acct["6090"] }] },
    });
    f = await get(o);
    expect(f.attention.find((a: any) => a.kind === "template_overlap")).toMatchObject({ ref: it.id });
  });

  test("validation: a draw is always out, amounts are positive, dates are real", async () => {
    const o = await freshOrg("Forecast Validation Co");
    const post = (b: Record<string, unknown>) => owner.json("POST", `${o.base}/forecast/items`, b);
    const ok = { name: "x", direction: "out", amount: 100, start_date: addDays(T, 1) };
    expect((await post({ ...ok, kind: "draw", direction: "in" })).status).toBe(422);
    expect((await post({ ...ok, amount: 0 })).status).toBe(400);
    expect((await post({ ...ok, start_date: "2026-02-30" })).status).toBe(422);
    expect((await post({ ...ok, anchor_day: 15 })).status).toBe(422);
    expect((await post({ ...ok, kind: "draw" })).status).toBe(201);
    const a = (await post(ok)).body;
    expect((await owner.json("PATCH", `${o.base}/forecast/items/${a.id}`, { amount: 250 })).body.amount).toBe(
      250,
    );
    expect((await owner.json("DELETE", `${o.base}/forecast/items/${a.id}`)).body.archived_at).not.toBeNull();
    expect(
      (await owner.json("GET", `${o.base}/forecast/items`)).body.data.map((i: any) => i.id),
    ).not.toContain(a.id);
  });
});

describe(`forecast over MCP and owner draws (${DB_MODE})`, () => {
  let o: Org;
  let tokenA: string;
  let tokenB: string;

  async function call(token: string, name: string, args: Record<string, unknown>) {
    const res = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).result as {
      isError: boolean;
      structuredContent?: any;
      content: any[];
    };
  }

  beforeAll(async () => {
    o = await freshOrg("Forecast MCP Co");
    for (const name of ["a", "b"]) {
      const t = await owner.json("POST", "/api/v1/tokens", {
        org_id: o.id,
        name: `assistant ${name}`,
        role: "bookkeeper",
        propose_only: true,
      });
      if (name === "a") tokenA = t.body.token;
      else tokenB = t.body.token;
    }
  });

  test("an assistant can't write the baseline, can write its own scenario, and can't write another client's", async () => {
    const baseline = await call(tokenA, "save_planned_item", {
      scenario_id: "baseline",
      name: "Sneaky",
      direction: "out",
      amount: 1000,
      date: addDays(T, 3),
    });
    expect(baseline.isError).toBe(true);
    expect(baseline.content[0]!.text).toContain("promote");
    const noScenario = await call(tokenA, "save_planned_item", {
      name: "x",
      direction: "out",
      amount: 1000,
      date: addDays(T, 3),
    });
    expect(noScenario.isError).toBe(true);

    const sc = await call(tokenA, "create_forecast_scenario", {
      name: "Assistant what-if",
      assumptions: { min_cash_buffer: 5_000 },
    });
    expect(sc.isError).toBe(false);
    const id = sc.structuredContent.scenario.id;
    expect(sc.structuredContent.scenario).toMatchObject({
      created_by_actor: "mcp",
      assumptions: { min_cash_buffer: 5_000 },
    });
    const saved = await call(tokenA, "save_planned_item", {
      scenario_id: id,
      name: "Tax payment",
      direction: "out",
      amount: 40_000,
      date: addDays(T, 6),
    });
    expect(saved.isError).toBe(false);
    expect(saved.structuredContent.item).toMatchObject({ source: "assistant", amount: 40_000 });
    const itemId = saved.structuredContent.item.id;

    const other = await call(tokenB, "save_planned_item", { id: itemId, amount: 1 });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toContain("created by someone else");
    expect((await call(tokenB, "archive_planned_item", { id: itemId })).isError).toBe(true);
    expect(
      (
        await call(tokenB, "save_planned_item", {
          scenario_id: id,
          name: "y",
          direction: "in",
          amount: 1,
          date: addDays(T, 2),
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(tokenB, "set_forecast_override", {
          scenario_id: id,
          target_type: "forecast_item",
          target_id: itemId,
          action: "exclude",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(tokenA, "set_forecast_override", {
          scenario_id: id,
          target_type: "forecast_item",
          target_id: itemId,
          action: "shift",
          shift_days: 7,
        })
      ).isError,
    ).toBe(false);

    // Anyone can read it.
    const read = await call(tokenB, "get_cash_forecast", { scenario_id: id });
    expect(read.isError).toBe(false);
    expect(read.structuredContent.draw_capacity.amount).toBe(200_000 - 40_000 - 5_000);
    expect(flowsOf(read.structuredContent)[0].date).toBe(addDays(T, 13));
    expect((await call(tokenB, "list_forecast_scenarios", {})).structuredContent.data.length).toBe(2);
    expect(
      (await call(tokenB, "list_planned_items", { scenario_id: id })).structuredContent.data,
    ).toHaveLength(1);

    // REST: the token's write to its own scenario works, and a person can edit any scenario.
    expect((await owner.json("PATCH", `${o.base}/forecast/items/${itemId}`, { amount: 41_000 })).status).toBe(
      200,
    );
    // A person promotes it; an assistant's promote over REST is refused.
    const atoken = tokenClient(env, tokenA);
    expect(
      (await atoken.json("POST", `${o.base}/forecast/scenarios/${id}/promote`, { assumptions: true })).status,
    ).toBe(403);
    expect(
      (
        await atoken.json("PATCH", `${o.base}/forecast/scenarios/baseline`, {
          assumptions: { min_cash_buffer: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await auditFor(o, "forecast.item.create")).at(-1)!.actor).toBe("mcp");
  });

  test("propose_owner_draw waits for review with the forecast snapshot, and shows as a pending outflow", async () => {
    const r = await call(tokenA, "propose_owner_draw", {
      date: addDays(T, 2),
      amount: 50_000,
      bank_account_id: o.bank,
      memo: "Monthly draw",
      rationale: "The owner asked for a draw",
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      draw: { status: "pending_review" },
      reserve_payments: [],
      exceeds_capacity: false,
    });
    const snap = r.structuredContent.forecast_snapshot;
    expect(snap).toMatchObject({
      opening_cash: 200_000,
      exceeds_capacity: false,
      scenario: { is_baseline: true },
    });
    expect(snap.draw_capacity.amount).toBe(200_000);

    const review = (await owner.json("GET", `${o.base}/review/${r.structuredContent.draw.review_item_id}`))
      .body;
    expect(review.payload.forecast_snapshot.draw_capacity.amount).toBe(200_000);
    const entryRow = (await owner.json("GET", `${o.base}/entries/${r.structuredContent.draw.entry_id}`)).body;
    expect(entryRow).toMatchObject({
      source_type: "owner_draw",
      status: "pending_review",
      date: addDays(T, 2),
    });
    const lines = entryRow.lines.map((l: any) => [l.account_id, l.amount]);
    const ownerDraw = (await owner.json("GET", `${o.base}/accounts`)).body.data.find(
      (a: any) => a.system_key === "owner_draw",
    ).id;
    expect(lines).toContainEqual([ownerDraw, 50_000]);
    expect(lines).toContainEqual([o.acct["1000"], -50_000]);

    const f = await get(o);
    const pending = flowsOf(f).find((x: any) => x.firmness === "pending");
    expect(pending).toMatchObject({ amount: -50_000, date: addDays(T, 2) });
    expect(pending.label).toContain("Owner draw");
    expect(f.draw_capacity.amount).toBe(150_000);
  });

  test("an owner draw over capacity is proposed, not refused, and says so", async () => {
    const o2 = await freshOrg("Forecast Draw Co");
    const r = await owner.json("POST", `${o2.base}/forecast/draws`, {
      date: T,
      amount: 240_000,
      bank_account_id: o2.bank,
    });
    expect(r.status).toBe(201);
    expect(r.body.exceeds_capacity).toBe(true);
    expect(r.body.forecast_snapshot.draw_capacity.amount).toBe(200_000);
    expect(r.body.draw.entry.source_type).toBe("owner_draw");
    expect(r.body.payments).toEqual([]);
    expect(
      (
        await viewer.json("POST", `${o2.base}/forecast/draws`, {
          date: T,
          amount: 1,
          bank_account_id: o2.bank,
        })
      ).status,
    ).toBe(403);
  });
});

describe(`owner draws that reimburse the owner (${DB_MODE})`, () => {
  test("reimburse_owner: one entry debits Due to Owner and Owner Draw and credits the bank; checked against the balance", async () => {
    const o = await freshOrg("Forecast Reimburse Co");
    const dueTo = o.acct["2400"]!;
    // Mileage the owner paid personally: the business owes 8,000.
    await entry(o, T, [
      [o.acct["6090"]!, 8_000],
      [dueTo, -8_000],
    ]);
    const post = (b: Record<string, unknown>) =>
      owner.json("POST", `${o.base}/forecast/draws`, { date: T, bank_account_id: o.bank, ...b });
    const r = await post({ amount: 10_000, reimburse_owner: { account_id: dueTo, amount: 5_000 } });
    expect(r.status).toBe(201);
    expect(r.body.payments).toEqual([]);
    const e = r.body.draw.entry;
    expect(e).toMatchObject({ source_type: "owner_draw", memo: "Owner reimbursement and draw" });
    const ownerDraw = (await owner.json("GET", `${o.base}/accounts`)).body.data.find(
      (a: any) => a.system_key === "owner_draw",
    ).id;
    expect(e.lines.map((l: any) => [l.account_id, l.amount])).toEqual([
      [dueTo, 5_000],
      [ownerDraw, 5_000],
      [o.acct["1000"], -10_000],
    ]);

    // Only the reimbursement: no Owner Draw line.
    const all = await post({ amount: 3_000, reimburse_owner: { account_id: dueTo, amount: 3_000 } });
    expect(all.status).toBe(201);
    expect(all.body.draw.entry.memo).toBe("Owner reimbursement");
    expect(all.body.draw.entry.lines.map((l: any) => l.account_id)).toEqual([dueTo, o.acct["1000"]]);

    // More than the account owes (8,000 less what posted above), more than the draw, or not a liability.
    const owed = -(await owner.json("GET", `${o.base}/accounts?include_balances=true`)).body.data.find(
      (a: any) => a.id === dueTo,
    ).balance;
    expect(owed).toBeGreaterThanOrEqual(0);
    const over = await post({ amount: 20_000, reimburse_owner: { account_id: dueTo, amount: owed + 1 } });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("invalid_amount");
    expect(over.body.error.message).toContain((owed / 100).toFixed(2));
    const big = await post({ amount: 1_000, reimburse_owner: { account_id: dueTo, amount: 2_000 } });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe("invalid_amount");
    const notLiability = await post({
      amount: 1_000,
      reimburse_owner: { account_id: o.acct["1000"], amount: 500 },
    });
    expect(notLiability.status).toBe(422);
    expect(notLiability.body.error.code).toBe("invalid_account");
  });

  test("a repayment waiting in review counts against what the account still owes", async () => {
    const o = await freshOrg("Forecast Reimburse Pending Co");
    const dueTo = o.acct["2400"]!;
    // Four posted expenses under the review threshold: the business owes 4,000.00.
    for (let i = 0; i < 4; i++)
      await entry(o, T, [
        [o.acct["6090"]!, 100_000],
        [dueTo, -100_000],
      ]);
    const post = (amount: number) =>
      owner.json("POST", `${o.base}/forecast/draws`, {
        date: T,
        bank_account_id: o.bank,
        amount,
        reimburse_owner: { account_id: dueTo, amount },
      });
    // Over the review threshold, so it waits in review.
    const first = await post(300_000);
    expect(first.status).toBe(201);
    expect(first.body.draw.status).toBe("pending_review");
    const second = await post(200_000);
    expect(second.status).toBe(422);
    expect(second.body.error.message).toContain("1000.00");
    expect((await post(100_000)).status).toBe(201);
  });
});

describe(`forecast in an export (${DB_MODE})`, () => {
  test("export and import keep scenarios, items, overrides, links, and windows", async () => {
    const o = await freshOrg("Forecast Export Co");
    const b = await bill(o, 9_000, addDays(T, 3));
    const sc = (await owner.json("POST", `${o.base}/forecast/scenarios`, { name: "What if" })).body;
    const it = await item(o, {
      scenario_id: sc.id,
      name: "Gear",
      direction: "out",
      amount: 7_000,
      start_date: addDays(T, 5),
    });
    await owner.json("POST", `${o.base}/forecast/overrides`, {
      scenario_id: sc.id,
      target_type: "bill",
      target_id: b.id,
      action: "exclude",
    });
    await owner.json("POST", `${o.base}/forecast/items/${it.id}/links`, {
      occurrence_date: addDays(T, 5),
      status: "skipped",
    });
    await owner.json("POST", `${o.base}/forecast/windows`, { name: "Quarter", bucket: "week", periods: 13 });
    const before = await get(o, `?scenario_id=${sc.id}`);

    const zip = join(tmp, "forecast.zip");
    const manifest = await exportOrg(env.ctx, o.id, zip);
    expect(manifest.tables.forecast_scenarios!.rows).toBe(2);
    expect(manifest.tables.forecast_items!.rows).toBe(1);
    expect(manifest.tables.forecast_overrides!.rows).toBe(1);
    expect(manifest.tables.forecast_links!.rows).toBe(1);
    expect(manifest.tables.forecast_windows!.rows).toBe(1);
    await env.ctx.orgs.destroy(o.id);
    const res = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), { userId: owner.userId });
    expect(res.chains_ok).toBe(true);
    const after = await get(o, `?scenario_id=${sc.id}`);
    expect(after.buckets.map((x: any) => [x.start, x.inflow, x.outflow])).toEqual(
      before.buckets.map((x: any) => [x.start, x.inflow, x.outflow]),
    );
    expect(
      (await owner.json("GET", `${o.base}/forecast/overrides?scenario_id=${sc.id}`)).body.data,
    ).toHaveLength(1);
    expect((await owner.json("GET", `${o.base}/forecast/windows`)).body.data).toHaveLength(1);
  });
});
