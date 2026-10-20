/**
 * Plaid bank feeds (SPEC §7.1, §15.1) against a scripted fake of the Plaid API: Link exchange,
 * added / modified / removed / pending-to-posted sync, pagination restarts, reauth, webhooks with
 * real ES256 signatures, polling, org-level keys, and disconnect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256Hex } from "@cosimo/core";
import { org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { registeredJobs, type Scheduler } from "../src/jobs/scheduler.ts";
import { clearWebhookKeys, handleWebhook, plaidCents, syncConnection } from "../src/services/plaid.ts";
import { type Jwk, type PlaidAccount, PlaidError, setPlaidFactory } from "../src/services/plaid-client.ts";
import { type FakeItem, FakePlaid } from "./fake-plaid.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

// ----------------------------------------------------------------------------- webhook signing

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let signingKey: CryptoKey;

async function setupSigning(fake: FakePlaid) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  fake.keys.set("k1", { ...jwk, kid: "k1", alg: "ES256", use: "sig", expired_at: null });
}

async function sign(body: string, opts: { iat?: number; hash?: string; kid?: string } = {}) {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: opts.kid ?? "k1", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      request_body_sha256: opts.hash ?? sha256Hex(body),
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

// ----------------------------------------------------------------------------- setup

let env: TestEnv;
let owner: Client;
let orgId: string;
let fake: FakePlaid;
let restore: () => void;
const base = () => `/api/v1/orgs/${orgId}`;

const ACCOUNTS: PlaidAccount[] = [
  { account_id: "acc-chk", name: "Plaid Checking", mask: "0000", type: "depository", subtype: "checking" },
  { account_id: "acc-sav", name: "Plaid Saving", mask: "1111", type: "depository", subtype: "savings" },
  { account_id: "acc-cc", name: "Plaid Credit Card", mask: "3333", type: "credit", subtype: "credit card" },
  { account_id: "acc-inv", name: "Plaid IRA", mask: "5555", type: "investment", subtype: "ira" },
];

async function txns(bankAccountId: string) {
  const r = await owner.json(
    "GET",
    `${base()}/bank-transactions?bank_account_id=${bankAccountId}&status=all`,
  );
  return r.body.data as any[];
}

async function bankAccountFor(connectionId: string, providerId: string) {
  const h = await env.ctx.orgs.mustOpen(orgId);
  return (
    await h.db.select().from(org.bankAccounts).where(eq(org.bankAccounts.connectionId, connectionId)).all()
  ).find((a) => a.providerAccountId === providerId)!;
}

beforeAll(async () => {
  env = await createTestEnv();
  fake = new FakePlaid();
  restore = setPlaidFactory((c) => {
    fake.creds.push(c);
    return fake;
  });
  await setupSigning(fake);
  owner = await login(env, "plaid-owner@example.com");
  orgId = await createOrg(env, owner, "Feeds Co");
});

afterAll(async () => {
  restore();
  await env.close();
});

// ----------------------------------------------------------------------------- tests

describe(`Plaid (${DB_MODE})`, () => {
  let connId: string;
  let item: FakeItem;
  let chk: string;

  test("sign conversion is exact", () => {
    expect(plaidCents(12.34)).toBe(-1234);
    expect(plaidCents(-4.35)).toBe(435);
    expect(plaidCents(0)).toBe(0);
    expect(plaidCents(1.1 + 2.2)).toBe(-330);
  });

  test("not configured: status says so and Link is refused", async () => {
    const s = await owner.json("GET", `${base()}/plaid`);
    expect(s.body).toMatchObject({ configured: false, env: null, webhooks: false });
    const r = await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plaid_not_configured");
  });

  test("instance keys enable Link; only owners may connect", async () => {
    await env.ctx.settings.set("plaid", {
      enabled: true,
      env: "sandbox",
      client_id: "cid-instance",
      secret: "instance-secret-value",
    });
    const s = await owner.json("GET", `${base()}/plaid`);
    expect(s.body).toMatchObject({ configured: true, env: "sandbox", source: "instance", webhooks: false });
    expect(JSON.stringify(s.body)).not.toContain("instance-secret-value");

    const r = await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ link_token: "link-sandbox-1", update_mode: false });
    // No public HTTPS URL: no webhook registered, polling covers it.
    expect(fake.linkRequests[0]!.webhook).toBeNull();
    expect(fake.creds.at(-1)).toMatchObject({ clientId: "cid-instance", secret: "instance-secret-value" });

    const bk = await login(env, "plaid-bk@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    const denied = await bk.json("POST", `${base()}/plaid/link-token`, {});
    expect(denied.status).toBe(403);
  });

  test("exchange creates bank and ledger accounts, encrypts the token, and runs the first sync", async () => {
    const n = fake.newItem(ACCOUNTS);
    item = n.item;
    item.add({
      transaction_id: "t1",
      account_id: "acc-chk",
      amount: 25.5,
      name: "COFFEE",
      merchant_name: "Blue Bottle",
    });
    item.add({ transaction_id: "t2", account_id: "acc-chk", amount: -1200, name: "CLIENT DEPOSIT" });
    item.add({
      transaction_id: "t3-pend",
      account_id: "acc-cc",
      amount: 80,
      name: "HARDWARE",
      pending: true,
    });
    item.add({ transaction_id: "t4", account_id: "acc-inv", amount: 5, name: "FEE" });

    const r = await owner.json("POST", `${base()}/plaid/exchange`, { public_token: n.publicToken });
    expect(r.status).toBe(201);
    connId = r.body.connection.id;
    expect(r.body.connection).toMatchObject({
      institution_name: "First Platypus Bank",
      status: "active",
      message: null,
    });
    expect(r.body.connection.accounts.map((a: any) => a.kind).sort()).toEqual([
      "checking",
      "credit_card",
      "savings",
    ]);
    expect(r.body.sync).toMatchObject({ added: 3, skipped: 1 });
    expect(JSON.stringify(r.body)).not.toContain(item.accessToken);

    const h = await env.ctx.orgs.mustOpen(orgId);
    const row = await h.db.select().from(org.bankConnections).where(eq(org.bankConnections.id, connId)).get();
    expect(row!.accessTokenEnc).not.toContain(item.accessToken);
    expect(env.ctx.secrets.reveal(row!.accessTokenEnc)).toBe(item.accessToken);
    expect(row!.syncCursor).toBe("4");

    const audit = await h.client.execute("select before_json, after_json from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain(item.accessToken);

    const accts = (await owner.json("GET", `${base()}/accounts`)).body.data as any[];
    const cc = await bankAccountFor(connId, "acc-cc");
    expect(accts.find((a) => a.id === cc.ledgerAccountId)).toMatchObject({
      type: "liability",
      subtype: "credit_card",
    });

    chk = (await bankAccountFor(connId, "acc-chk")).id;
    const rows = await txns(chk);
    const coffee = rows.find((t) => t.description === "COFFEE");
    expect(coffee).toMatchObject({ amount: -2550, payee: "Blue Bottle", status: "new", is_pending: false });
    expect(rows.find((t) => t.description === "CLIENT DEPOSIT").amount).toBe(120000);
  });

  test("the same bank login cannot be connected twice", async () => {
    fake.byPublic.set("public-dup", item);
    const r = await owner.json("POST", `${base()}/plaid/exchange`, { public_token: "public-dup" });
    expect(r.status).toBe(409);
  });

  test("pending transactions can't be categorized; posting replaces the pending row", async () => {
    const cc = (await bankAccountFor(connId, "acc-cc")).id;
    const pend = (await txns(cc))[0];
    expect(pend.is_pending).toBe(true);
    const acct =
      (await owner.json("GET", `${base()}/accounts`)).body.data.find((a: any) => a.code === "6000") ??
      (await owner.json("GET", `${base()}/accounts`)).body.data.find((a: any) => a.type === "expense");
    const cat = await owner.json("POST", `${base()}/bank-transactions/${pend.id}/categorize`, {
      splits: [{ account_id: acct.id, amount: 8000 }],
    });
    expect(cat.status).toBe(409);
    expect(cat.body.error.code).toBe("pending_transaction");

    item.remove("t3-pend");
    item.add({
      transaction_id: "t3",
      account_id: "acc-cc",
      amount: 82.1,
      name: "HARDWARE",
      pending_transaction_id: "t3-pend",
    });
    const s = await syncConnection(env.ctx, orgId, connId);
    expect(s).toMatchObject({ added: 1, removed: 1 });
    const rows = await txns(cc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -8210, is_pending: false, status: "new" });

    const ok = await owner.json("POST", `${base()}/bank-transactions/${rows[0].id}/categorize`, {
      splits: [{ account_id: acct.id, amount: 8210 }],
    });
    expect(ok.status).toBe(200);
  });

  test("modified updates unreviewed rows; changes to booked rows are kept and audited", async () => {
    item.modify({
      transaction_id: "t1",
      account_id: "acc-chk",
      amount: 26.75,
      date: "2026-03-03",
      name: "COFFEE",
      pending: false,
      merchant_name: "Blue Bottle",
    });
    let s = await syncConnection(env.ctx, orgId, connId);
    expect(s.modified).toBe(1);
    const coffee = (await txns(chk)).find((t) => t.description === "COFFEE");
    expect(coffee).toMatchObject({ amount: -2675, date: "2026-03-03" });

    // Book the deposit, then the bank edits and removes it.
    const dep = (await txns(chk)).find((t) => t.description === "CLIENT DEPOSIT");
    const income = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.code === "4000",
    );
    expect(
      (
        await owner.json("POST", `${base()}/bank-transactions/${dep.id}/categorize`, {
          splits: [{ account_id: income.id, amount: 120000 }],
        })
      ).status,
    ).toBe(200);
    item.modify({
      transaction_id: "t2",
      account_id: "acc-chk",
      amount: -1300,
      date: "2026-03-02",
      name: "CLIENT DEPOSIT",
      pending: false,
    });
    item.remove("t2");
    s = await syncConnection(env.ctx, orgId, connId);
    expect(s).toMatchObject({ modified: 0, removed: 0 });
    const kept = (await txns(chk)).find((t) => t.id === dep.id);
    expect(kept).toMatchObject({ amount: 120000, status: "categorized" });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const audit = await h.client.execute({
      sql: "select action from audit_log where target_id = ? order by seq",
      args: [dep.id],
    });
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["bank_txn.provider_modified", "bank_txn.provider_removed"]),
    );
  });

  test("syncing again is idempotent, and a replayed page creates no duplicates", async () => {
    const before = (await txns(chk)).length;
    expect(await syncConnection(env.ctx, orgId, connId)).toMatchObject({ added: 0, modified: 0, removed: 0 });
    const h = await env.ctx.orgs.mustOpen(orgId);
    await h.write((tx) =>
      tx.update(org.bankConnections).set({ syncCursor: null }).where(eq(org.bankConnections.id, connId)),
    );
    await syncConnection(env.ctx, orgId, connId);
    expect((await txns(chk)).length).toBe(before);
  });

  test("a mutation during pagination restarts from the original cursor", async () => {
    item.add({ transaction_id: "t6", account_id: "acc-chk", amount: 10, name: "LUNCH" });
    item.add({ transaction_id: "t7", account_id: "acc-chk", amount: 11, name: "DINNER" });
    item.add({ transaction_id: "t8", account_id: "acc-chk", amount: 12, name: "BREAKFAST" });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const cur = (await h.db
      .select()
      .from(org.bankConnections)
      .where(eq(org.bankConnections.id, connId))
      .get())!.syncCursor;
    fake.mutateOnce = true;
    const s = await syncConnection(env.ctx, orgId, connId);
    expect(s.added).toBe(3);
    const after = (await h.db
      .select()
      .from(org.bankConnections)
      .where(eq(org.bankConnections.id, connId))
      .get())!;
    expect(Number(after.syncCursor)).toBe(Number(cur) + 3);
  });

  test("login required: needs_reauth, polling skips it, update-mode Link, then reconnected", async () => {
    fake.failSync = new PlaidError(
      "ITEM_LOGIN_REQUIRED",
      "ITEM_ERROR",
      "the login details have changed",
      400,
    );
    const r = await owner.json("POST", `${base()}/bank-connections/${connId}/sync`, {});
    expect(r.status).toBe(502);
    const c = (await owner.json("GET", `${base()}/bank-connections/${connId}`)).body;
    expect(c).toMatchObject({ status: "needs_reauth", error_code: "ITEM_LOGIN_REQUIRED" });
    expect(c.message).toContain("sign in again");

    const job = registeredJobs().find((j) => j.name === "plaid.sync")!;
    const run = await (env.ctx.services.scheduler as Scheduler).runJob(job, orgId);
    expect(run.status).toBe("ok");
    expect(run.detail).toContain("1 waiting on reconnect");

    const lt = await owner.json("POST", `${base()}/plaid/link-token`, { connection_id: connId });
    expect(lt.body.update_mode).toBe(true);
    expect(fake.linkRequests.at(-1)!.accessToken).toBe(item.accessToken);

    fake.failSync = null;
    item.add({ transaction_id: "t9", account_id: "acc-chk", amount: 9, name: "AFTER REAUTH" });
    const re = await owner.json("POST", `${base()}/bank-connections/${connId}/reconnected`, {});
    expect(re.status).toBe(200);
    expect(re.body.connection.status).toBe("active");
    expect(re.body.sync.added).toBe(1);
  });

  test("polling syncs active connections", async () => {
    item.add({ transaction_id: "t10", account_id: "acc-sav", amount: -50, name: "INTEREST" });
    const job = registeredJobs().find((j) => j.name === "plaid.sync")!;
    const run = await (env.ctx.services.scheduler as Scheduler).runJob(job, orgId);
    expect(run.status).toBe("ok");
    const sav = (await bankAccountFor(connId, "acc-sav")).id;
    expect((await txns(sav)).map((t) => t.description)).toContain("INTEREST");
  });

  test("webhooks: signature, body hash, and age are verified; sync and item errors are handled", async () => {
    clearWebhookKeys();
    const path = `/api/v1/webhooks/plaid/${orgId}`;
    const send = (body: string, sig?: string) =>
      env.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(sig ? { "plaid-verification": sig } : {}) },
        body,
      });

    const body = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: item.itemId,
    });
    expect((await send(body)).status).toBe(401);
    expect((await send(body, await sign(body, { hash: sha256Hex("something else") }))).status).toBe(401);
    expect((await send(body, await sign(body, { iat: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(
      401,
    );
    expect((await send(body, await sign(body, { kid: "unknown" }))).status).toBe(401);
    const tampered = await sign(body);
    expect((await send(body.replace("SYNC", "SYNX"), tampered)).status).toBe(401);

    item.add({ transaction_id: "t11", account_id: "acc-chk", amount: 7, name: "VIA WEBHOOK" });
    const ok = await send(body, await sign(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, action: "sync" });
    await syncConnection(env.ctx, orgId, connId); // joins or follows the webhook's sync
    expect((await txns(chk)).map((t) => t.description)).toContain("VIA WEBHOOK");

    const errBody = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: item.itemId,
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    });
    const res = await handleWebhook(env.ctx, orgId, errBody, await sign(errBody));
    expect(res.action).toBe("status");
    expect((await owner.json("GET", `${base()}/bank-connections/${connId}`)).body.status).toBe(
      "needs_reauth",
    );

    const repaired = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: item.itemId,
    });
    const rep = await handleWebhook(env.ctx, orgId, repaired, await sign(repaired));
    await rep.done;
    expect((await owner.json("GET", `${base()}/bank-connections/${connId}`)).body.status).toBe("active");

    const unknown = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "nope",
    });
    expect((await (await send(unknown, await sign(unknown))).json()).action).toBe("ignored");
  });

  test("an HTTPS public URL registers the webhook on Link", async () => {
    await env.ctx.settings.set("plaid", { webhook_url: "https://books.example.com/" });
    await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(fake.linkRequests.at(-1)!.webhook).toBe(
      `https://books.example.com/api/v1/webhooks/plaid/${orgId}`,
    );
    expect((await owner.json("GET", `${base()}/plaid`)).body.webhooks).toBe(true);
    await env.ctx.settings.set("plaid", { webhook_url: "" });
  });

  test("linking a statement-imported account skips feed rows up to the last imported date", async () => {
    const ba = await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Old checking",
      kind: "checking",
    });
    const csv = "Date,Description,Amount\n2026-03-01,RENT,-1500.00\n2026-03-05,SALE,200.00\n";
    const imp = await owner.json("POST", `${base()}/bank-accounts/${ba.body.id}/import`, {
      filename: "mar.csv",
      content: csv,
    });
    expect(imp.body.imported).toBe(2);

    const n = fake.newItem([
      { account_id: "old-chk", name: "Checking", mask: "9999", type: "depository", subtype: "checking" },
    ]);
    n.item.add({
      transaction_id: "o1",
      account_id: "old-chk",
      amount: 1500,
      date: "2026-03-01",
      name: "RENT",
    });
    n.item.add({
      transaction_id: "o2",
      account_id: "old-chk",
      amount: -200,
      date: "2026-03-05",
      name: "SALE",
    });
    n.item.add({
      transaction_id: "o3",
      account_id: "old-chk",
      amount: 40,
      date: "2026-03-06",
      name: "NEW STUFF",
    });
    const r = await owner.json("POST", `${base()}/plaid/exchange`, {
      public_token: n.publicToken,
      accounts: [{ account_id: "old-chk", action: "link", bank_account_id: ba.body.id }],
    });
    expect(r.status).toBe(201);
    expect(r.body.sync).toMatchObject({ added: 1, skipped: 2 });
    expect((await txns(ba.body.id)).map((t) => t.description).sort()).toEqual(["NEW STUFF", "RENT", "SALE"]);
  });

  test("org-level keys override instance keys and are never returned", async () => {
    const r = await owner.json("PATCH", base(), {
      plaid: { env: "production", client_id: "cid-org", secret: "org-secret-value" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plaid_override: true, plaid_env: "production" });
    expect(JSON.stringify(r.body)).not.toContain("org-secret-value");
    expect((await owner.json("GET", `${base()}/plaid`)).body).toMatchObject({
      source: "org",
      env: "production",
    });
    await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(fake.creds.at(-1)).toMatchObject({
      env: "production",
      clientId: "cid-org",
      secret: "org-secret-value",
    });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const s = await h.db.select().from(org.orgSettings).get();
    expect(s!.plaidSecretEnc).not.toContain("org-secret-value");
    const audit = await h.client.execute("select before_json, after_json from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain("org-secret-value");
    await owner.json("PATCH", base(), { plaid: null });
    expect((await owner.json("GET", `${base()}/plaid`)).body.source).toBe("instance");
  });

  test("disconnect removes the item at Plaid and forgets the token; history stays", async () => {
    const before = (await txns(chk)).length;
    const r = await owner.json("DELETE", `${base()}/bank-connections/${connId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "disconnected" });
    expect(fake.removed).toContain(item.itemId);
    const h = await env.ctx.orgs.mustOpen(orgId);
    const row = await h.db.select().from(org.bankConnections).where(eq(org.bankConnections.id, connId)).get();
    expect(row!.accessTokenEnc).toBe("");
    expect((await txns(chk)).length).toBe(before);
    expect((await owner.json("POST", `${base()}/bank-connections/${connId}/sync`, {})).status).toBe(409);
    // The bank login can be connected again afterwards.
    fake.byPublic.set("public-again", item);
    expect(
      (
        await owner.json("POST", `${base()}/plaid/exchange`, {
          public_token: "public-again",
          accounts: ACCOUNTS.map((a) => ({ account_id: a.account_id, action: "skip" })),
        })
      ).status,
    ).toBe(201);
  });
});

describe(`Plaid key checks on save (${DB_MODE})`, () => {
  test("org keys are checked with Plaid and a rejection names the environment; nothing is saved", async () => {
    fake.rejectKeys = true;
    const r = await owner.json("PATCH", base(), {
      plaid: { env: "sandbox", client_id: "cid-wrong", secret: "production-secret-value" },
    });
    fake.rejectKeys = false;
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plaid_keys_rejected");
    expect(r.body.error.message).toContain("rejected these keys for Sandbox");
    expect(r.body.error.message).toContain("Production");
    expect(JSON.stringify(r.body)).not.toContain("production-secret-value");
    expect(fake.keyChecks.at(-1)).toMatchObject({ env: "sandbox", clientId: "cid-wrong" });
    expect((await owner.json("GET", base())).body.settings.plaid_override).toBe(false);
  });

  test("instance keys are trimmed, checked when they change, and rejected keys save nothing", async () => {
    const admin = await login(env, "plaid-admin@example.com", { admin: true });
    const ok = await admin.json("PATCH", "/api/v1/admin/settings", {
      plaid: { enabled: true, env: "sandbox", client_id: "  cid-pasted\n", secret: " pasted-secret \n" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plaid.client_id).toBe("cid-pasted");
    expect(fake.keyChecks.at(-1)).toMatchObject({ clientId: "cid-pasted", secret: "pasted-secret" });
    expect((await env.ctx.settings.get("plaid")).secret).toBe("pasted-secret");

    // Saving the form again with the same keys (as the admin page does for any change) doesn't call Plaid.
    const checks = fake.keyChecks.length;
    const same = await admin.json("PATCH", "/api/v1/admin/settings", {
      signup_mode: "single_user",
      plaid: { enabled: true, env: "sandbox", client_id: "cid-pasted" },
    });
    expect(same.status).toBe(200);
    expect(fake.keyChecks.length).toBe(checks);

    fake.rejectKeys = true;
    const bad = await admin.json("PATCH", "/api/v1/admin/settings", {
      dynamic_client_registration: false,
      plaid: { env: "production" },
    });
    fake.rejectKeys = false;
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("rejected these keys for Production");
    const after = await admin.json("GET", "/api/v1/admin/settings");
    expect(after.body).toMatchObject({ dynamic_client_registration: true, plaid: { env: "sandbox" } });
  });
});

describe(`bank feed sync status and sync_bank_feed (${DB_MODE})`, () => {
  let syncOrg: string;
  let item: FakeItem;
  let connId: string;
  let chk: string;
  let cashBox: string;
  let token: string;
  const sbase = () => `/api/v1/orgs/${syncOrg}`;

  async function mcpCall(tok: string, name: string, args: Record<string, unknown> = {}) {
    const res = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tok}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).result as {
      isError: boolean;
      structuredContent?: any;
      content: { text: string }[];
    };
  }
  const syncFeed = async (args: Record<string, unknown> = {}) => {
    const r = await mcpCall(token, "sync_bank_feed", args);
    expect(r.isError).toBe(false);
    return r.structuredContent.connections as any[];
  };
  const account = async (id: string) =>
    ((await owner.json("GET", `${sbase()}/bank-accounts`)).body.data as any[]).find((a) => a.id === id);
  const connection = async () => (await owner.json("GET", `${sbase()}/bank-connections/${connId}`)).body;
  const setPlaid = (patch: Record<string, unknown>) => env.ctx.settings.set("plaid", patch);
  const auditRows = async (action: string) => {
    const h = await env.ctx.orgs.mustOpen(syncOrg);
    return (
      await h.client.execute({
        sql: "select actor, after_json from audit_log where action = ? and target_id = ? order by seq",
        args: [action, connId],
      })
    ).rows;
  };

  test("setup: a connected checking account and a statement-only account", async () => {
    await setPlaid({
      enabled: true,
      env: "sandbox",
      client_id: "cid-instance",
      secret: "instance-secret-value",
      webhook_url: "",
      sync_cooldown_seconds: 0,
      refresh_enabled: false,
    });
    syncOrg = await createOrg(env, owner, "Sync Co");
    const n = fake.newItem([
      { account_id: "s-chk", name: "Sync Checking", mask: "4242", type: "depository", subtype: "checking" },
    ]);
    item = n.item;
    item.add({ transaction_id: "s1", account_id: "s-chk", amount: 12, name: "LUNCH" });
    const r = await owner.json("POST", `${sbase()}/plaid/exchange`, { public_token: n.publicToken });
    expect(r.status).toBe(201);
    connId = r.body.connection.id;
    expect(r.body.sync.transaction_ids).toHaveLength(1);
    chk = r.body.connection.accounts[0].id;
    expect(r.body.connection.accounts[0].provider_account_id).toBe("s-chk");
    cashBox = (await owner.json("POST", `${sbase()}/bank-accounts`, { name: "Cash box", kind: "checking" }))
      .body.id;
    const t = await owner.json("POST", "/api/v1/tokens", { org_id: syncOrg, name: "ai", role: "bookkeeper" });
    token = t.body.token;
  });

  test("an account with no bank feed has null sync fields", async () => {
    expect(await account(cashBox)).toMatchObject({
      last_synced_at: null,
      last_successful_sync_at: null,
      last_sync_status: null,
      last_sync_error: null,
      last_sync_added: null,
      connection_status: null,
      new_accounts_available: null,
    });
  });

  test("status: never synced, then a success with counts", async () => {
    const h = await env.ctx.orgs.mustOpen(syncOrg);
    await h.write((tx) =>
      tx
        .update(org.bankConnections)
        .set({ lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncAdded: null })
        .where(eq(org.bankConnections.id, connId)),
    );
    expect(await account(chk)).toMatchObject({
      last_synced_at: null,
      last_sync_status: "never",
      connection_status: "healthy",
    });

    item.add({ transaction_id: "s2", account_id: "s-chk", amount: 3, name: "SNACK" });
    item.add({ transaction_id: "s3", account_id: "s-chk", amount: 4, name: "TEA" });
    expect((await owner.json("POST", `${sbase()}/bank-connections/${connId}/sync`, {})).status).toBe(200);
    for (const v of [await account(chk), await connection()]) {
      expect(v).toMatchObject({
        last_sync_status: "success",
        last_sync_error: null,
        last_sync_added: 2,
        last_sync_modified: 0,
        last_sync_removed: 0,
        connection_status: "healthy",
        new_accounts_available: false,
      });
      expect(v.last_synced_at).toBeString();
      expect(v.last_synced_at).toBe(v.last_successful_sync_at);
    }
    const dash = (await owner.json("GET", `${sbase()}/dashboard`)).body;
    expect(dash.cash.accounts.find((a: any) => a.id === chk)).toMatchObject({ last_sync_status: "success" });
  });

  test("status: a Plaid error keeps the last success and reports the error", async () => {
    const before = await connection();
    fake.failSync = new PlaidError("INTERNAL_SERVER_ERROR", "API_ERROR", "Plaid had a problem", 500);
    expect((await owner.json("POST", `${sbase()}/bank-connections/${connId}/sync`, {})).status).toBe(502);
    fake.failSync = null;
    for (const v of [await account(chk), await connection()]) {
      expect(v).toMatchObject({
        last_sync_status: "error",
        last_sync_error: "INTERNAL_SERVER_ERROR: Plaid had a problem",
        last_successful_sync_at: before.last_successful_sync_at,
        last_sync_added: 2,
        connection_status: "error",
      });
      expect(v.last_synced_at > v.last_successful_sync_at).toBe(true);
    }
  });

  test("status: needs_reauth", async () => {
    fake.failSync = new PlaidError(
      "ITEM_LOGIN_REQUIRED",
      "ITEM_ERROR",
      "the login details have changed",
      400,
    );
    expect((await owner.json("POST", `${sbase()}/bank-connections/${connId}/sync`, {})).status).toBe(502);
    fake.failSync = null;
    expect(await account(chk)).toMatchObject({
      connection_status: "needs_reauth",
      last_sync_status: "error",
      last_sync_error: "ITEM_LOGIN_REQUIRED: the login details have changed",
    });
    const re = await owner.json("POST", `${sbase()}/bank-connections/${connId}/reconnected`, {});
    expect(re.body.connection).toMatchObject({
      connection_status: "healthy",
      last_sync_status: "success",
      last_sync_error: null,
    });
  });

  test("status: in_progress while a sync runs; sync_bank_feed doesn't wait or start another", async () => {
    let release!: () => void;
    fake.gate = new Promise((r) => {
      release = r;
    });
    const calls = fake.syncCalls;
    const running = syncConnection(env.ctx, syncOrg, connId);
    while (fake.syncCalls === calls) await Bun.sleep(1);
    expect((await account(chk)).last_sync_status).toBe("in_progress");
    expect((await connection()).last_sync_status).toBe("in_progress");
    const [r] = await syncFeed({ connection_id: connId });
    expect(r).toMatchObject({ status: "in_progress", last_sync_status: "in_progress" });
    expect(fake.syncCalls).toBe(calls + 1);
    fake.gate = null;
    release();
    await running;
    expect((await account(chk)).last_sync_status).toBe("success");
  });

  test("sync_bank_feed: new rows come back with their rule suggestion, audited as mcp", async () => {
    const expense = ((await owner.json("GET", `${sbase()}/accounts`)).body.data as any[]).find(
      (a) => a.type === "expense",
    );
    const rule = await owner.json("POST", `${sbase()}/rules`, {
      name: "Coffee",
      conditions: { description_contains: "coffee" },
      actions: { account_id: expense.id },
    });
    expect(rule.status).toBe(201);
    item.add({ transaction_id: "s4", account_id: "s-chk", amount: 4.5, name: "COFFEE SHOP" });
    const audits = (await auditRows("bank_connection.sync")).length;
    const [r] = await syncFeed({ bank_account_id: chk });
    expect(r).toMatchObject({
      connection_id: connId,
      institution_name: "First Platypus Bank",
      bank_accounts: [{ id: chk, name: "Sync Checking", mask: "4242" }],
      status: "synced",
      added: 1,
      refresh: null,
      last_sync_status: "success",
      last_sync_added: 1,
      connection_status: "healthy",
    });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      bank_account_id: chk,
      description: "COFFEE SHOP",
      amount: -450,
      is_pending: false,
      suggestion: { source: "rule", rule_id: rule.body.rule.id },
    });
    const rows = await auditRows("bank_connection.sync");
    expect(rows.length).toBe(audits + 1);
    expect(rows.at(-1)!.actor).toBe("mcp");
  });

  test("sync_bank_feed: nothing new is still a sync, and still audited", async () => {
    const audits = (await auditRows("bank_connection.sync")).length;
    const [r] = await syncFeed();
    expect(r).toMatchObject({ connection_id: connId, status: "synced", added: 0, transactions: [] });
    expect(r.message).toContain("nothing new");
    expect((await auditRows("bank_connection.sync")).length).toBe(audits + 1);
  });

  test("sync_bank_feed: a Plaid error", async () => {
    fake.failSync = new PlaidError("INTERNAL_SERVER_ERROR", "API_ERROR", "Plaid had a problem", 500);
    const [r] = await syncFeed({ connection_id: connId });
    fake.failSync = null;
    expect(r).toMatchObject({
      status: "error",
      last_sync_status: "error",
      connection_status: "error",
      last_sync_error: "INTERNAL_SERVER_ERROR: Plaid had a problem",
      transactions: [],
    });
    const failed = await auditRows("bank_connection.sync_failed");
    expect(failed.at(-1)).toMatchObject({ actor: "mcp" });
    expect(JSON.parse(String(failed.at(-1)!.after_json))).toMatchObject({
      error_code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("sync_bank_feed: needs_reauth can't be fixed by the assistant and shows in listings", async () => {
    fake.failSync = new PlaidError(
      "ITEM_LOGIN_REQUIRED",
      "ITEM_ERROR",
      "the login details have changed",
      400,
    );
    const [first] = await syncFeed({ connection_id: connId });
    expect(first).toMatchObject({ status: "needs_reauth", connection_status: "needs_reauth" });
    expect(first.message).toContain("You can't do this");
    const calls = fake.syncCalls;
    const [again] = await syncFeed();
    expect(again).toMatchObject({ status: "needs_reauth" });
    expect(fake.syncCalls).toBe(calls);
    const list = await mcpCall(token, "list_uncategorized_transactions");
    expect(list.structuredContent.bank_accounts.find((a: any) => a.id === chk)).toMatchObject({
      connection_status: "needs_reauth",
      last_sync_status: "error",
    });
    expect(
      list.structuredContent.bank_accounts.find((a: any) => a.id === cashBox).connection_status,
    ).toBeNull();
    fake.failSync = null;
    expect((await owner.json("POST", `${sbase()}/bank-connections/${connId}/reconnected`, {})).status).toBe(
      200,
    );
  });

  test("sync_bank_feed: cooldown answers without calling Plaid", async () => {
    await setPlaid({ sync_cooldown_seconds: 300 });
    const calls = fake.syncCalls;
    const [r] = await syncFeed({ connection_id: connId });
    await setPlaid({ sync_cooldown_seconds: 0 });
    expect(r).toMatchObject({ status: "cooldown", added: null, transactions: [] });
    expect(r.retry_after_seconds).toBeGreaterThan(0);
    expect(r.retry_after_seconds).toBeLessThanOrEqual(300);
    expect(fake.syncCalls).toBe(calls);
  });

  test("sync_bank_feed: force_refresh only when the instance allows it", async () => {
    let [r] = await syncFeed({ force_refresh: true });
    expect(r).toMatchObject({ status: "synced", refresh: "not_enabled" });
    expect(fake.refreshCalls).toBe(0);

    await setPlaid({ refresh_enabled: true });
    [r] = await syncFeed({ force_refresh: true });
    expect(r).toMatchObject({ status: "synced", refresh: "requested" });
    expect(r.message).toContain("asynchronously");
    expect(fake.refreshCalls).toBe(1);

    fake.failRefresh = new PlaidError("PRODUCT_NOT_READY", "ITEM_ERROR", "not ready", 400);
    [r] = await syncFeed({ force_refresh: true });
    fake.failRefresh = null;
    expect(r).toMatchObject({ status: "synced", refresh: "failed", refresh_error: "PRODUCT_NOT_READY" });
    await setPlaid({ refresh_enabled: false });
  });

  test("sync_bank_feed: viewers are refused; propose-only tokens may sync; bad targets are explained", async () => {
    const viewer = await owner.json("POST", "/api/v1/tokens", { org_id: syncOrg, name: "v", role: "viewer" });
    const denied = await mcpCall(viewer.body.token, "sync_bank_feed");
    expect(denied.isError).toBe(true);

    const po = await owner.json("POST", "/api/v1/tokens", {
      org_id: syncOrg,
      name: "po",
      role: "bookkeeper",
      propose_only: true,
    });
    const ok = await mcpCall(po.body.token, "sync_bank_feed", { connection_id: connId });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent.connections[0].status).toBe("synced");

    const none = await mcpCall(token, "sync_bank_feed", { bank_account_id: cashBox });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("import a statement");
  });

  test("#12: NEW_ACCOUNTS_AVAILABLE flags the connection and leaves it active", async () => {
    clearWebhookKeys();
    const body = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "NEW_ACCOUNTS_AVAILABLE",
      item_id: item.itemId,
    });
    const res = await handleWebhook(env.ctx, syncOrg, body, await sign(body));
    expect(res.action).toBe("status");
    expect(await connection()).toMatchObject({ status: "active", new_accounts_available: true });
    expect((await account(chk)).new_accounts_available).toBe(true);
  });

  test("#12: a link token with account_selection asks Plaid for account selection in update mode", async () => {
    const r = await owner.json("POST", `${sbase()}/plaid/link-token`, {
      connection_id: connId,
      account_selection: true,
    });
    expect(r.body.update_mode).toBe(true);
    expect(fake.linkRequests.at(-1)).toMatchObject({ accessToken: item.accessToken, accountSelection: true });
    await owner.json("POST", `${sbase()}/plaid/link-token`, { account_selection: true });
    expect(fake.linkRequests.at(-1)!.accountSelection).toBe(false);
  });

  test("#12: owners list unlinked accounts and add the ones they pick", async () => {
    (item.accounts as PlaidAccount[]).push(
      { account_id: "s-sav", name: "Sync Savings", mask: "5151", type: "depository", subtype: "savings" },
      { account_id: "s-cc", name: "Sync Card", mask: "6161", type: "credit", subtype: "credit card" },
    );
    item.add({ transaction_id: "s5", account_id: "s-sav", amount: -1.25, name: "INTEREST" });

    const bk = await login(env, "sync-bk@example.com");
    await addMember(env, syncOrg, bk.userId, "bookkeeper");
    expect((await bk.json("GET", `${sbase()}/bank-connections/${connId}/available-accounts`)).status).toBe(
      403,
    );
    expect(
      (await bk.json("POST", `${sbase()}/bank-connections/${connId}/accounts`, { accounts: [] })).status,
    ).toBe(403);

    const avail = await owner.json("GET", `${sbase()}/bank-connections/${connId}/available-accounts`);
    expect(avail.status).toBe(200);
    expect(avail.body.data.map((a: any) => a.account_id)).toEqual(["s-sav", "s-cc"]);
    expect(avail.body.data[0]).toMatchObject({ name: "Sync Savings", mask: "5151", type: "depository" });

    // Only the savings account is picked; the card is skipped, and the already-linked checking is ignored.
    const r = await owner.json("POST", `${sbase()}/bank-connections/${connId}/accounts`, {
      accounts: [
        { account_id: "s-sav", action: "new" },
        { account_id: "s-chk", action: "new" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.connection.new_accounts_available).toBe(false);
    expect(r.body.connection.accounts.map((a: any) => a.provider_account_id).sort()).toEqual([
      "s-chk",
      "s-sav",
    ]);
    expect(r.body.sync.added).toBe(1);
    const sav = r.body.connection.accounts.find((a: any) => a.provider_account_id === "s-sav").id;
    expect(
      (
        await owner.json("GET", `${sbase()}/bank-transactions?bank_account_id=${sav}&status=all`)
      ).body.data.map((t: any) => t.description),
    ).toEqual(["INTEREST"]);
    expect(
      (await owner.json("GET", `${sbase()}/bank-connections/${connId}/available-accounts`)).body.data.map(
        (a: any) => a.account_id,
      ),
    ).toEqual(["s-cc"]);
  });

  test("#12: an empty pick clears the flag", async () => {
    const h = await env.ctx.orgs.mustOpen(syncOrg);
    await h.write((tx) =>
      tx
        .update(org.bankConnections)
        .set({ newAccountsAvailable: true })
        .where(eq(org.bankConnections.id, connId)),
    );
    const r = await owner.json("POST", `${sbase()}/bank-connections/${connId}/accounts`, { accounts: [] });
    expect(r.status).toBe(200);
    expect(r.body.connection.new_accounts_available).toBe(false);
    expect((await auditRows("bank_connection.add_accounts")).length).toBe(2);
  });
});
