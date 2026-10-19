import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { migrate, orgMigrations, systemMigrations } from "./migrate.ts";

const dir = mkdtempSync(join(tmpdir(), "cosimo-migrate-"));
let client: Client;

beforeAll(() => {
  client = createClient({ url: `file:${join(dir, "org.db")}` });
});
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("0002 detaches invalid sub-accounts and copies the top-level detail type and tax line down", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0002_account_hierarchy");
  expect(upTo).toBeGreaterThan(0);
  await migrate(client, orgMigrations.slice(0, upTo));
  const rows: [string, string, string, string, string | null, string | null, number, string | null][] = [
    // id, code, type, subtype, parent, tax line, is_system, system_key
    ["p", "6000", "expense", "office", null, "schc.18", 0, null],
    ["c", "6010", "expense", "other", "p", null, 0, null],
    ["g", "6011", "expense", "cogs", "c", "schc.27a", 0, null],
    ["x", "1500", "asset", "fixed_asset", "p", "sched.x", 0, null],
    ["xc", "1510", "asset", "other", "x", null, 0, null],
    ["d", "6900", "expense", "travel", "missing", "schc.24a", 0, null],
    ["s", "6999", "expense", "other", "p", null, 1, "uncategorized_expense"],
  ];
  for (const [id, code, type, subtype, parent, tax, sys, key] of rows)
    await client.execute({
      sql: "INSERT INTO accounts (id, code, name, type, subtype, parent_id, tax_line, is_system, system_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, code, `Account ${code}`, type, subtype, parent, tax, sys, key],
    });

  expect(await migrate(client, orgMigrations.slice(0, upTo + 1))).toEqual(["0002_account_hierarchy"]);
  const rs = await client.execute("SELECT id, type, subtype, parent_id, tax_line FROM accounts ORDER BY id");
  const got = Object.fromEntries(
    rs.rows.map((r) => [String(r.id), [r.type, r.subtype, r.parent_id, r.tax_line]]),
  );
  expect(got).toEqual({
    p: ["expense", "office", null, "schc.18"],
    // Children and grandchildren take the top-level account's values.
    c: ["expense", "office", "p", "schc.18"],
    g: ["expense", "office", "c", "schc.18"],
    // A child of another type is detached with its values (and its own subtree's root) kept.
    x: ["asset", "fixed_asset", null, "sched.x"],
    xc: ["asset", "fixed_asset", "x", "sched.x"],
    // Dangling parents and system accounts become top level, unchanged.
    d: ["expense", "travel", null, "schc.24a"],
    s: ["expense", "other", null, null],
  });
});

