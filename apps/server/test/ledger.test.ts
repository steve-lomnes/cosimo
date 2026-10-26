import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { registeredJobs, type Scheduler } from "../src/jobs/scheduler.ts";
import { verifyOrg } from "../src/services/chain.ts";
import type { Mailer } from "../src/services/mailer.ts";
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
let orgId: string;
let acct: Record<string, string>;
const base = () => `/api/v1/orgs/${orgId}`;

async function accountsByCode(c: Client, id: string) {
  const r = await c.json("GET", `/api/v1/orgs/${id}/accounts`);
  return Object.fromEntries((r.body.data as { code: string; id: string }[]).map((a) => [a.code, a.id]));
}

async function post(c: Client, body: Record<string, unknown>, id = orgId) {
  return c.json("POST", `/api/v1/orgs/${id}/entries`, body);
}

const simple = (date: string, amount: number, debit = "1000", credit = "4000") => ({
  date,
  memo: `test ${amount}`,
  lines: [
    { account_id: acct[debit], amount },
    { account_id: acct[credit], amount: -amount },
  ],
});

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "owner@example.com");
  orgId = await createOrg(env, owner, "Ledger Co");
  acct = await accountsByCode(owner, orgId);
});
afterAll(async () => {
  await env.close();
});

describe(`ledger (${DB_MODE})`, () => {
  test("org creation seeds the chart of accounts with system accounts", async () => {
    const r = await owner.json("GET", `${base()}/accounts`);
    const keys = r.body.data
      .filter((a: any) => a.is_system)
      .map((a: any) => a.system_key)
      .sort();
    expect(keys).toEqual(
      [
        "ap",
        "ar",
        "opening_balance_equity",
        "owner_draw",
        "retained_earnings",
        "uncategorized_expense",
        "uncategorized_income",
      ].sort(),
    );
    expect(r.body.data.some((a: any) => a.tax_line?.startsWith("schc."))).toBe(true);
  });

  test("posts a balanced entry and extends the chain", async () => {
    const r = await post(owner, simple("2026-01-10", 12345));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("posted");
    expect(r.body.entry.chain_seq).toBe(1);
    expect(r.body.entry.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    const r2 = await post(owner, simple("2026-01-11", 500));
    expect(r2.body.entry.chain_seq).toBe(2);
    const v = await owner.json("POST", `${base()}/verify`);
    expect(v.body.ok).toBe(true);
    expect(v.body.ledger.head_seq).toBe(2);
  });

  test("rejects unbalanced, single-line, and zero entries through the API", async () => {
    const bad = await post(owner, {
      date: "2026-01-12",
      lines: [
        { account_id: acct["1000"], amount: 100 },
        { account_id: acct["4000"], amount: -99 },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("unbalanced");
    const one = await post(owner, { date: "2026-01-12", lines: [{ account_id: acct["1000"], amount: 100 }] });
    expect(one.status).toBe(422);
    const zero = await post(owner, {
      date: "2026-01-12",
      lines: [
        { account_id: acct["1000"], amount: 0 },
        { account_id: acct["4000"], amount: 0 },
      ],
    });
    expect(zero.status).toBe(400);
    const frac = await post(owner, {
      date: "2026-01-12",
      lines: [
        { account_id: acct["1000"], amount: 1.5 },
        { account_id: acct["4000"], amount: -1.5 },
      ],
    });
    expect(frac.status).toBe(400);
  });

  test("drafts can be edited, submitted, and deleted; posted entries cannot be edited", async () => {
    const d = await post(owner, { ...simple("2026-01-15", 700), draft: true });
    expect(d.body.status).toBe("draft");
    const id = d.body.entry.id;
    const u = await owner.json("PATCH", `${base()}/entries/${id}`, { memo: "edited" });
    expect(u.body.memo).toBe("edited");
    const s = await owner.json("POST", `${base()}/entries/${id}/submit`, {});
    expect(s.body.status).toBe("posted");
    const e = await owner.json("PATCH", `${base()}/entries/${id}`, { memo: "again" });
    expect(e.status).toBe(409);
    const del = await owner.json("DELETE", `${base()}/entries/${id}`);
    expect(del.status).toBe(409);

    const d2 = await post(owner, { ...simple("2026-01-15", 1), draft: true });
    expect((await owner.json("DELETE", `${base()}/entries/${d2.body.entry.id}`)).status).toBe(200);
    expect((await owner.json("GET", `${base()}/entries/${d2.body.entry.id}`)).status).toBe(404);
  });

  test("reversal negates every line and can happen once; replace reverses and reposts", async () => {
    const r = await post(owner, simple("2026-02-01", 4200, "1000", "4000"));
    const id = r.body.entry.id;
    const rev = await owner.json("POST", `${base()}/entries/${id}/reverse`, {});
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("posted");
    expect(rev.body.entry.reverses_entry_id).toBe(id);
    expect(rev.body.entry.lines.map((l: any) => l.amount).sort()).toEqual([-4200, 4200].sort());
    const orig = await owner.json("GET", `${base()}/entries/${id}`);
    expect(orig.body.reversed_by_entry_id).toBe(rev.body.entry.id);
    const again = await owner.json("POST", `${base()}/entries/${id}/reverse`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_reversed");

    const r2 = await post(owner, simple("2026-02-02", 1000));
    // A file attached to the original is linked to the replacement too, and stays on the original.
    const fd = new FormData();
    fd.set("file", new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], "invoice.pdf"));
    fd.set("target_type", "journal_entry");
    fd.set("target_id", r2.body.entry.id);
    const att = await owner.json("POST", `${base()}/attachments`, fd);
    expect(att.status).toBe(201);
    const rep = await owner.json(
      "POST",
      `${base()}/entries/${r2.body.entry.id}/replace`,
      simple("2026-02-02", 1100),
    );
    expect(rep.status).toBe(200);
    expect(rep.body.reversal.status).toBe("posted");
    expect(rep.body.replacement.entry.total).toBe(1100);
    const files = async (id: string) =>
      (
        await owner.json("GET", `${base()}/attachments?target_type=journal_entry&target_id=${id}`)
      ).body.data.map((a: any) => a.id);
    expect(await files(rep.body.replacement.entry.id)).toEqual([att.body.id]);
    expect(await files(r2.body.entry.id)).toEqual([att.body.id]);
    expect(await files(rep.body.reversal.entry.id)).toEqual([]);
    expect((await owner.json("POST", `${base()}/verify`)).body.ok).toBe(true);
  });

  test("entries at or above the review threshold wait for review from any actor and do not affect reports", async () => {
    const before = await owner.json("GET", `${base()}/reports/trial_balance?as_of=2026-12-31`);
    const big = await post(owner, simple("2026-03-01", 250000));
    expect(big.status).toBe(201);
    expect(big.body.status).toBe("pending_review");
    expect(big.body.review.review_item_id).toBeTruthy();
    expect(big.body.entry.chain_seq).toBeNull();
    const after = await owner.json("GET", `${base()}/reports/trial_balance?as_of=2026-12-31`);
    expect(after.body.lines).toEqual(before.body.lines);
  });

  test("propose-only API tokens send entries to review; read-only roles cannot write", async () => {
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "bot",
      role: "bookkeeper",
      propose_only: true,
    });
    expect(t.status).toBe(201);
    const bot = tokenClient(env, t.body.token);
    const r = await post(bot, simple("2026-03-02", 100));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_review");
    expect(r.body.entry.created_by_actor).toBe("api_token");

    const viewer = await login(env, "viewer@example.com");
    await addMember(env, orgId, viewer.userId, "viewer");
    expect((await post(viewer, simple("2026-03-02", 100))).status).toBe(403);
    expect((await viewer.json("GET", `${base()}/reports/profit_and_loss`)).status).toBe(200);
  });

  test("lock dates: soft lock blocks bookkeepers, owners need a note; hard lock blocks everyone", async () => {
    const bk = await login(env, "bk@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    const setBk = await bk.json("PUT", `${base()}/lock-dates`, { soft_lock_date: "2026-01-31" });
    expect(setBk.status).toBe(403);

    const set = await owner.json("PUT", `${base()}/lock-dates`, {
      soft_lock_date: "2026-01-31",
      hard_lock_date: "2025-12-31",
    });
    expect(set.status).toBe(200);
    const cps = await owner.json("GET", `${base()}/checkpoints`);
    expect(cps.body.data.some((c: any) => c.reason === "lock_date" && c.chain === "ledger")).toBe(true);

    const b = await post(bk, simple("2026-01-20", 100));
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe("soft_locked");
    const o1 = await post(owner, simple("2026-01-20", 100));
    expect(o1.status).toBe(422);
    const o2 = await post(owner, { ...simple("2026-01-20", 100), lock_override_note: "late receipt" });
    expect(o2.status).toBe(201);
    expect(o2.body.entry.lock_override_note).toBe("late receipt");
    const h = await post(owner, { ...simple("2025-12-15", 100), lock_override_note: "please" });
    expect(h.status).toBe(422);
    expect(h.body.error.code).toBe("hard_locked");
    const bad = await owner.json("PUT", `${base()}/lock-dates`, { hard_lock_date: "2026-02-15" });
    expect(bad.status).toBe(422);
    await owner.json("PUT", `${base()}/lock-dates`, { soft_lock_date: null, hard_lock_date: null });
    const audit = await owner.json("GET", `${base()}/audit?limit=200`);
    expect(
      audit.body.data.filter((a: any) => a.action === "lock_dates.update").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("opening balances post one entry against Opening Balance Equity", async () => {
    const id = await createOrg(env, owner, "Opening Co");
    const a = await accountsByCode(owner, id);
    const r = await owner.json("POST", `/api/v1/orgs/${id}/opening-balances`, {
      date: "2025-12-31",
      balances: [
        { account_id: a["1000"], amount: 150000 },
        { account_id: a["2100"] ?? a["2000"], amount: -50000 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.entry.source_type).toBe("opening_balance");
    expect(r.body.entry.lines).toHaveLength(3);
    const bs = await owner.json("GET", `/api/v1/orgs/${id}/reports/balance_sheet?as_of=2026-01-31`);
    expect(bs.body.checks.assets_minus_liabilities_equity_0).toBe(0);
    const obe = bs.body.lines.find((l: any) => l.label === "Opening Balance Equity");
    expect(obe.values[0]).toBe(100000);
    const inc = await owner.json("POST", `/api/v1/orgs/${id}/opening-balances`, {
      date: "2025-12-31",
      balances: [{ account_id: a["4000"], amount: -100 }],
    });
    expect(inc.status).toBe(422);
  });

  test("reports tie out and carry the chain head; CSV export works", async () => {
    for (const key of [
      "trial_balance",
      "profit_and_loss",
      "balance_sheet",
      "cash_flow",
      "tax_line_summary",
      "general_ledger",
    ]) {
      const r = await owner.json(
        "GET",
        `${base()}/reports/${key}?from=2026-01-01&to=2026-12-31&as_of=2026-12-31`,
      );
      expect(r.status).toBe(200);
      for (const v of Object.values(r.body.checks)) expect(v).toBe(0);
      expect(r.body.meta.chain_head.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const pl = await owner.json(
      "GET",
      `${base()}/reports/profit_and_loss?from=2026-01-01&to=2026-03-31&compare=monthly`,
    );
    expect(pl.body.columns).toHaveLength(3);
    const csv = await owner.req("GET", `${base()}/reports/trial_balance?as_of=2026-12-31&format=csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain("Ledger chain head");
    expect(text).toContain("1000,Business Checking,");
  });

  test("accounts: create, sub-accounts, type integrity, delete rules", async () => {
    const c = await owner.json("POST", `${base()}/accounts`, {
      code: "6123",
      name: "Software",
      type: "expense",
      subtype: "other",
    });
    expect(c.status).toBe(201);
    const sub = await owner.json("POST", `${base()}/accounts`, {
      code: "6124",
      name: "Design tools",
      type: "expense",
      parent_id: c.body.id,
    });
    expect(sub.status).toBe(201);
    const wrongType = await owner.json("POST", `${base()}/accounts`, {
      code: "1999",
      name: "X",
      type: "asset",
      parent_id: c.body.id,
    });
    expect(wrongType.status).toBe(422);
    const dup = await owner.json("POST", `${base()}/accounts`, {
      code: "6123",
      name: "Dup",
      type: "expense",
    });
    expect(dup.status).toBe(409);
    const cycle = await owner.json("PATCH", `${base()}/accounts/${c.body.id}`, { parent_id: sub.body.id });
    expect(cycle.status).toBe(422);

    // An account with posted lines cannot change type and cannot be deleted.
    const used = acct["4000"]!;
    const t = await owner.json("PATCH", `${base()}/accounts/${used}`, { type: "expense" });
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe("account_in_use");
    expect((await owner.json("DELETE", `${base()}/accounts/${used}`)).status).toBe(409);
    const sys = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.system_key === "ar",
    );
    expect((await owner.json("DELETE", `${base()}/accounts/${sys.id}`)).status).toBe(409);
    expect((await owner.json("DELETE", `${base()}/accounts/${sub.body.id}`)).status).toBe(200);
  });

  test("sub-accounts carry their parent's type, detail type, and tax line down the tree", async () => {
    const mk = (b: Record<string, unknown>) => owner.json("POST", `${base()}/accounts`, b);
    const patch = (id: string, b: Record<string, unknown>) =>
      owner.json("PATCH", `${base()}/accounts/${id}`, b);
    const get = async (id: string) => (await owner.json("GET", `${base()}/accounts/${id}`)).body;
    const vals = (a: any) => [a.type, a.subtype, a.tax_line, a.parent_id];
    const updates = async (id: string) =>
      (await owner.json("GET", `${base()}/audit?limit=500&target_id=${id}`)).body.data.filter(
        (x: any) => x.action === "account.update",
      ).length;

    const parent = (await mk({ code: "7100", name: "Travel group", type: "expense", tax_line: "schc.24a" }))
      .body;
    const child = await mk({ code: "7110", name: "Flights", type: "expense", parent_id: parent.id });
    expect(child.status).toBe(201);
    expect(vals(child.body)).toEqual(["expense", "other", "schc.24a", parent.id]);
    const grand = (await mk({ code: "7111", name: "Upgrades", type: "expense", parent_id: child.body.id }))
      .body;
    expect(vals(grand)).toEqual(["expense", "other", "schc.24a", child.body.id]);
    // Explicit values that differ from the parent's are rejected.
    for (const extra of [{ type: "income" }, { subtype: "other_expense" }, { tax_line: null }]) {
      const bad = await mk({ code: "7119", name: "X", type: "expense", parent_id: parent.id, ...extra });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("invalid_parent");
    }
    expect((await patch(child.body.id, { subtype: "other_expense" })).status).toBe(422);

    // Changing the parent's detail type, tax line, or type cascades to grandchildren, with audit rows.
    const beforeAudit = await updates(grand.id);
    expect((await patch(parent.id, { subtype: "other_expense", tax_line: "schc.24b" })).status).toBe(200);
    expect(vals(await get(grand.id))).toEqual(["expense", "other_expense", "schc.24b", child.body.id]);
    expect((await patch(parent.id, { type: "income", subtype: "other_income", tax_line: null })).status).toBe(
      200,
    );
    expect(vals(await get(grand.id))).toEqual(["income", "other_income", null, child.body.id]);
    expect(vals(await get(child.body.id))).toEqual(["income", "other_income", null, parent.id]);
    expect(await updates(grand.id)).toBe(beforeAudit + 2);
    expect((await patch(parent.id, { type: "expense", subtype: "other", tax_line: "schc.24a" })).status).toBe(
      200,
    );

    // The web form sends every field; clearing the parent makes the values editable again (bug 1).
    const web = await patch(child.body.id, {
      code: "7110",
      name: "Flights",
      type: "asset",
      subtype: "other_current_asset",
      parent_id: null,
      tax_line: null,
    });
    expect(web.status).toBe(200);
    expect(vals(web.body)).toEqual(["asset", "other_current_asset", null, null]);
    expect(vals(await get(grand.id))).toEqual(["asset", "other_current_asset", null, child.body.id]);

    // Moving under a parent of another type is fine without posted lines...
    const moved = await patch(child.body.id, { parent_id: parent.id });
    expect(moved.status).toBe(200);
    expect(vals(await get(grand.id))).toEqual(["expense", "other", "schc.24a", child.body.id]);
    // ...and blocked when anything in the moving subtree has posted lines.
    acct["7111"] = grand.id;
    expect((await post(owner, simple("2026-04-15", 100, "7111", "1000"))).status).toBe(201);
    const blocked = await patch(child.body.id, { parent_id: acct["1000"] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("account_in_use");
    expect(blocked.body.error.message).toContain("7111 Upgrades");
    expect(vals(await get(child.body.id))).toEqual(["expense", "other", "schc.24a", parent.id]);
    // A move that keeps the type restates the detail type and tax line even with posted lines.
    const meals = (await mk({ code: "7200", name: "Meals group", type: "expense", tax_line: "schc.24b" }))
      .body;
    expect((await patch(child.body.id, { parent_id: meals.id })).status).toBe(200);
    expect(vals(await get(grand.id))).toEqual(["expense", "other", "schc.24b", child.body.id]);

    // System accounts can be parents but never sub-accounts.
    const all = (await owner.json("GET", `${base()}/accounts`)).body.data;
    const sys = all.find((a: any) => a.system_key === "uncategorized_expense");
    const sysMove = await patch(sys.id, { parent_id: parent.id });
    expect(sysMove.status).toBe(422);
    expect(sysMove.body.error.code).toBe("invalid_parent");
    const underSys = await mk({
      code: "7300",
      name: "Unsorted receipts",
      type: "expense",
      parent_id: sys.id,
    });
    expect(underSys.status).toBe(201);
    expect(underSys.body.subtype).toBe(sys.subtype);

    // Deactivating a parent deactivates its subtree, which must be all zero.
    const held = await patch(meals.id, { is_active: false });
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe("nonzero_balance");
    expect(held.body.error.message).toContain("7111 Upgrades");
    const idle = (await mk({ code: "7400", name: "Idle group", type: "expense" })).body;
    const idleKid = (await mk({ code: "7410", name: "Idle child", type: "expense", parent_id: idle.id }))
      .body;
    expect((await patch(idle.id, { is_active: false })).status).toBe(200);
    expect((await get(idleKid.id)).is_active).toBe(false);
    const early = await patch(idleKid.id, { is_active: true });
    expect(early.status).toBe(409);
    expect((await patch(idle.id, { is_active: true })).status).toBe(200);
    expect((await patch(idleKid.id, { is_active: true })).status).toBe(200);

    // Renaming and renumbering stay allowed for system accounts and accounts with posted lines.
    expect((await patch(sys.id, { code: "7990", name: "Unsorted" })).status).toBe(200);
    expect((await patch(sys.id, { code: sys.code, name: sys.name })).status).toBe(200);
    expect((await patch(grand.id, { code: "7112", name: "Seat upgrades" })).status).toBe(200);

    // Deleting needs an account with no lines at all, draft or posted.
    const drafty = (await mk({ code: "7500", name: "Drafty", type: "expense" })).body;
    acct["7500"] = drafty.id;
    expect((await post(owner, { ...simple("2026-04-16", 100, "7500", "1000"), draft: true })).status).toBe(
      201,
    );
    expect((await owner.json("DELETE", `${base()}/accounts/${drafty.id}`)).status).toBe(409);
    expect((await owner.json("DELETE", `${base()}/accounts/${grand.id}`)).status).toBe(409);
    expect((await owner.json("DELETE", `${base()}/accounts/${idleKid.id}`)).status).toBe(200);
  });

  test("concurrent posting never duplicates a chain sequence", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(owner, simple("2026-04-01", 100 + i))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.body.entry.chain_seq as number);
    expect(new Set(seqs).size).toBe(20);
    const v = await owner.json("POST", `${base()}/verify`);
    expect(v.body.ok).toBe(true);
  });
});

describe(`invariants hold against direct SQL (${DB_MODE})`, () => {
  let h: Awaited<ReturnType<TestEnv["ctx"]["orgs"]["mustOpen"]>>;
  let postedId: string;
  let draftId: string;

  beforeAll(async () => {
    h = await env.ctx.orgs.mustOpen(orgId);
    postedId = (await post(owner, simple("2026-05-01", 999))).body.entry.id;
    draftId = (await post(owner, { ...simple("2026-05-02", 10), draft: true })).body.entry.id;
  });

  const rejects = async (sql: string, args: (string | number | null)[] = []) => {
    let err: unknown = null;
    try {
      await h.client.execute({ sql, args });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message ?? "no error")).toMatch(/invariant|constraint|FOREIGN KEY/i);
  };

  test("posted entries and lines are immutable", async () => {
    await rejects("update journal_entries set memo = 'x' where id = ?", [postedId]);
    await rejects("update journal_entries set date = '2020-01-01' where id = ?", [postedId]);
    await rejects("update journal_entries set status = 'draft' where id = ?", [postedId]);
    await rejects("delete from journal_entries where id = ?", [postedId]);
    await rejects("update journal_lines set amount = amount + 1 where entry_id = ?", [postedId]);
    await rejects("delete from journal_lines where entry_id = ?", [postedId]);
    await rejects(
      "insert into journal_lines (id, entry_id, account_id, amount, currency, line_order) values ('x1', ?, ?, 5, 'USD', 9)",
      [postedId, acct["1000"]!],
    );
  });

  test("entries cannot be inserted posted or posted unbalanced or out of chain order", async () => {
    await rejects("insert into journal_entries (id, date, status) values ('p1', '2026-01-01', 'posted')");
    await rejects(
      "insert into journal_entries (id, date, status, chain_seq, prev_hash, entry_hash) values ('p2', '2026-01-01', 'draft', 999, 'a', 'b')",
    );
    await h.client.execute({
      sql: "insert into journal_lines (id, entry_id, account_id, amount, currency) values ('u1', ?, ?, 1, 'USD')",
      args: [draftId, acct["1000"]!],
    });
    const head = await h.client.execute(
      "select max(chain_seq) as s, (select entry_hash from journal_entries order by chain_seq desc limit 1) as hh from journal_entries",
    );
    const seq = Number(head.rows[0]!.s) + 1;
    await rejects(
      "update journal_entries set status='posted', posted_at='x', chain_seq=?, prev_hash=?, entry_hash='f' where id = ?",
      [seq, String(head.rows[0]!.hh), draftId],
    );
    await h.client.execute({ sql: "delete from journal_lines where id = 'u1'", args: [] });
    // balanced now, but a wrong sequence or prev hash is refused
    await rejects(
      "update journal_entries set status='posted', posted_at='x', chain_seq=?, prev_hash=?, entry_hash='f' where id = ?",
      [seq + 5, String(head.rows[0]!.hh), draftId],
    );
    await rejects(
      "update journal_entries set status='posted', posted_at='x', chain_seq=?, prev_hash='bogus', entry_hash='f' where id = ?",
      [seq, draftId],
    );
  });

  test("line currency, base currency, audit log, checkpoints", async () => {
    await rejects(
      "insert into journal_lines (id, entry_id, account_id, amount, currency) values ('c1', ?, ?, 1, 'EUR')",
      [draftId, acct["1000"]!],
    );
    await rejects("update org_settings set base_currency = 'EUR'");
    await rejects("update audit_log set action = 'x' where seq = 1");
    await rejects("delete from audit_log where seq = 1");
    await rejects("update chain_checkpoints set head_hash = 'x'");
    await rejects("delete from chain_checkpoints");
    await rejects("delete from schema_meta where key = 'ledger_genesis'");
    await rejects(
      "insert into audit_log (id, seq, at, actor, action, prev_hash, hash) values ('z', 99999, 'x', 'user', 'x', 'bad', 'x')",
    );
  });

  test("rejected entries never post", async () => {
    await h.client.execute({
      sql: "update journal_entries set status = 'rejected' where id = ?",
      args: [draftId],
    });
    await rejects("update journal_entries set status = 'draft' where id = ?", [draftId]);
    const e = await h.db.select().from(org.journalEntries).where(eq(org.journalEntries.id, draftId)).get();
    expect(e?.status).toBe("rejected");
  });
});

describe(`verify detects tampering (${DB_MODE})`, () => {
  test("names the first broken link in the ledger and audit chains", async () => {
    const id = await createOrg(env, owner, "Tamper Co");
    const a = await accountsByCode(owner, id);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post(
        owner,
        {
          date: `2026-01-0${i + 1}`,
          lines: [
            { account_id: a["1000"], amount: 100 + i },
            { account_id: a["4000"], amount: -(100 + i) },
          ],
        },
        id,
      );
      ids.push(r.body.entry.id);
    }
    const h = await env.ctx.orgs.mustOpen(id);
    expect((await verifyOrg(h.db, id)).ok).toBe(true);
    const tb = () => owner.json("GET", `/api/v1/orgs/${id}/reports/trial_balance`);
    const before = (await tb()).body.meta;
    expect(before.chain_intact).toBe(true);

    // An attacker with raw database access drops the guard and edits entry #3.
    await h.client.execute("drop trigger je_posted_immutable");
    await h.client.execute({
      sql: "update journal_entries set memo = 'cooked' where id = ?",
      args: [ids[2]!],
    });
    const v = await owner.json("POST", `/api/v1/orgs/${id}/verify`);
    expect(v.body.ok).toBe(false);
    expect(v.body.ledger.first_break.seq).toBe(3);
    expect(v.body.ledger.first_break.id).toBe(ids[2]);

    // The report footer recomputes the chain, so its head no longer matches earlier reports.
    const after = (await tb()).body.meta;
    expect(after.chain_intact).toBe(false);
    expect(after.chain_head.seq).toBe(before.chain_head.seq);
    expect(after.chain_head.hash).not.toBe(before.chain_head.hash);

    // Same for amounts, via lines.
    await h.client.execute("drop trigger jl_posted_no_update");
    await h.client.execute({
      sql: "update journal_lines set amount = amount * 10 where entry_id = ?",
      args: [ids[1]!],
    });
    const v2 = await verifyOrg(h.db, id);
    expect(v2.ledger.firstBreak?.seq).toBe(2);

    await h.client.execute("drop trigger audit_no_update");
    await h.client.execute("update audit_log set action = 'nothing.to.see' where seq = 2");
    const v3 = await verifyOrg(h.db, id);
    expect(v3.audit.ok).toBe(false);
    expect(v3.audit.firstBreak?.seq).toBe(2);

    // The weekly job fails and emails the owners.
    const mail = (env.ctx.services.mailer as Mailer).useTestTransport();
    const vj = registeredJobs().find((j) => j.name === "chain.verify")!;
    const run = await (env.ctx.services.scheduler as Scheduler).runJob(vj, id);
    expect(run.status).toBe("error");
    expect(mail.length).toBe(1);
    expect(mail[0]!.subject).toContain("integrity check failed for Tamper Co");
    expect(mail[0]!.text).toContain("chain verification failed: ledger seq 2");
  });
});

describe(`scheduled chain jobs (${DB_MODE})`, () => {
  test("daily checkpoint records heads only when something changed; weekly verify runs", async () => {
    const scheduler = env.ctx.services.scheduler as Scheduler;
    const cp = registeredJobs().find((j) => j.name === "chain.checkpoint")!;
    const vj = registeredJobs().find((j) => j.name === "chain.verify")!;
    const id = await createOrg(env, owner, "Jobs Co");
    const first = await scheduler.runJob(cp, id);
    expect(first.status).toBe("ok");
    expect(first.detail).toContain("checkpointed");
    const second = await scheduler.runJob(cp, id);
    expect(second.detail).toBe("no activity");
    const v = await scheduler.runJob(vj, id);
    expect(v.status).toBe("ok");

    // due() logic: daily after a run today is not due; weekly only on its weekday.
    const now = new Date("2026-06-07T12:00:00Z"); // a Sunday
    expect(cp.due(now, new Date("2026-06-07T01:00:00Z"), env.ctx)).toBe(false);
    expect(cp.due(now, new Date("2026-06-06T23:00:00Z"), env.ctx)).toBe(true);
    expect(vj.due(now, null, env.ctx)).toBe(true);
    expect(vj.due(new Date("2026-06-08T12:00:00Z"), null, env.ctx)).toBe(false);

    // tick() runs due jobs for every org and records them
    await scheduler.tick(new Date("2026-06-07T12:00:00Z"));
    expect(await scheduler.lastRun("chain.checkpoint", orgId)).not.toBeNull();
  });
});
