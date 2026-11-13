/**
 * Recurring templates (#24): invoices, bills, and journal entries created on a schedule by the
 * daily job, with catch-up, review rules, lock dates, the email outbox, and proposals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderPeriodText } from "@cosimo/core";
import { org as dbOrg } from "@cosimo/db";
import { addDays, addMonths, today } from "@cosimo/shared";
import { eq } from "drizzle-orm";
import { runRecurringTemplates } from "../src/jobs/document-jobs.ts";
import type { Mailer, SentMail } from "../src/services/mailer.ts";
import {
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
let mail: SentMail[];

interface Org {
  id: string;
  base: string;
  acct: Record<string, string>;
  customer: string;
  vendor: string;
}

/** Each test gets its own org, so the daily job only sees that test's templates. */
async function freshOrg(name: string): Promise<Org> {
  const id = await createOrg(env, owner, name, { basis: "accrual" });
  const base = `/api/v1/orgs/${id}`;
  const accts = await owner.json("GET", `${base}/accounts`);
  const acct = Object.fromEntries(accts.body.data.map((a: any) => [a.code, a.id]));
  const customer = (
    await owner.json("POST", `${base}/contacts`, {
      kind: "customer",
      name: "Globex",
      email: "ap@globex.test",
    })
  ).body.id;
  const vendor = (await owner.json("POST", `${base}/contacts`, { kind: "vendor", name: "Landlord LLC" })).body
    .id;
  return { id, base, acct, customer, vendor };
}