test("0003 moves recurring invoices to recurring templates, back-fills runs, and heals drifted dates", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0003_recurring_templates");
  expect(upTo).toBeGreaterThan(0);
  expect(await migrate(client, orgMigrations.slice(0, upTo))).toEqual([]);
  await client.execute("INSERT INTO contacts (id, kind, name) VALUES ('c1', 'customer', 'Globex')");
  const lines = JSON.stringify([
    { description: "Retainer", quantity_milli: 1000, unit_price: 50000, account_id: "p" },
  ]);
  const templates: [string, string, string, string | null, number, number, number][] = [
    // id, frequency, next_date, end_date, due_days, auto_send, is_active
    ["t_drift", "monthly", "2026-04-28", null, 15, 0, 1],
    ["t_weekly", "weekly", "2026-05-08", null, 30, 1, 1],
    ["t_ended", "monthly", "2026-07-01", "2026-06-30", 30, 0, 0],
    ["t_paused", "quarterly", "2026-09-15", null, 30, 0, 0],
    ["t_leap", "yearly", "2026-02-28", null, 30, 0, 1],
  ];
  for (const [id, freq, next, end, due, send, active] of templates)
    await client.execute({
      sql: "INSERT INTO recurring_invoices (id, customer_id, name, frequency, next_date, end_date, due_days, template_json, auto_send, is_active) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        id,
        `Template ${id}`,
        freq,
        next,
        end,
        due,
        JSON.stringify({ memo: `Memo ${id}`, lines: JSON.parse(lines) }),
        send,
        active,
      ],
    });
  const invoices: [string, string, string, string | null][] = [
    // id, recurring_id, issue_date, sent_at
    ["i1", "t_drift", "2026-01-31", null],
    ["i2", "t_drift", "2026-02-28", null],
    ["i3", "t_drift", "2026-03-28", null],
    ["i4", "t_weekly", "2026-05-01", "2026-05-01T08:00:00.000Z"],
    ["i5", "t_ended", "2026-05-01", null],
    ["i6", "t_ended", "2026-06-01", null],
    // A manual edit left a second invoice on the same date.
    ["i7", "t_ended", "2026-06-01", null],
    ["i8", "t_leap", "2024-02-29", null],
    ["i9", "t_leap", "2025-02-28", null],
  ];
  for (const [id, rid, date, sent] of invoices)
    await client.execute({
      sql: "INSERT INTO invoices (id, number, customer_id, issue_date, due_date, recurring_id, sent_at) VALUES (?, ?, 'c1', ?, ?, ?, ?)",
      args: [id, `INV-${id}`, date, date, rid, sent],
    });

  expect(await migrate(client, orgMigrations.slice(0, upTo + 1))).toEqual(["0003_recurring_templates"]);
  const rs = await client.execute(
    "SELECT id, kind, contact_id, run_mode, status, unit, interval, anchor_day, start_date, end_date, next_index, next_date, last_run_date FROM recurring_templates ORDER BY id",
  );
  const got = Object.fromEntries(rs.rows.map((r) => [String(r.id), { ...r }]));
  expect(got.t_drift).toMatchObject({
    kind: "invoice",
    contact_id: "c1",
    run_mode: "draft",
    status: "active",
    unit: "month",
    interval: 1,
    // Healed: anchored on the first invoice's day, and the next date is back on the 30th of April.
    anchor_day: 31,
    start_date: "2026-04-30",
    next_index: 0,
    next_date: "2026-04-30",
    last_run_date: "2026-03-28",
  });
  expect(got.t_weekly).toMatchObject({
    run_mode: "post_and_send",
    status: "active",
    unit: "week",
    interval: 1,
    anchor_day: null,
    start_date: "2026-05-08",
    next_date: "2026-05-08",
  });
  expect(got.t_ended).toMatchObject({
    status: "ended",
    unit: "month",
    end_date: "2026-06-30",
    next_date: null,
  });
  expect(got.t_paused).toMatchObject({
    status: "paused",
    unit: "month",
    interval: 3,
    next_date: "2026-09-15",
  });
  // February 29 anchors the yearly template; 2026 has no 29th, so the date stays on the 28th.
  expect(got.t_leap).toMatchObject({ unit: "year", anchor_day: 29, next_date: "2026-02-28" });

  const tpl = await client.execute("SELECT template_json FROM recurring_templates WHERE id = 't_drift'");
  expect(JSON.parse(String(tpl.rows[0]!.template_json))).toEqual({
    memo: "Memo t_drift",
    terms: null,
    due_days: 15,
    lines: JSON.parse(lines),
  });

  const runs = await client.execute(
    "SELECT template_id, occurrence_index, scheduled_date, status, doc_type, doc_id, send_status FROM recurring_runs ORDER BY template_id, scheduled_date",
  );
  expect(
    runs.rows.map((r) => [r.template_id, r.occurrence_index, r.scheduled_date, r.doc_id, r.send_status]),
  ).toEqual([
    ["t_drift", -3, "2026-01-31", "i1", "not_needed"],
    ["t_drift", -2, "2026-02-28", "i2", "not_needed"],
    ["t_drift", -1, "2026-03-28", "i3", "not_needed"],
    ["t_ended", -3, "2026-05-01", "i5", "not_needed"],
    ["t_ended", -2, "2026-06-01", "i6", "not_needed"],
    ["t_leap", -2, "2024-02-29", "i8", "not_needed"],
    ["t_leap", -1, "2025-02-28", "i9", "not_needed"],
    ["t_weekly", -1, "2026-05-01", "i4", "sent"],
  ]);
  expect(runs.rows.every((r) => r.status === "created" && r.doc_type === "invoice")).toBe(true);

  const old = await client.execute(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'recurring_invoices'",
  );
  expect(Number(old.rows[0]!.n)).toBe(0);
  const billCols = await client.execute("SELECT name FROM pragma_table_info('bills')");
  expect(billCols.rows.map((r) => r.name)).toContain("recurring_id");
});

test("0004 adds online payment settings, invoice pay-link columns, and the provider tables", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0004_online_payments");
  expect(upTo).toBeGreaterThan(0);
  expect(await migrate(client, orgMigrations.slice(0, upTo))).toEqual([]);
  expect(await migrate(client, orgMigrations.slice(0, upTo + 1))).toEqual(["0004_online_payments"]);
  const cols = async (t: string) =>
    (await client.execute(`SELECT name FROM pragma_table_info('${t}')`)).rows.map((r) => String(r.name));
  expect(await cols("org_settings")).toEqual(
    expect.arrayContaining([
      "payment_provider",
      "payment_credentials_enc",
      "payment_options_json",
      "payment_clearing_account_id",
      "payment_fee_account_id",
      "online_pay_default",
    ]),
  );
  expect(await cols("invoices")).toEqual(
    expect.arrayContaining(["online_pay_enabled", "manual_pay_url", "pay_token_version", "pay_token_hash"]),
  );
  // Existing invoices keep working: online payment off, no link yet.
  const inv = await client.execute(
    "SELECT online_pay_enabled, pay_token_version FROM invoices WHERE id = 'i1'",
  );
  expect(inv.rows[0]).toMatchObject({ online_pay_enabled: 0, pay_token_version: 0 });

  await client.execute(
    "INSERT INTO payments (id, direction, contact_id, date, amount, bank_account_id) VALUES ('p1', 'received', 'c1', '2026-05-01', 100, 'p')",
  );
  const pp =
    "INSERT INTO provider_payments (provider, provider_payment_id, payment_id, gross) VALUES ('stripe', 'pi_1', 'p1', 100)";
  await client.execute(pp);
  // The same provider payment can't be recorded twice.
  await expect(client.execute(pp)).rejects.toThrow(/UNIQUE/);
  const ev = "INSERT INTO provider_events (id, provider, event_id, type) VALUES (?, 'stripe', 'evt_1', 'x')";
  await client.execute({ sql: ev, args: ["e1"] });
  await expect(client.execute({ sql: ev, args: ["e2"] })).rejects.toThrow(/UNIQUE/);
});

test("0005 adds the pay-link failure columns to invoices", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0005_pay_link_errors");
  expect(upTo).toBeGreaterThan(0);
  expect(await migrate(client, orgMigrations.slice(0, upTo))).toEqual([]);
  expect(await migrate(client, orgMigrations.slice(0, upTo + 1))).toEqual(["0005_pay_link_errors"]);
  const cols = (await client.execute("SELECT name FROM pragma_table_info('invoices')")).rows.map((r) =>
    String(r.name),
  );
  expect(cols).toEqual(expect.arrayContaining(["pay_attempt", "pay_error", "pay_error_at"]));
  // Existing invoices start with no attempts and no error.
  const inv = await client.execute(
    "SELECT pay_attempt, pay_error, pay_error_at FROM invoices WHERE id = 'i1'",
  );
  expect(inv.rows[0]).toMatchObject({ pay_attempt: 0, pay_error: null, pay_error_at: null });
});