async function create(o: Org, body: Record<string, unknown>, client = owner) {
  const r = await client.json("POST", `${o.base}/recurring-templates`, body);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

const invoiceTemplate = (o: Org, unitPrice: number, extra: Record<string, unknown> = {}) => ({
  kind: "invoice",
  name: "Monthly retainer",
  contact_id: o.customer,
  run_mode: "post_and_send",
  schedule: { unit: "month", interval: 1, start_date: "2026-05-01", end_date: "2026-06-30" },
  template: {
    memo: "Retainer for {month} {year}",
    lines: [
      {
        description: "Retainer {period}",
        quantity_milli: 1000,
        unit_price: unitPrice,
        account_id: o.acct["4000"],
      },
    ],
  },
  ...extra,
});

const entryTemplate = (o: Org, extra: Record<string, unknown> = {}) => ({
  kind: "entry",
  name: "Prepaid insurance",
  run_mode: "post",
  schedule: { unit: "month", interval: 1, start_date: "2026-01-31", max_occurrences: 4 },
  template: {
    memo: "Insurance amortization, {month} {year}",
    lines: [
      { account_id: o.acct["6060"], amount: 10_000, description: "{quarter} expense" },
      { account_id: o.acct["1300"], amount: -10_000 },
    ],
  },
  ...extra,
});

const detail = async (o: Org, id: string) =>
  (await owner.json("GET", `${o.base}/recurring-templates/${id}`)).body;
const pendingReviews = async (o: Org) =>
  (await owner.json("GET", `${o.base}/review?status=pending&limit=200`)).body.data as any[];

beforeAll(async () => {
  env = await createTestEnv();
  mail = (env.ctx.services.mailer as Mailer).useTestTransport();
  owner = await login(env, "recurring-owner@example.com");
});
afterAll(() => env.close());

describe(`recurring templates (${DB_MODE})`, () => {
  test("a post_and_send invoice catches up, emails each invoice, ends at its end date, and doesn't rerun", async () => {
    const o = await freshOrg("Catch-up Co");
    const t = await create(o, invoiceTemplate(o, 50_000));
    expect(t).toMatchObject({
      status: "active",
      next_date: "2026-05-01",
      schedule_summary: "Monthly on the 1st, until 2026-06-30",
    });
    const before = mail.length;
    const out = await runRecurringTemplates(env.ctx, o.id, "2026-07-15");
    expect(out).toEqual({ created: 2, failed: 0, emailed: 2 });
    expect(mail.length).toBe(before + 2);
    const d = await detail(o, t.id);
    expect(d.template).toMatchObject({
      status: "ended",
      next_date: null,
      generated_count: 2,
      last_run_date: "2026-06-01",
    });
    expect(d.runs.map((r: any) => [r.scheduled_date, r.send_status])).toEqual([
      ["2026-06-01", "sent"],
      ["2026-05-01", "sent"],
    ]);
    const inv = (await owner.json("GET", `${o.base}/invoices/${d.runs[1].doc_id}`)).body;
    expect(inv).toMatchObject({
      issue_date: "2026-05-01",
      memo: "Retainer for May 2026",
      recurring_id: t.id,
    });
    expect(inv.sent_at).toBeTruthy();
    expect(inv.lines[0].description).toBe("Retainer May 2026");
    expect(await runRecurringTemplates(env.ctx, o.id, "2026-08-15")).toEqual({
      created: 0,
      failed: 0,
      emailed: 0,
    });
  });

  test("a monthly entry on the 31st lands on each month's last day, with placeholders filled", async () => {
    const o = await freshOrg("Month-end Co");
    const t = await create(o, entryTemplate(o));
    expect(t.schedule_summary).toBe("Monthly on the 31st, 4 times");
    const occ = await owner.json("GET", `${o.base}/recurring-templates/${t.id}/occurrences?count=6`);
    expect(occ.body.data.map((x: any) => x.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    const out = await runRecurringTemplates(env.ctx, o.id, "2026-12-31");
    expect(out.created).toBe(4);
    const d = await detail(o, t.id);
    expect(d.template.status).toBe("ended");
    expect(d.runs.map((r: any) => r.scheduled_date).sort()).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    const feb = d.runs.find((r: any) => r.scheduled_date === "2026-02-28");
    const entry = (await owner.json("GET", `${o.base}/entries/${feb.doc_id}`)).body;
    expect(entry.status).toBe("posted");
    expect(entry.memo).toBe("Insurance amortization, February 2026");
    expect(entry.lines.find((l: any) => l.amount > 0).description).toBe("Q1 expense");
  });

  test("bills post below the review threshold and wait for review at or above it", async () => {
    const o = await freshOrg("Bills Co");
    const bill = (name: string, amount: number) =>
      create(o, {
        kind: "bill",
        name,
        contact_id: o.vendor,
        run_mode: "post",
        schedule: { unit: "month", interval: 1, start_date: "2026-03-01", max_occurrences: 1 },
        template: {
          bill_number: "RENT-{year}-{month}",
          lines: [{ description: "Rent", amount, account_id: o.acct["6130"] }],
        },
      });
    const small = await bill("Small rent", 100_000);
    const big = await bill("Big rent", 250_000);
    expect((await runRecurringTemplates(env.ctx, o.id, "2026-03-15")).created).toBe(2);
    const docOf = async (id: string) => {
      const run = (await detail(o, id)).runs[0];
      return (await owner.json("GET", `${o.base}/bills/${run.doc_id}`)).body;
    };
    const s = await docOf(small.id);
    expect(s.status).toBe("open");
    expect(s.bill_number).toBe("RENT-2026-March");
    expect(s.recurring_id).toBe(small.id);
    const b = await docOf(big.id);
    expect(b.status).toBe("draft");
    expect(b.entry_status).toBe("pending_review");
    const held = (await pendingReviews(o)).find((r) => r.amount === 250_000);
    expect(held?.payload.bill).toMatchObject({ vendor_name: expect.any(String), total: 250_000 });
    expect(held?.payload.bill.lines).toHaveLength(1);
  });

  test("a posted entry follows review policies for the system actor", async () => {
    const o = await freshOrg("Policy Co");
    const pol = await owner.json("POST", `${o.base}/review-policies`, {
      name: "Review system entries",
      actor: "system",
      condition: { item_types: ["journal_entry"] },
      action: "require_review",
    });
    expect(pol.status).toBe(201);
    const t = await create(
      o,
      entryTemplate(o, {
        schedule: { unit: "month", interval: 1, start_date: "2026-01-31", max_occurrences: 1 },
      }),
    );
    expect((await runRecurringTemplates(env.ctx, o.id, "2026-02-01")).created).toBe(1);
    const run = (await detail(o, t.id)).runs[0];
    const entry = (await owner.json("GET", `${o.base}/entries/${run.doc_id}`)).body;
    expect(entry.status).toBe("pending_review");
    expect(entry.source_type).toBe("manual");
  });

  test("a hard lock records an error without advancing; other templates still run; skip recovers", async () => {
    const o = await freshOrg("Lock Co");
    const locked = await create(
      o,
      entryTemplate(o, {
        name: "Locked",
        schedule: { unit: "month", interval: 1, start_date: "2026-01-15" },
      }),
    );
    const open = await create(
      o,
      entryTemplate(o, { name: "Open", schedule: { unit: "month", interval: 1, start_date: "2026-02-10" } }),
    );
    expect((await owner.json("PUT", `${o.base}/lock-dates`, { hard_lock_date: "2026-01-31" })).status).toBe(
      200,
    );
    const out = await runRecurringTemplates(env.ctx, o.id, "2026-02-20");
    expect(out).toMatchObject({ created: 1, failed: 1 });
    const l = (await detail(o, locked.id)).template;
    expect(l.next_date).toBe("2026-01-15");
    expect(l.last_error).toContain("hard lock");
    expect((await detail(o, open.id)).template.next_date).toBe("2026-03-10");

    const skip = await owner.json("POST", `${o.base}/recurring-templates/${locked.id}/skip`, {});
    expect(skip.body.next_date).toBe("2026-02-15");
    expect((await runRecurringTemplates(env.ctx, o.id, "2026-02-20")).created).toBe(1);
    const healed = await detail(o, locked.id);
    expect(healed.template.last_error).toBeNull();
    expect(healed.runs.map((r: any) => [r.scheduled_date, r.status])).toEqual([
      ["2026-02-15", "created"],
      ["2026-01-15", "skipped"],
    ]);
  });

  test("an archived contact stops the run with an error", async () => {
    const o = await freshOrg("Archived Co");
    const t = await create(o, invoiceTemplate(o, 1_000, { run_mode: "draft" }));
    await owner.json("PATCH", `${o.base}/contacts/${o.customer}`, { archived: true });
    const out = await runRecurringTemplates(env.ctx, o.id, "2026-05-15");
    expect(out).toMatchObject({ created: 0, failed: 1 });
    const d = await detail(o, t.id);
    expect(d.template.last_error).toContain("archived");
    expect(d.template.next_date).toBe("2026-05-01");
  });

  test("pause, resume, run early, and max_occurrences", async () => {
    const o = await freshOrg("Controls Co");
    const t = await create(
      o,
      entryTemplate(o, {
        run_mode: "draft",
        schedule: { unit: "month", interval: 1, start_date: "2030-01-31", max_occurrences: 2 },
      }),
    );
    const run = (body: Record<string, unknown> = {}) =>
      owner.json("POST", `${o.base}/recurring-templates/${t.id}/run`, body);
    // Not due yet, so a plain run creates nothing; early creates the next one, dated today.
    expect((await run()).body.created).toBe(0);
    const e1 = await run({ early: true });
    expect(e1.body).toMatchObject({ created: 1, error: null });
    expect(e1.body.template.next_date).toBe("2030-02-28");
    const first = (await detail(o, t.id)).runs[0];
    const draft = (await owner.json("GET", `${o.base}/entries/${first.doc_id}`)).body;
    expect(draft).toMatchObject({ status: "draft", date: today() });
    expect(first.scheduled_date).toBe("2030-01-31");

    const paused = await owner.json("POST", `${o.base}/recurring-templates/${t.id}/pause`, {});
    expect(paused.body.status).toBe("paused");
    expect((await run({ early: true })).status).toBe(409);
    const resumed = await owner.json("POST", `${o.base}/recurring-templates/${t.id}/resume`, {});
    expect(resumed.body).toMatchObject({ status: "active", next_date: "2030-02-28" });

    const e2 = await run({ early: true });
    expect(e2.body.created).toBe(1);
    expect(e2.body.template).toMatchObject({ status: "ended", next_date: null, generated_count: 2 });

    const del = await owner.json("DELETE", `${o.base}/recurring-templates/${t.id}`);
    expect(del.body.status).toBe("archived");
    const list = await owner.json("GET", `${o.base}/recurring-templates`);
    expect(list.body.data.some((x: any) => x.id === t.id)).toBe(false);
  });

  test("an invoice waiting for review is emailed once approved; without email set up it stays pending", async () => {
    const o = await freshOrg("Outbox Co");
    const t = await create(
      o,
      invoiceTemplate(o, 300_000, {
        schedule: { unit: "month", interval: 1, start_date: "2026-05-01", max_occurrences: 1 },
      }),
    );
    const before = mail.length;
    expect(await runRecurringTemplates(env.ctx, o.id, "2026-05-02")).toEqual({
      created: 1,
      failed: 0,
      emailed: 0,
    });
    expect(mail.length).toBe(before);
    const run = (await detail(o, t.id)).runs[0];
    expect(run.send_status).toBe("pending");
    const item = (await pendingReviews(o)).find((r) => r.amount === 300_000);
    expect((await owner.json("POST", `${o.base}/review/${item.id}/approve`, {})).status).toBe(200);

    // Email isn't set up: the send waits and the template says why.
    const services = env.ctx.services as unknown as { mailer: unknown };
    const real = services.mailer;
    services.mailer = { isConfigured: async () => false };
    try {
      expect((await runRecurringTemplates(env.ctx, o.id, "2026-05-03")).emailed).toBe(0);
    } finally {
      services.mailer = real;
    }
    let d = await detail(o, t.id);
    expect(d.runs[0].send_status).toBe("pending");
    expect(d.template.last_error).toContain("email is not set up");

    expect((await runRecurringTemplates(env.ctx, o.id, "2026-05-04")).emailed).toBe(1);
    expect(mail.length).toBe(before + 1);
    d = await detail(o, t.id);
    expect(d.runs[0].send_status).toBe("sent");
    expect(d.template.last_error).toBeNull();
    const inv = (await owner.json("GET", `${o.base}/invoices/${d.runs[0].doc_id}`)).body;
    expect(inv.sent_at).toBeTruthy();
  });

  test("a propose-only token proposes templates; approve activates, reject discards", async () => {
    const o = await freshOrg("Proposals Co");
    const tok = await owner.json("POST", "/api/v1/tokens", {
      org_id: o.id,
      name: "bot",
      role: "bookkeeper",
      propose_only: true,
    });
    const bot = tokenClient(env, tok.body.token);
    const a = await create(o, { ...entryTemplate(o), rationale: "Amortize the annual policy" }, bot);
    expect(a.status).toBe("proposed");
    expect(a.pending_review.action).toBe("create");
    // Nothing runs while it waits.
    expect((await runRecurringTemplates(env.ctx, o.id, "2026-12-31")).created).toBe(0);
    expect((await bot.json("DELETE", `${o.base}/recurring-templates/${a.id}`)).status).toBe(403);
    const ok = await owner.json("POST", `${o.base}/review/${a.pending_review.review_item_id}/approve`, {});
    expect(ok.status).toBe(200);
    expect((await detail(o, a.id)).template).toMatchObject({ status: "active", next_date: "2026-01-31" });

    // A change from the token also waits; the owner's pause applies directly.
    const change = await bot.json("PUT", `${o.base}/recurring-templates/${a.id}`, {
      ...entryTemplate(o, { name: "Renamed" }),
      rationale: "Better name",
    });
    expect(change.status).toBe(200);
    expect(change.body.name).toBe("Prepaid insurance");
    expect(change.body.pending_review.action).toBe("update");

    const b = await create(o, { ...entryTemplate(o, { name: "Rejected" }), rationale: "Try" }, bot);
    await owner.json("POST", `${o.base}/review/${b.pending_review.review_item_id}/reject`, {});
    expect((await owner.json("GET", `${o.base}/recurring-templates/${b.id}`)).status).toBe(404);
  });

  test("concurrent runs create each occurrence once", async () => {
    const o = await freshOrg("Race Co");
    const t = await create(o, entryTemplate(o, { run_mode: "draft" }));
    const outs = await Promise.all([
      runRecurringTemplates(env.ctx, o.id, "2026-12-31"),
      runRecurringTemplates(env.ctx, o.id, "2026-12-31"),
      runRecurringTemplates(env.ctx, o.id, "2026-12-31"),
    ]);
    expect(outs.reduce((s, x) => s + x.created, 0)).toBe(4);
    expect(outs.every((x) => x.failed === 0)).toBe(true);
    const d = await detail(o, t.id);
    expect(d.runs.length).toBe(4);
    expect(new Set(d.runs.map((r: any) => r.doc_id)).size).toBe(4);
  });

  test("invoice terms and due days must agree; due days alone derive the terms", async () => {
    const o = await freshOrg("Terms Co");
    const withBody = (template: Record<string, unknown>) => {
      const t = invoiceTemplate(o, 10_000, { run_mode: "draft" });
      return { ...t, template: { ...t.template, ...template } };
    };
    const post = (template: Record<string, unknown>) =>
      owner.json("POST", `${o.base}/recurring-templates`, withBody(template));
    const clash = await post({ terms: "Net 30", due_days: 10 });
    expect(clash.status).toBe(422);
    expect(clash.body.error.code).toBe("terms_conflict");
    expect((await post({ terms: "Due end of month", due_days: 10 })).body.error.code).toBe("terms_conflict");
    expect((await post({ terms: "On due date" })).body.error.code).toBe("due_date_required");
    expect((await post({ terms: "Net 15", due_days: 15 })).status).toBe(201);
    expect((await post({ terms: "On due date", due_days: 12 })).status).toBe(201);
    expect((await post({ terms: "2/10 Net 30", due_days: 30 })).status).toBe(201);

    const o2 = await freshOrg("Due Days Co");
    const t = await create(o2, {
      ...invoiceTemplate(o2, 10_000, { run_mode: "draft" }),
      schedule: { unit: "month", interval: 1, start_date: "2026-05-01", max_occurrences: 1 },
      template: { lines: invoiceTemplate(o2, 10_000).template.lines, due_days: 5 },
    });
    await runRecurringTemplates(env.ctx, o2.id, "2026-05-01");
    const d = await detail(o2, t.id);
    const inv = (await owner.json("GET", `${o2.base}/invoices/${d.runs[0].doc_id}`)).body;
    expect(inv).toMatchObject({ terms: "On due date", due_date: "2026-05-06" });
  });

  test("a template saved before terms were checked still runs; its due days win", async () => {
    const o = await freshOrg("Legacy Terms Co");
    const t = await create(o, {
      ...invoiceTemplate(o, 10_000, { run_mode: "draft" }),
      schedule: { unit: "month", interval: 1, start_date: "2026-05-01", max_occurrences: 1 },
      template: { lines: invoiceTemplate(o, 10_000).template.lines, due_days: 10 },
    });
    // Write the disagreeing terms straight to the row, as an older version could have saved them.
    const h = await env.ctx.orgs.open(o.id);
    if (!h) throw new Error("no org");
    const row = await h.db
      .select({ json: dbOrg.recurringTemplates.templateJson })
      .from(dbOrg.recurringTemplates)
      .where(eq(dbOrg.recurringTemplates.id, t.id))
      .get();
    const body = { ...JSON.parse(row!.json), terms: "Net 30" };
    await h.write((tx) =>
      tx
        .update(dbOrg.recurringTemplates)
        .set({ templateJson: JSON.stringify(body) })
        .where(eq(dbOrg.recurringTemplates.id, t.id)),
    );
    await runRecurringTemplates(env.ctx, o.id, "2026-05-01");
    const d = await detail(o, t.id);
    const inv = (await owner.json("GET", `${o.base}/invoices/${d.runs[0].doc_id}`)).body;
    expect(inv).toMatchObject({ terms: "Net 10", due_date: "2026-05-11" });
  });

  test("an early run is dated today and keeps the scheduled date on the run", async () => {
    const o = await freshOrg("Early Bill Co");
    const start = addDays(today(), 30);
    const t = await create(o, {
      kind: "bill",
      name: "Rent",
      contact_id: o.vendor,
      run_mode: "post",
      schedule: { unit: "month", interval: 1, start_date: start },
      template: {
        bill_number: "RENT-{year}-{month}",
        lines: [{ description: "Rent", amount: 1000, account_id: o.acct["6130"] }],
      },
    });
    const run = (body: Record<string, unknown> = {}) =>
      owner.json("POST", `${o.base}/recurring-templates/${t.id}/run`, body);
    const e1 = await run({ early: true });
    expect(e1.body).toMatchObject({ created: 1, error: null });
    expect(e1.body.template.next_date).toBe(addMonths(start, 1));
    const first = (await detail(o, t.id)).runs[0];
    expect(first.scheduled_date).toBe(start);
    const bill = (await owner.json("GET", `${o.base}/bills/${first.doc_id}`)).body;
    expect(bill).toMatchObject({
      status: "open",
      issue_date: today(),
      due_date: addDays(today(), 30),
      bill_number: renderPeriodText("RENT-{year}-{month}", start),
    });
    // A plain run creates nothing, and a second early run creates the following occurrence.
    expect((await run()).body.created).toBe(0);
    expect((await run({ early: true })).body.created).toBe(1);
    const runs = (await detail(o, t.id)).runs;
    expect(runs.map((r: any) => r.scheduled_date).sort()).toEqual([start, addMonths(start, 1)]);
  });

  test("an early invoice run is issued today and due due_days later", async () => {
    const o = await freshOrg("Early Invoice Co");
    const t = await create(
      o,
      invoiceTemplate(o, 50_000, {
        run_mode: "post",
        schedule: { unit: "month", interval: 1, start_date: addDays(today(), 20) },
        template: {
          due_days: 14,
          lines: [
            { description: "Retainer", quantity_milli: 1000, unit_price: 50_000, account_id: o.acct["4000"] },
          ],
        },
      }),
    );
    const r = await owner.json("POST", `${o.base}/recurring-templates/${t.id}/run`, { early: true });
    expect(r.body.created).toBe(1);
    const run = (await detail(o, t.id)).runs[0];
    const inv = (await owner.json("GET", `${o.base}/invoices/${run.doc_id}`)).body;
    expect(inv).toMatchObject({ issue_date: today(), due_date: addDays(today(), 14) });
  });

  test("an early run of an occurrence already due keeps the scheduled date", async () => {
    const o = await freshOrg("Early Due Co");
    const start = addDays(today(), -10);
    const t = await create(
      o,
      entryTemplate(o, { schedule: { unit: "month", interval: 1, start_date: start, max_occurrences: 2 } }),
    );
    const r = await owner.json("POST", `${o.base}/recurring-templates/${t.id}/run`, { early: true });
    expect(r.body.created).toBe(1);
    const run = (await detail(o, t.id)).runs[0];
    const entry = (await owner.json("GET", `${o.base}/entries/${run.doc_id}`)).body;
    expect(entry.date).toBe(start);
  });
});