test("0006 adds provider adjustments and payouts, and cash balances on provider customers", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0006_provider_adjustments");
  expect(upTo).toBeGreaterThan(0);
  expect(await migrate(client, orgMigrations.slice(0, upTo))).toEqual([]);
  await client.execute(
    "INSERT INTO provider_customers (contact_id, provider, provider_customer_id) VALUES ('c1', 'stripe', 'cus_1')",
  );
  expect(await migrate(client, orgMigrations.slice(0, upTo + 1))).toEqual(["0006_provider_adjustments"]);
  // Existing customers have no balance read yet.
  const pc = await client.execute("SELECT cash_balance, cash_balance_checked_at FROM provider_customers");
  expect(pc.rows[0]).toMatchObject({ cash_balance: null, cash_balance_checked_at: null });
  const adj =
    "INSERT INTO provider_adjustments (provider, provider_object_id, kind, provider_payment_id, payment_id, amount, occurred_on) VALUES ('stripe', 're_1', 'refund', 'pi_1', 'p1', 50, '2026-05-02')";
  await client.execute(adj);
  // The same refund or dispute movement can't be proposed twice.
  await expect(client.execute(adj)).rejects.toThrow(/UNIQUE/);
  const row = await client.execute(
    "SELECT fee, entry_id FROM provider_adjustments WHERE provider_object_id = 're_1'",
  );
  expect(row.rows[0]).toMatchObject({ fee: 0, entry_id: null });
  const po =
    "INSERT INTO provider_payouts (provider, payout_id, amount, arrival_date, status) VALUES ('stripe', 'po_1', 98, '2026-05-03', 'paid')";
  await client.execute(po);
  await expect(client.execute(po)).rejects.toThrow(/UNIQUE/);
});

test("0001_known_randall (system) backfills is_sample for the existing demo org by name", async () => {
  const sysDir = mkdtempSync(join(tmpdir(), "cosimo-migrate-sys-"));
  const sysClient = createClient({ url: `file:${join(sysDir, "system.db")}` });
  try {
    const upTo = systemMigrations.findIndex((m) => m.tag === "0001_known_randall");
    expect(upTo).toBeGreaterThan(0);
    await migrate(sysClient, systemMigrations.slice(0, upTo));
    await sysClient.execute({
      sql: "INSERT INTO organizations (id, name, db_url) VALUES (?, ?, ?)",
      args: ["o1", "Demo Studio (sample data)", "file:demo.db"],
    });
    await sysClient.execute({
      sql: "INSERT INTO organizations (id, name, db_url) VALUES (?, ?, ?)",
      args: ["o2", "Real Co", "file:real.db"],
    });

    expect(await migrate(sysClient, systemMigrations.slice(0, upTo + 1))).toEqual(["0001_known_randall"]);
    const rs = await sysClient.execute("SELECT id, is_sample FROM organizations ORDER BY id");
    expect(rs.rows.map((r) => [r.id, r.is_sample])).toEqual([
      ["o1", 1],
      ["o2", 0],
    ]);
  } finally {
    sysClient.close();
    rmSync(sysDir, { recursive: true, force: true });
  }
});

test("0002_oauth_multi_org (system) moves each code's and token's org into one grant, with that org as the default", async () => {
  const sysDir = mkdtempSync(join(tmpdir(), "cosimo-migrate-sys-"));
  const sysClient = createClient({ url: `file:${join(sysDir, "system.db")}` });
  try {
    const upTo = systemMigrations.findIndex((m) => m.tag === "0002_oauth_multi_org");
    expect(upTo).toBeGreaterThan(0);
    await migrate(sysClient, systemMigrations.slice(0, upTo));
    expect((await sysClient.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1);
    const run = (sql: string, args: (string | null)[]) => sysClient.execute({ sql, args });
    await run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "u1@example.com"]);
    await run("INSERT INTO organizations (id, name, db_url) VALUES (?, ?, ?)", ["o1", "Acme", "file:a.db"]);
    await run("INSERT INTO organizations (id, name, db_url) VALUES (?, ?, ?)", ["o2", "Other", "file:b.db"]);
    await run(
      "INSERT INTO oauth_clients (id, client_name, redirect_uris_json, registered_via) VALUES (?, ?, ?, ?)",
      ["c1", "Claude", "[]", "dynamic"],
    );
    await run(
      "INSERT INTO oauth_codes (code_hash, client_id, user_id, org_id, role, scope, code_challenge, redirect_uri, expires_at) VALUES (?, 'c1', 'u1', ?, ?, 'books', 'x', 'https://c/cb', '2030-01-01')",
      ["h1", "o1", "viewer"],
    );
    const token =
      "INSERT INTO oauth_tokens (id, client_id, user_id, org_id, role, scope, access_token_hash, refresh_token_hash, access_expires_at, created_at, revoked_at) VALUES (?, 'c1', 'u1', ?, ?, 'books', ?, ?, '2030-01-01', '2026-01-01T00:00:00.000Z', ?)";
    await run(token, ["t1", "o1", "bookkeeper", "a1", "r1", null]);
    await run(token, ["t2", "o2", "accountant", "a2", "r2", null]);
    await run(token, ["t3", "o1", "owner", "a3", "r3", "2026-02-01T00:00:00.000Z"]);

    expect(await migrate(sysClient, systemMigrations.slice(0, upTo + 1))).toEqual(["0002_oauth_multi_org"]);
    const tokens = await sysClient.execute(
      "SELECT id, default_org_id, access_token_hash, refresh_token_hash, revoked_at FROM oauth_tokens ORDER BY id",
    );
    expect(
      tokens.rows.map((r) => [r.id, r.default_org_id, r.access_token_hash, r.refresh_token_hash]),
    ).toEqual([
      ["t1", "o1", "a1", "r1"],
      ["t2", "o2", "a2", "r2"],
      ["t3", "o1", "a3", "r3"],
    ]);
    const grants = await sysClient.execute(
      "SELECT token_id, org_id, role, created_at, revoked_at FROM oauth_token_orgs ORDER BY token_id",
    );
    expect(grants.rows.map((r) => [r.token_id, r.org_id, r.role, r.created_at, r.revoked_at])).toEqual([
      ["t1", "o1", "bookkeeper", "2026-01-01T00:00:00.000Z", null],
      ["t2", "o2", "accountant", "2026-01-01T00:00:00.000Z", null],
      ["t3", "o1", "owner", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    ]);
    const codes = await sysClient.execute("SELECT code_hash, default_org_id FROM oauth_codes");
    expect(codes.rows.map((r) => [r.code_hash, r.default_org_id])).toEqual([["h1", "o1"]]);
    const codeOrgs = await sysClient.execute("SELECT code_hash, org_id, role FROM oauth_code_orgs");
    expect(codeOrgs.rows.map((r) => [r.code_hash, r.org_id, r.role])).toEqual([["h1", "o1", "viewer"]]);

    // The old columns are gone, and the child tables' foreign keys point at the rebuilt tables.
    const cols = (await sysClient.execute("SELECT name FROM pragma_table_info('oauth_tokens')")).rows.map(
      (r) => String(r.name),
    );
    expect(cols).not.toContain("org_id");
    expect(cols).not.toContain("role");
    expect((await sysClient.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    const fks = await sysClient.execute(
      "SELECT m.name AS t, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.name IN ('oauth_token_orgs', 'oauth_code_orgs') ORDER BY m.name, parent",
    );
    expect(fks.rows.map((r) => [r.t, r.parent])).toEqual([
      ["oauth_code_orgs", "oauth_codes"],
      ["oauth_code_orgs", "organizations"],
      ["oauth_token_orgs", "oauth_tokens"],
      ["oauth_token_orgs", "organizations"],
    ]);
    await expect(
      run("INSERT INTO oauth_token_orgs (token_id, org_id, role) VALUES (?, ?, ?)", [
        "missing",
        "o1",
        "viewer",
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
  } finally {
    sysClient.close();
    rmSync(sysDir, { recursive: true, force: true });
  }
});
