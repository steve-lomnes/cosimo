/**
 * OAuth 2.1 (SPEC §10.4) and MCP (SPEC §10.2). OAuth: dynamic registration, PKCE code flow,
 * refresh rotation, revocation, role capping, org scoping, redirect validation. MCP: writes land in
 * the review queue and don't affect reports, an MCP client cannot approve, notes and resources,
 * contacts, corrections (reversal, replacement, payment date change), recurring templates through
 * review, invoice payments, and an assistant withdrawing its own proposal of every type.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { newId, org } from "@cosimo/db";
import { MONEY_NOTE } from "../src/services/mcp-tools.ts";
import {
  addMember,
  anon,
  type Client,
  createOrg,
  createTestEnv,
  login,
  type TestEnv,
  tokenClient,
} from "./harness.ts";

let env: TestEnv;
let owner: Client;
let viewer: Client;
let admin: Client;
let orgId: string;
let otherOrg: string;
const REDIRECT = "https://client.example.com/callback";

const b64url = (b: Buffer) => b.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof URLSearchParams) {
    (init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
    init.body = body.toString();
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await env.app.request(path, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json, text };
}

async function register(name = "Test AI", uris = [REDIRECT]) {
  const r = await raw("POST", "/oauth/register", { client_name: name, redirect_uris: uris });
  expect(r.status).toBe(201);
  return r.body.client_id as string;
}

/** Full authorization-code flow as `user` for one org (also the default), returning tokens. */
async function authorize(user: Client, clientId: string, org = orgId, role = "bookkeeper") {
  return authorizeOrgs(user, clientId, [{ org_id: org, role }], org);
}

/** Full authorization-code flow covering several orgs, with `defaultOrg` picked as the default. */
async function authorizeOrgs(
  user: Client,
  clientId: string,
  orgs: { org_id: string; role: string }[],
  defaultOrg: string,
) {
  const { verifier, challenge } = pkce();
  const q = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${env.config.server.public_url}/mcp`,
  };
  const start = await raw("GET", `/oauth/authorize?${new URLSearchParams(q)}`);
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toStartWith("/connect?");
  const consent = await user.json("POST", "/api/v1/oauth/consent", {
    ...q,
    approve: true,
    orgs,
    default_org_id: defaultOrg,
  });
  expect(consent.status).toBe(200);
  const back = new URL(consent.body.redirect_to);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("xyz");
  const code = back.searchParams.get("code")!;
  const tok = await raw(
    "POST",
    "/oauth/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  );
  return { tok, code, verifier };
}

/** Consent body fields for one org that is also the default. */
const only = (org: string) => ({ orgs: [{ org_id: org }], default_org_id: org });

async function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  id: number | null = 1,
) {
  const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  return raw("POST", "/mcp", { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }, headers);
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return r.body.result as { isError: boolean; structuredContent?: any; content: { text: string }[] };
}

beforeAll(async () => {
  env = await createTestEnv();
  admin = await login(env, "admin@example.com", { admin: true });
  owner = await login(env, "owner@example.com");
  viewer = await login(env, "viewer@example.com");
  orgId = await createOrg(env, owner, "Acme LLC");
  otherOrg = await createOrg(env, owner, "Other Co");
  await addMember(env, orgId, viewer.userId, "viewer");
});
afterAll(() => env.close());

describe("OAuth 2.1", () => {
  test("metadata at the well-known paths", async () => {
    const pr = await raw("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(pr.body.resource).toBe(`${env.config.server.public_url}/mcp`);
    expect(pr.body.authorization_servers).toEqual([env.config.server.public_url]);
    const as = await raw("GET", "/.well-known/oauth-authorization-server");
    expect(as.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.body.registration_endpoint).toBe(`${env.config.server.public_url}/oauth/register`);
    expect(as.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  test("dynamic registration validates redirect URIs", async () => {
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["http://evil.example.com/cb"] })).status,
    ).toBe(400);
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["https://x.example.com/cb#frag"] })).status,
    ).toBe(400);
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["http://127.0.0.1:3000/cb"] })).status,
    ).toBe(201);
    expect(
      (
        await raw("POST", "/oauth/register", {
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "client_secret_basic",
        })
      ).status,
    ).toBe(201);
    const jwt = await raw("POST", "/oauth/register", {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "private_key_jwt",
    });
    expect(jwt.status).toBe(400);
    expect(jwt.body.error).toBe("invalid_client_metadata");
    const implicit = await raw("POST", "/oauth/register", {
      redirect_uris: [REDIRECT],
      response_types: ["token"],
    });
    expect(implicit.status).toBe(400);
    expect(implicit.body.error).toBe("invalid_client_metadata");
  });

  test("code flow with PKCE, refresh rotation, and revocation", async () => {
    const clientId = await register();
    const { tok, code, verifier } = await authorize(owner, clientId);
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "books" });
    expect(tok.body.access_token).toStartWith("cosimo_oat_");

    // The access token works against the org's API, as a propose-only bookkeeper.
    const api = tokenClient(env, tok.body.access_token);
    expect((await api.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(200);
    // …and only for the granted org.
    expect((await api.json("GET", `/api/v1/orgs/${otherOrg}/accounts`)).status).toBe(403);

    // Codes are single-use; replay also revokes what the code produced.
    const replay = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
    expect(replay.body.error).toBe("invalid_grant");
    expect((await api.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(401);

    // Fresh grant; rotate the refresh token.
    const g = (await authorize(owner, clientId)).tok.body;
    const r1 = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: g.refresh_token,
        client_id: clientId,
      }),
    );
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(g.refresh_token);
    const reuse = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: g.refresh_token,
        client_id: clientId,
      }),
    );
    expect(reuse.body.error).toBe("invalid_grant");
    // The old access token died with the rotation; the new one works.
    expect(
      (await tokenClient(env, g.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(401);
    expect(
      (await tokenClient(env, r1.body.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(200);

    // Revocation (RFC 7009).
    expect(
      (
        await raw(
          "POST",
          "/oauth/revoke",
          new URLSearchParams({ token: r1.body.refresh_token, client_id: clientId }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await tokenClient(env, r1.body.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(401);
  });

  test("dynamic registration with claude.ai's metadata registers a confidential client and completes the code flow", async () => {
    const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
    const reg = await raw("POST", "/oauth/register", {
      client_name: "Claude",
      redirect_uris: [CLAUDE],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(reg.status).toBe(201);
    expect(reg.body.client_secret).toStartWith("cosimo_ocs_");
    expect(reg.body.client_secret_expires_at).toBe(0);
    expect(reg.body.token_endpoint_auth_method).toBe("client_secret_post");
    const { client_id: clientId, client_secret: secret } = reg.body as {
      client_id: string;
      client_secret: string;
    };

    const { verifier, challenge } = pkce();
    const q = {
      client_id: clientId,
      redirect_uri: CLAUDE,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${env.config.server.public_url}/mcp`,
    };
    const start = await raw("GET", `/oauth/authorize?${new URLSearchParams(q)}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toStartWith("/connect?");
    const consent = await owner.json("POST", "/api/v1/oauth/consent", {
      ...q,
      approve: true,
      ...only(orgId),
    });
    expect(consent.status).toBe(200);
    const back = new URL(consent.body.redirect_to);
    expect(back.origin + back.pathname).toBe(CLAUDE);
    const form = {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: CLAUDE,
      client_id: clientId,
      code_verifier: verifier,
    };

    // The secret issued at registration is enforced at the token endpoint.
    const noSecret = await raw("POST", "/oauth/token", new URLSearchParams(form));
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe("invalid_client");
    const tok = await raw("POST", "/oauth/token", new URLSearchParams({ ...form, client_secret: secret }));
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toStartWith("cosimo_oat_");

    // Either secret method works for any confidential client: refresh with Basic auth.
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const refreshed = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token }),
      { authorization: `Basic ${basic}` },
    );
    expect(refreshed.status).toBe(200);

    const list = await admin.json("GET", "/api/v1/admin/oauth-clients");
    expect(list.status).toBe(200);
    expect(list.body.data.find((x: { client_id: string }) => x.client_id === clientId)).toMatchObject({
      client_name: "Claude",
      redirect_uris: [CLAUDE],
      registered_via: "dynamic",
      confidential: true,
    });
  });

  test("PKCE and redirect mismatches are rejected", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const base = {
      client_id: clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    // Mismatched redirect: an error page, never a redirect to the unverified URI.
    const bad = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://attacker.example/cb" })}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    // Missing PKCE: error back to the (verified) redirect URI.
    const noPkce = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: REDIRECT, state: "s" })}`,
    );
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    // Plain method is not allowed.
    const plain = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT, code_challenge_method: "plain" })}`,
    );
    expect(plain.headers.get("location")).toContain("error=invalid_request");
    // Wrong verifier.
    const { tok } = await authorize(owner, clientId).then(async (x) => x);
    expect(tok.status).toBe(200);
    const q = { ...base, redirect_uri: REDIRECT };
    const consent = await owner.json("POST", "/api/v1/oauth/consent", {
      ...q,
      approve: true,
      ...only(orgId),
    });
    const code = new URL(consent.body.redirect_to).searchParams.get("code")!;
    const wrong = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: pkce().verifier,
      }),
    );
    expect(wrong.body.error).toBe("invalid_grant");
    // Denying consent returns access_denied.
    const deny = await owner.json("POST", "/api/v1/oauth/consent", { ...q, approve: false });
    expect(deny.body.redirect_to).toContain("error=access_denied");
  });

  test("the granted role is capped at the user's own role", async () => {
    const clientId = await register();
    const info = await viewer.json(
      "GET",
      `/api/v1/oauth/consent?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`,
    );
    expect(info.body.orgs).toEqual([
      expect.objectContaining({ id: orgId, role: "viewer", grantable_roles: ["viewer"] }),
    ]);
    const { tok } = await authorize(viewer, clientId, orgId, "owner");
    const t = tok.body.access_token;
    const r = await call(t, "list_orgs", {});
    expect(r.structuredContent.orgs[0].role).toBe("viewer");
    const w = await call(t, "append_note", { note: "Viewer should not write" });
    expect(w.isError).toBe(true);
    // Consent for an org the user doesn't belong to fails.
    const q = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    };
    expect(
      (await viewer.json("POST", "/api/v1/oauth/consent", { ...q, approve: true, ...only(otherOrg) })).status,
    ).toBe(403);
  });

  test("connections are listed and revocable; owners see their org's clients", async () => {
    const clientId = await register("Connections AI");
    const { tok } = await authorize(viewer, clientId);
    const mine = await viewer.json("GET", "/api/v1/oauth/connections");
    const c = mine.body.data.find((x: any) => x.client_id === clientId);
    expect(c).toMatchObject({
      client_name: "Connections AI",
      default_org_id: orgId,
      orgs: [expect.objectContaining({ org_id: orgId, org_name: "Acme LLC", role: "viewer" })],
    });
    const orgView = await owner.json("GET", `/api/v1/orgs/${orgId}/oauth/connections`);
    expect(orgView.body.data.some((x: any) => x.id === c.id)).toBe(true);
    expect((await viewer.json("GET", `/api/v1/orgs/${orgId}/oauth/connections`)).status).toBe(403);
    // The org owner can disconnect someone else's client.
    expect((await owner.json("DELETE", `/api/v1/oauth/connections/${c.id}`)).status).toBe(200);
    expect((await mcp(tok.body.access_token, "ping")).status).toBe(401);
  });

  test("admins can turn off dynamic registration and register clients manually", async () => {
    await admin.json("PATCH", "/api/v1/admin/settings", { dynamic_client_registration: false });
    expect((await raw("POST", "/oauth/register", { redirect_uris: [REDIRECT] })).status).toBe(403);
    expect(
      (await raw("GET", "/.well-known/oauth-authorization-server")).body.registration_endpoint,
    ).toBeUndefined();
    const m = await admin.json("POST", "/api/v1/admin/oauth-clients", {
      client_name: "Manual",
      redirect_uris: [REDIRECT],
    });
    expect(m.status).toBe(201);
    expect(m.body.client_secret).toStartWith("cosimo_ocs_");
    expect(
      (
        await owner.json("POST", "/api/v1/admin/oauth-clients", {
          client_name: "x",
          redirect_uris: [REDIRECT],
        })
      ).status,
    ).toBe(403);
    await admin.json("PATCH", "/api/v1/admin/settings", { dynamic_client_registration: true });

    // A confidential client must authenticate at the token endpoint.
    const { verifier, challenge } = pkce();
    const q = {
      client_id: m.body.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const consent = await owner.json("POST", "/api/v1/oauth/consent", {
      ...q,
      approve: true,
      ...only(orgId),
    });
    const code = new URL(consent.body.redirect_to).searchParams.get("code")!;
    const form = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: m.body.client_id,
      code_verifier: verifier,
    };
    const noSecret = await raw("POST", "/oauth/token", new URLSearchParams(form));
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe("invalid_client");
    const basic = Buffer.from(`${m.body.client_id}:${m.body.client_secret}`).toString("base64");
    const ok = await raw("POST", "/oauth/token", new URLSearchParams(form), {
      authorization: `Basic ${basic}`,
    });
    expect(ok.status).toBe(200);
    // Revoking the client kills its tokens.
    await admin.json("DELETE", `/api/v1/admin/oauth-clients/${m.body.client_id}`);
    expect((await mcp(ok.body.access_token, "ping")).status).toBe(401);
  });
});

describe("MCP", () => {
  let token: string;

  beforeAll(async () => {
    token = (await authorize(owner, await register("Claude"))).tok.body.access_token;
  });

  test("unauthenticated requests get a discoverable 401", async () => {
    const r = await mcp(null, "initialize", { protocolVersion: "2025-06-18" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(
      `resource_metadata="${env.config.server.public_url}/.well-known/oauth-protected-resource/mcp"`,
    );
    // A browser session is not enough.
    const s = await env.app.request("/mcp", {
      method: "POST",
      headers: { cookie: owner.cookie!, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(s.status).toBe(401);
    // Foreign origins are refused.
    const o = await raw(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    );
    expect(o.status).toBe(403);
  });

  test("initialize, tools, and resources", async () => {
    const init = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.serverInfo.name).toBe("cosimo");
    expect((await mcp(token, "notifications/initialized", {}, null)).status).toBe(202);
    const tools = (await mcp(token, "tools/list")).body.result.tools as {
      name: string;
      description: string;
      inputSchema: any;
      annotations: { readOnlyHint: boolean };
    }[];
    const names = tools.map((t) => t.name);
    for (const n of [
      "list_orgs",
      "get_account_balances",
      "run_report",
      "list_uncategorized_transactions",
      "categorize_transaction",
      "create_rule",
      "search_transactions",
      "get_entry",
      "list_entries",
      "create_manual_entry",
      "list_invoices",
      "create_invoice_draft",
      "list_bills",
      "list_bill_payments",
      "list_invoice_payments",
      "record_invoice_payment",
      "record_bill_payment",
      "create_bill_draft",
      "get_cash_snapshot",
      "list_pending_reviews",
      "get_review_item",
      "append_note",
      "create_contact",
      "update_contact",
      "propose_reversal",
      "propose_replacement",
      "propose_payment_date_change",
      "withdraw_proposal",
      "list_recurring_templates",
      "propose_recurring_template",
      "sync_bank_feed",
      "list_receipts",
      "get_receipt",
      "create_receipt",
      "update_receipt",
      "match_receipt",
      "unmatch_receipt",
      "dismiss_receipt",
    ])
      expect(names).toContain(n);
    for (const forbidden of ["approve", "reject", "void", "reverse", "delete", "lock"])
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    const entryTool = tools.find((t) => t.name === "create_manual_entry")!;
    expect(entryTool.inputSchema.required).toContain("rationale");
    // Every amount is labeled as cents (#67): tools that carry money say so, and integer amount
    // inputs describe themselves as cents, however deeply nested.
    const moneyTools = tools.filter((t) => t.description.includes(MONEY_NOTE)).map((t) => t.name);
    for (const n of ["get_cash_snapshot", "list_invoices", "list_bills", "create_manual_entry"])
      expect(moneyTools).toContain(n);
    for (const n of ["list_orgs", "list_contacts", "append_note"]) expect(moneyTools).not.toContain(n);
    const unlabeled: string[] = [];
    const walk = (path: string, node: any) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
        const here = `${path}.${k}`;
        if (v.type === "integer" && /amount|price|balance|total|cents|_min|_max|_eq/.test(k))
          if (!/cents/.test(v.description ?? "")) unlabeled.push(here);
        walk(here, v);
      }
      if (node.items) walk(`${path}[]`, node.items);
    };
    for (const t of tools) walk(t.name, t.inputSchema);
    expect(unlabeled).toEqual([]);
    const billTool = tools.find((t) => t.name === "create_bill_draft")!;
    expect(billTool.annotations.readOnlyHint).toBe(false);

    const res = (await mcp(token, "resources/list")).body.result.resources.map((r: any) => r.uri);
    expect(res).toEqual(["org://profile", "org://notes"]);
    expect((await mcp(token, "nope")).body.error.code).toBe(-32601);
  });

  test("writes land in the review queue, don't affect reports, and can't be self-approved", async () => {
    const before = await owner.json("GET", `/api/v1/orgs/${orgId}/reports/trial_balance?as_of=2026-12-31`);
    const missing = await call(token, "create_manual_entry", {
      date: "2026-03-31",
      lines: [
        { account: "1000", amount: 5000 },
        { account: "3100", amount: -5000 },
      ],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("rationale");

    const r = await call(token, "create_manual_entry", {
      date: "2026-03-31",
      memo: "Owner contribution",
      lines: [
        { account: "1000", amount: 5000 },
        { account: "3100", amount: -5000 },
      ],
      rationale: "Deposit from the owner's personal account",
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.status).toBe("pending_review");
    const reviewId = r.structuredContent.review_item_id as string;

    const after = await owner.json("GET", `/api/v1/orgs/${orgId}/reports/trial_balance?as_of=2026-12-31`);
    expect(before.body.lines.length).toBeGreaterThan(0);
    expect(after.body.lines).toEqual(before.body.lines);

    const pending = await call(token, "list_pending_reviews", {});
    const item = pending.structuredContent.data.find((x: any) => x.id === reviewId);
    expect(item).toMatchObject({
      proposed_by_actor: "mcp",
      rationale: "Deposit from the owner's personal account",
    });

    // The same OAuth token can't approve through the REST API either.
    const self = await tokenClient(env, token).json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${reviewId}/approve`,
      {},
    );
    expect(self.status).toBe(403);

    // A person approves; the entry posts.
    expect((await owner.json("POST", `/api/v1/orgs/${orgId}/review/${reviewId}/approve`, {})).status).toBe(
      200,
    );
    const got = await call(token, "get_review_item", { review_item_id: reviewId });
    expect(got.structuredContent.status).toBe("approved");
    const entry = await call(token, "get_entry", { entry_id: r.structuredContent.entry_id });
    expect(entry.structuredContent.status).toBe("posted");
  });

  test("categorize a bank transaction and propose a rule", async () => {
    const ba = (
      await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts`, { name: "Checking", kind: "checking" })
    ).body;
    await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts/${ba.id}/import`, {
      filename: "m.csv",
      content: "Date,Description,Amount\n2026-04-02,ADOBE CREATIVE CLOUD,-54.99\n",
    });
    // A transaction still pending at the bank is left out, and reported separately as `pending`.
    const h = await env.ctx.orgs.mustOpen(orgId);
    const pendingId = newId();
    await h.write((tx) =>
      tx.insert(org.bankTransactions).values({
        id: pendingId,
        bankAccountId: ba.id,
        date: "2026-04-03",
        amount: -1200,
        description: "PENDING CHARGE",
        normalizedDescription: "PENDING CHARGE",
        isPending: true,
        dedupeHash: `pending-${pendingId}`,
      }),
    );
    const list = await call(token, "list_uncategorized_transactions", {});
    expect(list.structuredContent.data).toHaveLength(1);
    const txn = list.structuredContent.data[0];
    expect(txn.description).toContain("ADOBE");
    expect(list.structuredContent.pending).toEqual({ count: 1, total: -1200 });
    const expense = (await call(token, "get_account_balances", {})).structuredContent.accounts.find(
      (a: any) => a.type === "expense" && a.subtype !== "uncategorized",
    );
    const cat = await call(token, "categorize_transaction", {
      transaction_id: txn.id,
      splits: [{ account: expense.code }],
      rationale: "Software subscription",
    });
    expect(cat.structuredContent.status).toBe("pending_review");
    const rule = await call(token, "create_rule", {
      name: "Adobe",
      conditions: { description_contains: "ADOBE" },
      actions: { account: expense.code },
      rationale: "Adobe is always software",
    });
    expect(rule.structuredContent.status).toBe("pending_review");
  });

  test("invoice drafts go to review; approval finalizes, rejection deletes", async () => {
    const cust = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "customer",
      name: "Globex",
    });
    const draft = async () =>
      call(token, "create_invoice_draft", {
        customer_id: cust.body.id,
        issue_date: "2026-05-01",
        lines: [{ description: "Consulting", quantity: 10, unit_price: 15000, account: "4000" }],
        rationale: "April consulting hours from the timesheet",
      });
    const a = await draft();
    expect(a.structuredContent).toMatchObject({ status: "pending_review", total: 150000 });
    const inv = await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${a.structuredContent.invoice_id}`);
    expect(inv.body.status).toBe("draft");
    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${a.structuredContent.review_item_id}/approve`,
      {},
    );
    const done = await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${a.structuredContent.invoice_id}`);
    expect(done.body.status).toBe("sent");

    // Terms: a due date alone derives them; a conflicting pair is refused (#66).
    const withDue = await call(token, "create_invoice_draft", {
      customer_id: cust.body.id,
      issue_date: "2026-05-01",
      due_date: "2026-05-06",
      lines: [{ description: "Rush job", quantity: 1, unit_price: 1000, account: "4000" }],
      rationale: "Due in five days",
    });
    expect(withDue.structuredContent).toMatchObject({ terms: "On due date", due_date: "2026-05-06" });
    const withTerms = await call(token, "create_invoice_draft", {
      customer_id: cust.body.id,
      issue_date: "2026-05-01",
      terms: "Net 15",
      lines: [{ description: "Job", quantity: 1, unit_price: 1000, account: "4000" }],
      rationale: "Net 15 client",
    });
    expect(withTerms.structuredContent).toMatchObject({ terms: "Net 15", due_date: "2026-05-16" });
    const clash = await call(token, "create_invoice_draft", {
      customer_id: cust.body.id,
      issue_date: "2026-05-01",
      terms: "Net 30",
      due_date: "2026-05-06",
      lines: [{ description: "Job", quantity: 1, unit_price: 1000, account: "4000" }],
      rationale: "Conflicting",
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0]!.text).toContain("2026-05-31");

    const b = await draft();
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${b.structuredContent.review_item_id}/reject`, {
      note: "no",
    });
    expect(
      (await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${b.structuredContent.invoice_id}`)).status,
    ).toBe(404);

    // A review policy that auto-approves the draft finalizes the invoice right away (#31).
    const pol = await owner.json("POST", `/api/v1/orgs/${orgId}/review-policies`, {
      name: "Small MCP invoices",
      actor: "mcp",
      condition: { amount_lt: 1000, item_types: ["invoice_draft"] },
      action: "auto_approve",
    });
    expect(pol.status).toBe(201);
    const auto = await call(token, "create_invoice_draft", {
      customer_id: cust.body.id,
      issue_date: "2026-05-02",
      lines: [{ description: "Small fix", quantity: 1, unit_price: 500, account: "4000" }],
      rationale: "Small follow-up job",
    });
    expect(auto.structuredContent.review_item_id).toBeNull();
    expect(auto.structuredContent.status).not.toBe("draft");
    expect(auto.structuredContent.status).not.toBe("pending_review");
    expect(auto.structuredContent.entry_id).toBeTruthy();
    const posted = await owner.json(
      "GET",
      `/api/v1/orgs/${orgId}/invoices/${auto.structuredContent.invoice_id}`,
    );
    expect(posted.body.status).toBe("sent");
    expect(posted.body.sent_at ?? null).toBeNull();
    await owner.json("DELETE", `/api/v1/orgs/${orgId}/review-policies/${pol.body.id}`);
  });

  test("bill drafts go to review; approval posts, rejection deletes; a customer-only contact is refused", async () => {
    const vendor = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "vendor",
      name: "Acme Supplies",
    });
    const expense = (await call(token, "get_account_balances", {})).structuredContent.accounts.find(
      (a: any) => a.type === "expense" && a.subtype !== "uncategorized",
    );
    const draft = async () =>
      call(token, "create_bill_draft", {
        vendor_id: vendor.body.id,
        issue_date: "2026-05-01",
        lines: [{ description: "Office supplies", amount: 4200, account: expense.code }],
        rationale: "Vendor invoice for office supplies",
      });
    const a = await draft();
    expect(a.structuredContent).toMatchObject({ status: "pending_review", total: 4200 });
    const bill = await owner.json("GET", `/api/v1/orgs/${orgId}/bills/${a.structuredContent.bill_id}`);
    expect(bill.body.status).toBe("draft");
    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${a.structuredContent.review_item_id}/approve`,
      {},
    );
    const done = await owner.json("GET", `/api/v1/orgs/${orgId}/bills/${a.structuredContent.bill_id}`);
    expect(done.body.status).toBe("open");

    const b = await draft();
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${b.structuredContent.review_item_id}/reject`, {
      note: "no",
    });
    expect(
      (await owner.json("GET", `/api/v1/orgs/${orgId}/bills/${b.structuredContent.bill_id}`)).status,
    ).toBe(404);

    const custOnly = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "customer",
      name: "Customer Only",
    });
    const refused = await call(token, "create_bill_draft", {
      vendor_id: custOnly.body.id,
      issue_date: "2026-05-01",
      lines: [{ description: "Office supplies", amount: 100, account: expense.code }],
      rationale: "Should be refused",
    });
    expect(refused.isError).toBe(true);

    // A review policy that auto-approves the draft posts the bill right away.
    const pol = await owner.json("POST", `/api/v1/orgs/${orgId}/review-policies`, {
      name: "Small MCP bills",
      actor: "mcp",
      condition: { amount_lt: 1000, item_types: ["bill_draft"] },
      action: "auto_approve",
    });
    expect(pol.status).toBe(201);
    const auto = await call(token, "create_bill_draft", {
      vendor_id: vendor.body.id,
      issue_date: "2026-05-01",
      lines: [{ description: "Stamps", amount: 500, account: expense.code }],
      rationale: "Small vendor bill",
    });
    expect(auto.structuredContent).toMatchObject({ status: "open", review_item_id: null });
    expect(auto.structuredContent.entry_id).toBeTruthy();
    const posted = await owner.json("GET", `/api/v1/orgs/${orgId}/bills/${auto.structuredContent.bill_id}`);
    expect(posted.body.status).toBe("open");
    await owner.json("DELETE", `/api/v1/orgs/${orgId}/review-policies/${pol.body.id}`);
  });

  test("list_bills, has_attachment, and list_bill_payments", async () => {
    const vendor = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "vendor",
      name: "Overdue Vendor",
    });
    const accounts = (await call(token, "get_account_balances", {})).structuredContent.accounts;
    const expense = accounts.find((a: any) => a.type === "expense" && a.subtype !== "uncategorized");
    const cash = accounts.find((a: any) => a.code === "1000");
    const bill = await owner.json("POST", `/api/v1/orgs/${orgId}/bills`, {
      vendor_id: vendor.body.id,
      issue_date: "2020-01-01",
      due_date: "2020-01-31",
      lines: [{ description: "Old bill", amount: 900, account_id: expense.id }],
    });
    expect(bill.status).toBe(201);
    const billId = bill.body.bill.id as string;

    const h = await env.ctx.orgs.mustOpen(orgId);
    const attachmentId = newId();
    await h.write(async (tx) => {
      await tx.insert(org.attachments).values({
        id: attachmentId,
        storageKey: "x",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        sha256: "0".repeat(64),
      });
      await tx.insert(org.attachmentLinks).values({ attachmentId, targetType: "bill", targetId: billId });
    });

    const list = await call(token, "list_bills", { vendor_id: vendor.body.id, overdue: true });
    const listed = list.structuredContent.bills.find((b: any) => b.id === billId);
    expect(listed).toMatchObject({ overdue: true, has_attachment: true });
    expect(listed.lines[0]).toMatchObject({ account_id: expense.id, account_code: expense.code });

    const notOverdue = await call(token, "list_bills", { vendor_id: vendor.body.id, overdue: false });
    expect(notOverdue.structuredContent.bills.some((b: any) => b.id === billId)).toBe(false);

    const pay = await owner.json("POST", `/api/v1/orgs/${orgId}/payments`, {
      direction: "sent",
      contact_id: vendor.body.id,
      date: "2020-02-01",
      amount: 900,
      account_id: cash.id,
      applications: [{ document_id: billId, amount: 900 }],
    });
    expect(pay.status).toBe(201);
    const payments = await call(token, "list_bill_payments", { vendor_id: vendor.body.id });
    expect(payments.structuredContent.payments.some((p: any) => p.contact_id === vendor.body.id)).toBe(true);
  });

  test("get_cash_snapshot returns a dashboard", async () => {
    const snap = await call(token, "get_cash_snapshot", {});
    expect(snap.structuredContent).toMatchObject({
      as_of: expect.any(String),
      cash: { total: expect.any(Number) },
      bills: { overdue: { count: expect.any(Number) }, due_soon: { count: expect.any(Number) } },
    });
  });

  test("get_entry and list_entries carry account/contact names, including an archived contact", async () => {
    const contact = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "customer",
      name: "Formerly Active Co",
    });
    await owner.json("PATCH", `/api/v1/orgs/${orgId}/contacts/${contact.body.id}`, { archived: true });
    const r = await call(token, "create_manual_entry", {
      date: "2026-08-01",
      memo: "Enrichment check",
      lines: [
        { account: "1000", amount: 700, contact_id: contact.body.id },
        { account: "3100", amount: -700 },
      ],
      rationale: "Testing name enrichment",
    });
    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${r.structuredContent.review_item_id}/approve`,
      {},
    );
    const entryId = r.structuredContent.entry_id as string;

    const got = await call(token, "get_entry", { entry_id: entryId });
    const line = got.structuredContent.lines.find((l: any) => l.contact_id === contact.body.id);
    expect(line).toMatchObject({ account_code: "1000", contact_name: "Formerly Active Co" });
    expect(got.structuredContent.has_attachment).toBe(false);

    const list = await call(token, "list_entries", { from: "2026-08-01", to: "2026-08-01" });
    const listed = list.structuredContent.data.find((e: any) => e.id === entryId);
    const listedLine = listed.lines.find((l: any) => l.contact_id === contact.body.id);
    expect(listedLine.contact_name).toBe("Formerly Active Co");
  });

  test("list_contacts with include_archived", async () => {
    const contact = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "vendor",
      name: "Archived Vendor Co",
    });
    await owner.json("PATCH", `/api/v1/orgs/${orgId}/contacts/${contact.body.id}`, { archived: true });
    const hidden = await call(token, "list_contacts", { query: "Archived Vendor" });
    expect(hidden.structuredContent.contacts.some((c: any) => c.id === contact.body.id)).toBe(false);
    const shown = await call(token, "list_contacts", {
      query: "Archived Vendor",
      include_archived: true,
    });
    expect(shown.structuredContent.contacts.some((c: any) => c.id === contact.body.id)).toBe(true);
  });

  test("create_contact and update_contact apply directly, with an audit row", async () => {
    const made = await call(token, "create_contact", { kind: "vendor", name: "New Paper Co" });
    expect(made.isError).toBe(false);
    const vendorId = made.structuredContent.contact.id as string;
    expect(made.structuredContent.contact).toMatchObject({ kind: "vendor", name: "New Paper Co" });
    expect(made.structuredContent.review_item_id).toBeUndefined();

    // The new vendor is usable right away.
    const expense = (await call(token, "get_account_balances", {})).structuredContent.accounts.find(
      (a: any) => a.type === "expense" && a.subtype !== "uncategorized",
    );
    const bill = await call(token, "create_bill_draft", {
      vendor_id: vendorId,
      issue_date: "2026-05-03",
      lines: [{ description: "Paper", amount: 1500, account: expense.code }],
      rationale: "Paper invoice",
    });
    expect(bill.isError).toBe(false);

    const upd = await call(token, "update_contact", {
      contact_id: vendorId,
      email: "billing@newpaper.example",
      default_account: expense.code,
    });
    expect(upd.structuredContent.contact).toMatchObject({
      email: "billing@newpaper.example",
      default_account_id: expense.id,
    });
    await call(token, "update_contact", { contact_id: vendorId, archived: true });
    const hidden = await call(token, "list_contacts", { query: "New Paper" });
    expect(hidden.structuredContent.contacts.some((c: any) => c.id === vendorId)).toBe(false);
    const shown = await call(token, "list_contacts", { query: "New Paper", include_archived: true });
    expect(shown.structuredContent.contacts.some((c: any) => c.id === vendorId)).toBe(true);

    const audit = (await owner.json("GET", `/api/v1/orgs/${orgId}/audit?limit=50&target_id=${vendorId}`)).body
      .data;
    expect(audit.some((x: any) => x.action === "contact.create" && x.actor === "mcp")).toBe(true);
    expect(audit.some((x: any) => x.action === "contact.update" && x.actor === "mcp")).toBe(true);

    // A customer's default terms round-trip through MCP (#66).
    const cust = await call(token, "create_contact", {
      kind: "customer",
      name: "Terms Customer",
      default_terms: "Net 15",
    });
    expect(cust.structuredContent.contact.default_terms).toBe("Net 15");
    const cleared = await call(token, "update_contact", {
      contact_id: cust.structuredContent.contact.id,
      default_terms: null,
    });
    expect(cleared.structuredContent.contact.default_terms).toBeNull();

    // A read-only connection can't add contacts.
    const ro = (await authorize(viewer, await register("Viewer AI"))).tok.body.access_token;
    const refused = await call(ro, "create_contact", { kind: "vendor", name: "Nope" });
    expect(refused.isError).toBe(true);
  });

  /** Two expense accounts and a posted entry moving `amount` from cash to the first one. */
  async function postedExpense(date: string, amount: number) {
    const accounts = (await call(token, "get_account_balances", {})).structuredContent.accounts;
    const [a, b] = accounts.filter((x: any) => x.type === "expense" && x.subtype !== "uncategorized");
    const cash = accounts.find((x: any) => x.code === "1000");
    const e = await owner.json("POST", `/api/v1/orgs/${orgId}/entries`, {
      date,
      memo: "Booked to the wrong account",
      lines: [
        { account_id: a.id, amount },
        { account_id: cash.id, amount: -amount },
      ],
    });
    expect(e.body.status).toBe("posted");
    return { entryId: e.body.entry.id as string, a, b, cash };
  }
  const pnl = async (year: string) =>
    (
      await owner.json(
        "GET",
        `/api/v1/orgs/${orgId}/reports/profit_and_loss?from=${year}-01-01&to=${year}-12-31`,
      )
    ).body.lines;
  const balance = async (id: string) =>
    (await call(token, "get_account_balances", {})).structuredContent.accounts.find((x: any) => x.id === id)
      .balance ?? 0;

  test("propose_reversal goes to review; duplicates and document entries are refused", async () => {
    const { entryId } = await postedExpense("2024-03-10", 1234);
    const before = await pnl("2024");
    const r = await call(token, "propose_reversal", {
      entry_id: entryId,
      rationale: "Duplicate of the card charge",
    });
    expect(r.structuredContent.status).toBe("pending_review");
    const reviewId = r.structuredContent.review_item_id as string;
    const pending = await call(token, "list_pending_reviews", { limit: 200 });
    expect(pending.structuredContent.data.some((x: any) => x.id === reviewId)).toBe(true);
    expect(await pnl("2024")).toEqual(before);

    const again = await call(token, "propose_reversal", { entry_id: entryId, rationale: "Once more" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("already_reversed");

    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${reviewId}/approve`, {});
    const orig = await call(token, "get_entry", { entry_id: entryId });
    expect(orig.structuredContent.reversed_by_entry_id).toBe(r.structuredContent.entry_id);

    // An entry created by a document is refused.
    const bills = await call(token, "list_bills", { status: ["open"] });
    const billEntry = bills.structuredContent.bills.find((b: any) => b.entry_id)?.entry_id;
    expect(billEntry).toBeTruthy();
    const doc = await call(token, "propose_reversal", { entry_id: billEntry, rationale: "Wrong bill" });
    expect(doc.isError).toBe(true);
    expect(doc.content[0]!.text).toContain("document_entry");
  });

  test("propose_replacement is one review item: reject posts nothing, approve posts both", async () => {
    const { entryId, a, b, cash } = await postedExpense("2023-04-10", 2500);
    const propose = () =>
      call(token, "propose_replacement", {
        entry_id: entryId,
        date: "2023-04-10",
        memo: "Booked to the right account",
        lines: [
          { account: b.code, amount: 2500 },
          { account: cash.code, amount: -2500 },
        ],
        rationale: "This was software, not supplies",
      });
    const before = await pnl("2023");
    const [aBefore, bBefore] = [await balance(a.id), await balance(b.id)];

    const first = await propose();
    expect(first.structuredContent.status).toBe("pending_review");
    expect(await pnl("2023")).toEqual(before);
    const dup = await propose();
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain("already_pending");
    // A plain reversal can't slip in while the replacement waits.
    const rev = await call(token, "propose_reversal", { entry_id: entryId, rationale: "Cancel it" });
    expect(rev.isError).toBe(true);

    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${first.structuredContent.review_item_id}/reject`,
      {
        note: "no",
      },
    );
    expect(await pnl("2023")).toEqual(before);
    expect(
      (await call(token, "get_entry", { entry_id: entryId })).structuredContent.reversed_by_entry_id,
    ).toBeNull();

    const second = await propose();
    const item = await call(token, "get_review_item", {
      review_item_id: second.structuredContent.review_item_id,
    });
    expect(item.structuredContent).toMatchObject({ item_type: "entry_replacement", item_id: entryId });
    const ok = await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${second.structuredContent.review_item_id}/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    expect(
      (await call(token, "get_entry", { entry_id: entryId })).structuredContent.reversed_by_entry_id,
    ).toBeTruthy();
    expect(await balance(a.id)).toBe(aBefore - 2500);
    expect(await balance(b.id)).toBe(bBefore + 2500);
    expect(await pnl("2023")).not.toEqual(before);

    // Auto-approved by a policy: both halves post at once.
    const other = await postedExpense("2023-05-10", 300);
    const pol = await owner.json("POST", `/api/v1/orgs/${orgId}/review-policies`, {
      name: "Small MCP corrections",
      actor: "mcp",
      condition: { amount_lt: 1000, item_types: ["entry_replacement"] },
      action: "auto_approve",
    });
    expect(pol.status).toBe(201);
    const auto = await call(token, "propose_replacement", {
      entry_id: other.entryId,
      date: "2023-05-10",
      lines: [
        { account: other.b.code, amount: 300 },
        { account: other.cash.code, amount: -300 },
      ],
      rationale: "Same fix",
    });
    expect(auto.structuredContent).toMatchObject({ status: "posted", review_item_id: null });
    const replacement = await call(token, "get_entry", {
      entry_id: auto.structuredContent.replacement_entry_id,
    });
    expect(replacement.structuredContent.status).toBe("posted");
    const reversal = await call(token, "get_entry", { entry_id: auto.structuredContent.reversal_entry_id });
    expect(reversal.structuredContent).toMatchObject({ status: "posted", reverses_entry_id: other.entryId });
    await owner.json("DELETE", `/api/v1/orgs/${orgId}/review-policies/${pol.body.id}`);
    expect((await owner.json("POST", `/api/v1/orgs/${orgId}/verify`)).body.ok).toBe(true);
  });

  test("propose_payment_date_change moves a matched bill payment to a new date", async () => {
    const vendor = (await call(token, "create_contact", { kind: "vendor", name: "Redate Vendor" }))
      .structuredContent.contact;
    const accounts = (await call(token, "get_account_balances", {})).structuredContent.accounts;
    const expense = accounts.find((a: any) => a.type === "expense" && a.subtype !== "uncategorized");
    const bill = await owner.json("POST", `/api/v1/orgs/${orgId}/bills`, {
      vendor_id: vendor.id,
      issue_date: "2026-07-01",
      lines: [{ description: "Service", amount: 25_000, account_id: expense.id }],
    });
    const billId = bill.body.bill.id as string;
    const ba = (
      await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts`, {
        name: "Redate Checking",
        kind: "checking",
      })
    ).body;
    await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts/${ba.id}/import`, {
      filename: "jul.csv",
      content: "Date,Description,Amount\n2026-07-15,PAYMENT REDATE VENDOR,-250.00\n",
    });
    const txn = (
      await owner.json("GET", `/api/v1/orgs/${orgId}/bank-transactions?bank_account_id=${ba.id}&status=new`)
    ).body.data[0];
    const paid = await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/bank-transactions/${txn.id}/record-payment`,
      {
        contact_id: vendor.id,
        applications: [{ document_id: billId, amount: 25_000 }],
      },
    );
    expect(paid.status).toBe(200);
    const paymentId = paid.body.payment.id as string;
    const oldEntryId = paid.body.entry.id as string;
    const payment = async () => (await owner.json("GET", `/api/v1/orgs/${orgId}/payments/${paymentId}`)).body;

    // Rejecting leaves everything as it was.
    const a = await call(token, "propose_payment_date_change", {
      payment_id: paymentId,
      date: "2026-07-12",
      rationale: "The bank cleared it on the 12th",
    });
    expect(a.structuredContent.status).toBe("pending_review");
    const dup = await call(token, "propose_payment_date_change", {
      payment_id: paymentId,
      date: "2026-07-13",
      rationale: "Again",
    });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain("already_pending");
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${a.structuredContent.review_item_id}/reject`, {
      note: "no",
    });
    expect(await payment()).toMatchObject({ date: "2026-07-15", entry_id: oldEntryId });

    // Approving moves the payment and keeps the bill paid and the bank transaction matched.
    const b = await call(token, "propose_payment_date_change", {
      payment_id: paymentId,
      date: "2026-07-12",
      rationale: "The bank cleared it on the 12th",
    });
    const item = await call(token, "get_review_item", { review_item_id: b.structuredContent.review_item_id });
    expect(item.structuredContent).toMatchObject({
      item_type: "payment_redate",
      payload: { from_date: "2026-07-15", to_date: "2026-07-12" },
    });
    const ok = await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${b.structuredContent.review_item_id}/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    const after = await payment();
    expect(after.date).toBe("2026-07-12");
    expect(after.entry_id).not.toBe(oldEntryId);
    expect(after.applications[0].applied_date).toBe("2026-07-12");
    const newEntry = (await call(token, "get_entry", { entry_id: after.entry_id })).structuredContent;
    expect(newEntry).toMatchObject({ status: "posted", date: "2026-07-12", source_type: "bill_payment" });
    const old = (await call(token, "get_entry", { entry_id: oldEntryId })).structuredContent;
    const reversal = (await call(token, "get_entry", { entry_id: old.reversed_by_entry_id }))
      .structuredContent;
    expect(reversal).toMatchObject({ status: "posted", date: "2026-07-15" });
    const t = (await owner.json("GET", `/api/v1/orgs/${orgId}/bank-transactions/${txn.id}`)).body;
    expect(t).toMatchObject({ status: "matched", entry_id: after.entry_id });
    expect((await owner.json("GET", `/api/v1/orgs/${orgId}/bills/${billId}`)).body.status).toBe("paid");
    expect((await owner.json("POST", `/api/v1/orgs/${orgId}/verify`)).body.ok).toBe(true);

    // A voided payment is refused.
    const cash = accounts.find((x: any) => x.code === "1000");
    const bill2 = await owner.json("POST", `/api/v1/orgs/${orgId}/bills`, {
      vendor_id: vendor.id,
      issue_date: "2026-07-01",
      lines: [{ description: "Service", amount: 1000, account_id: expense.id }],
    });
    const p2 = await owner.json("POST", `/api/v1/orgs/${orgId}/payments`, {
      direction: "sent",
      contact_id: vendor.id,
      date: "2026-07-20",
      amount: 1000,
      account_id: cash.id,
      applications: [{ document_id: bill2.body.bill.id, amount: 1000 }],
    });
    await owner.json("POST", `/api/v1/orgs/${orgId}/payments/${p2.body.payment.id}/void`, {});
    const voided = await call(token, "propose_payment_date_change", {
      payment_id: p2.body.payment.id,
      date: "2026-07-21",
      rationale: "Should be refused",
    });
    expect(voided.isError).toBe(true);

    // A payment cleared in a completed reconciliation is refused.
    const recBank = (
      await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts`, {
        name: "Recon Checking",
        kind: "checking",
      })
    ).body;
    const bill3 = await owner.json("POST", `/api/v1/orgs/${orgId}/bills`, {
      vendor_id: vendor.id,
      issue_date: "2026-07-01",
      lines: [{ description: "Service", amount: 3000, account_id: expense.id }],
    });
    const p3 = await owner.json("POST", `/api/v1/orgs/${orgId}/payments`, {
      direction: "sent",
      contact_id: vendor.id,
      date: "2026-07-22",
      amount: 3000,
      account_id: recBank.ledger_account_id,
      applications: [{ document_id: bill3.body.bill.id, amount: 3000 }],
    });
    const rec = await owner.json("POST", `/api/v1/orgs/${orgId}/reconciliations`, {
      account_id: recBank.ledger_account_id,
      statement_end_date: "2026-07-31",
      statement_ending_balance: -3000,
    });
    const recLine = (
      await owner.json("GET", `/api/v1/orgs/${orgId}/reconciliations/${rec.body.id}`)
    ).body.lines.find((l: any) => l.amount === -3000);
    await owner.json("POST", `/api/v1/orgs/${orgId}/reconciliations/${rec.body.id}/lines`, {
      line_ids: [recLine.id],
      cleared: true,
    });
    const done = await owner.json("POST", `/api/v1/orgs/${orgId}/reconciliations/${rec.body.id}/complete`);
    expect(done.body.status).toBe("completed");
    const reconciled = await call(token, "propose_payment_date_change", {
      payment_id: p3.body.payment.id,
      date: "2026-07-23",
      rationale: "Should be refused",
    });
    expect(reconciled.isError).toBe(true);
    expect(reconciled.content[0]!.text).toContain("reconciled");
  });

  test("propose_recurring_template: create, update, and pause go to review; approval activates", async () => {
    const vendor = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "vendor",
      name: "Landlord LLC",
    });
    const missing = await call(token, "propose_recurring_template", {
      action: "create",
      kind: "bill",
      name: "Rent",
      rationale: "Monthly rent",
    });
    expect(missing.isError).toBe(true);

    const c = await call(token, "propose_recurring_template", {
      action: "create",
      kind: "bill",
      name: "Office rent",
      contact_id: vendor.body.id,
      run_mode: "post",
      schedule: { unit: "month", start_date: "2030-01-31", anchor_day: -1 },
      memo: "Rent for {month} {year}",
      lines: [{ account: "6130", amount: 200_000, description: "Rent {period}" }],
      rationale: "The lease is $2,000 a month, due at month end",
    });
    expect(c.isError).toBe(false);
    expect(c.structuredContent.status).toBe("pending_review");
    const id = c.structuredContent.template_id;
    expect(c.structuredContent.template).toMatchObject({
      status: "proposed",
      schedule_summary: "Monthly on the last day",
      upcoming: ["2030-01-31", "2030-02-28", "2030-03-31"],
      total: 200_000,
    });

    // The template doesn't run until approved, and a second change waits for the first.
    const early = await call(token, "propose_recurring_template", {
      action: "pause",
      template_id: id,
      rationale: "x",
    });
    expect(early.isError).toBe(true);
    const listed = await call(token, "list_recurring_templates", { kind: "bill" });
    const row = listed.structuredContent.templates.find((t: any) => t.id === id);
    expect(row.pending_review.action).toBe("create");
    expect(row.template.lines[0].account_code).toBe("6130");

    const ok = await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${c.structuredContent.review_item_id}/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    const active = await owner.json("GET", `/api/v1/orgs/${orgId}/recurring-templates/${id}`);
    expect(active.body.template.status).toBe("active");
    expect(active.body.template.next_date).toBe("2030-01-31");

    // An update changes only the fields given, after approval.
    const u = await call(token, "propose_recurring_template", {
      action: "update",
      template_id: id,
      lines: [{ account: "6130", amount: 210_000, description: "Rent {period}" }],
      rationale: "Rent went up",
    });
    expect(u.structuredContent.status).toBe("pending_review");
    expect(u.structuredContent.template.total).toBe(210_000);
    const still = await owner.json("GET", `/api/v1/orgs/${orgId}/recurring-templates/${id}`);
    expect(still.body.template.total).toBe(200_000);
    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${u.structuredContent.review_item_id}/approve`,
      {},
    );
    const updated = (await owner.json("GET", `/api/v1/orgs/${orgId}/recurring-templates/${id}`)).body
      .template;
    expect(updated).toMatchObject({ total: 210_000, name: "Office rent", run_mode: "post" });
    expect(updated.template.memo).toBe("Rent for {month} {year}");

    // A rejected pause changes nothing.
    const p = await call(token, "propose_recurring_template", {
      action: "pause",
      template_id: id,
      rationale: "Moving out",
    });
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${p.structuredContent.review_item_id}/reject`, {});
    expect(
      (await owner.json("GET", `/api/v1/orgs/${orgId}/recurring-templates/${id}`)).body.template.status,
    ).toBe("active");

    // Over the REST API the assistant can't delete, skip, or run a template.
    const del = await raw("DELETE", `/api/v1/orgs/${orgId}/recurring-templates/${id}`, undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(del.status).toBe(403);
  });

  test("a rejected recurring proposal is discarded; policies never auto-approve post_and_send", async () => {
    const cust = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "customer",
      name: "Retainer Client",
      email: "ap@retainer.test",
    });
    const base = {
      action: "create",
      kind: "invoice",
      contact_id: cust.body.id,
      schedule: { unit: "month", start_date: "2030-02-01" },
      lines: [{ account: "4000", unit_price: 500, description: "Retainer {month}" }],
      rationale: "Monthly retainer",
    };
    const r = await call(token, "propose_recurring_template", { ...base, name: "Rejected retainer" });
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${r.structuredContent.review_item_id}/reject`, {});
    expect(
      (
        await owner.json(
          "GET",
          `/api/v1/orgs/${orgId}/recurring-templates/${r.structuredContent.template_id}`,
        )
      ).status,
    ).toBe(404);

    const pol = await owner.json("POST", `/api/v1/orgs/${orgId}/review-policies`, {
      name: "Small MCP templates",
      actor: "mcp",
      condition: { amount_lt: 1000, item_types: ["recurring_template"] },
      action: "auto_approve",
    });
    expect(pol.status).toBe(201);
    const auto = await call(token, "propose_recurring_template", { ...base, name: "Draft retainer" });
    expect(auto.structuredContent.review_item_id).toBeNull();
    expect(auto.structuredContent.status).toBe("active");
    const send = await call(token, "propose_recurring_template", {
      ...base,
      name: "Emailed retainer",
      run_mode: "post_and_send",
    });
    expect(send.structuredContent.status).toBe("pending_review");
    const item = await owner.json(
      "GET",
      `/api/v1/orgs/${orgId}/review/${send.structuredContent.review_item_id}`,
    );
    expect(item.body.reason).toContain("emails invoices");
    await owner.json("DELETE", `/api/v1/orgs/${orgId}/review-policies/${pol.body.id}`);
  });

  test("append_note and the profile/notes resources", async () => {
    await owner.json("PUT", `/api/v1/orgs/${orgId}/profile`, {
      description: "Design studio",
      recurring: [{ item: "Adobe", account_code: "4000" }],
    });
    const n = await call(token, "append_note", {
      note: "Payments from Acme are retainer billing, account 4000.",
    });
    expect(n.isError).toBe(false);
    const secret = await call(token, "append_note", { note: "Bank login password: hunter2hunter2" });
    expect(secret.isError).toBe(true);
    const notes = await mcp(token, "resources/read", { uri: "org://notes" });
    expect(notes.body.result.contents[0].text).toContain("retainer billing");
    expect(notes.body.result.contents[0].text).toContain("AI assistant");
    const profile = await mcp(token, "resources/read", { uri: "org://profile" });
    expect(profile.body.result.contents[0].text).toContain("Design studio");
    const list = await owner.json("GET", `/api/v1/orgs/${orgId}/notes`);
    expect(list.body.data[0]).toMatchObject({ author_actor: "mcp" });
  });

  test("API tokens also work over MCP, as the mcp actor", async () => {
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "script",
      role: "bookkeeper",
    });
    const r = await call(t.body.token, "create_manual_entry", {
      date: "2026-06-30",
      lines: [
        { account: "1000", amount: 100 },
        { account: "3100", amount: -100 },
      ],
      rationale: "Test",
    });
    expect(r.structuredContent.status).toBe("pending_review");
    expect((await anon(env).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(401);
  });

  describe("record_invoice_payment", () => {
    const api = (path: string) => `/api/v1/orgs/${orgId}${path}`;
    async function setup() {
      const accounts = (await call(token, "get_account_balances", {})).structuredContent.accounts;
      const income = accounts.find((a: any) => a.type === "income" || a.type === "revenue");
      const cash = accounts.find((a: any) => a.code === "1000");
      return { income, cash };
    }
    async function customer(name: string) {
      return (await owner.json("POST", api("/contacts"), { kind: "customer", name })).body.id as string;
    }
    async function invoice(customerId: string, amount: number, post = true) {
      const { income } = await setup();
      const inv = (
        await owner.json("POST", api("/invoices"), {
          customer_id: customerId,
          issue_date: "2026-07-01",
          lines: [{ description: "Work", quantity_milli: 1000, unit_price: amount, account_id: income.id }],
        })
      ).body;
      if (post) {
        const f = await owner.json("POST", api(`/invoices/${inv.id}/finalize`), {});
        expect(f.body.invoice.status).toBe("sent");
      }
      return inv as { id: string; number: string };
    }
    const getInvoice = async (id: string) => (await owner.json("GET", api(`/invoices/${id}`))).body;
    const approve = (reviewId: string) => owner.json("POST", api(`/review/${reviewId}/approve`), {});
    const reject = (reviewId: string) =>
      owner.json("POST", api(`/review/${reviewId}/reject`), { note: "no" });
    async function deposit(desc: string, amount: string) {
      const ba = (
        await owner.json("POST", api("/bank-accounts"), { name: `${desc} Checking`, kind: "checking" })
      ).body;
      await owner.json("POST", api(`/bank-accounts/${ba.id}/import`), {
        filename: "x.csv",
        content: `Date,Description,Amount\n2026-07-15,${desc},${amount}\n`,
      });
      return (await owner.json("GET", api(`/bank-transactions?bank_account_id=${ba.id}&status=new`))).body
        .data[0];
    }

    test("partial payment, then the rest with the amount omitted", async () => {
      const { cash } = await setup();
      const inv = await invoice(await customer("Partial Customer"), 100_000);
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number, amount: 40_000 }],
        date: "2026-07-10",
        amount: 40_000,
        account: cash.code,
        reference: "CHK 1",
        rationale: "Customer paid part by check",
      });
      expect(a.structuredContent).toMatchObject({
        status: "pending_review",
        unapplied: 0,
        invoices: [{ number: inv.number, applied: 40_000, balance_due_after: 60_000 }],
      });
      expect((await getInvoice(inv.id)).status).toBe("sent");
      const item = await call(token, "get_review_item", {
        review_item_id: a.structuredContent.review_item_id,
      });
      expect(item.structuredContent.rationale).toBe("Customer paid part by check");
      expect(item.structuredContent.payload.payment).toMatchObject({
        direction: "received",
        amount: 40_000,
        applications: [{ document_type: "invoice", document_number: inv.number, amount: 40_000 }],
      });
      expect((await approve(a.structuredContent.review_item_id)).status).toBe(200);
      expect(await getInvoice(inv.id)).toMatchObject({ status: "partial", amount_paid: 40_000 });

      const b = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.id }],
        date: "2026-07-20",
        amount: 60_000,
        account: cash.id,
        rationale: "The balance arrived",
      });
      expect(b.structuredContent.invoices[0]).toMatchObject({ applied: 60_000, balance_due_after: 0 });
      expect((await approve(b.structuredContent.review_item_id)).status).toBe(200);
      expect((await getInvoice(inv.id)).status).toBe("paid");
      expect((await owner.json("POST", api("/verify"))).body.ok).toBe(true);
    });

    test("payments waiting in review count against the open balance", async () => {
      const { cash } = await setup();
      const inv = await invoice(await customer("Pending Guard Customer"), 100_000);
      const args = {
        invoices: [{ invoice: inv.number, amount: 100_000 }],
        date: "2026-07-10",
        amount: 100_000,
        account: cash.code,
        rationale: "Paid in full",
      };
      const a = await call(token, "record_invoice_payment", args);
      expect(a.structuredContent.status).toBe("pending_review");
      const b = await call(token, "record_invoice_payment", args);
      expect(b.isError).toBe(true);
      expect(b.content[0]!.text).toContain("over_applied");
      expect(b.content[0]!.text).toContain("review");
      const listed = await call(token, "list_invoice_payments", {});
      expect(
        listed.structuredContent.payments.find((p: any) => p.id === a.structuredContent.payment_id),
      ).toMatchObject({ entry_status: "pending_review", amount: 100_000 });
      await reject(a.structuredContent.review_item_id);
    });

    test("approval is refused when another payment used up the invoice meanwhile", async () => {
      const { cash } = await setup();
      const cust = await customer("Approval Guard Customer");
      const inv = await invoice(cust, 100_000);
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number }],
        date: "2026-07-10",
        amount: 100_000,
        account: cash.code,
        rationale: "Paid in full",
      });
      expect(a.structuredContent.status).toBe("pending_review");
      const direct = await owner.json("POST", api("/payments"), {
        direction: "received",
        contact_id: cust,
        date: "2026-07-11",
        amount: 100_000,
        account_id: cash.id,
        applications: [{ document_id: inv.id, amount: 100_000 }],
      });
      expect(direct.status).toBe(201);
      const refused = await approve(a.structuredContent.review_item_id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code ?? refused.body.code).toBe("over_applied");
      expect(JSON.stringify(refused.body)).toContain("now has $0.00 open");
      expect((await reject(a.structuredContent.review_item_id)).status).toBe(200);
      expect(await getInvoice(inv.id)).toMatchObject({ status: "paid", amount_paid: 100_000 });
      expect((await owner.json("POST", api("/verify"))).body.ok).toBe(true);
    });

    test("a bank deposit is linked on approval and released on rejection", async () => {
      const cust = await customer("Bank Customer");
      const inv = await invoice(cust, 100_000);
      const txn = await deposit("BANK CUSTOMER PAYMENT", "1000.00");
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number }],
        transaction_id: txn.id,
        rationale: "Deposit matches the invoice",
      });
      expect(a.structuredContent.status).toBe("pending_review");
      const during = (await owner.json("GET", api(`/bank-transactions/${txn.id}`))).body;
      expect(during.review_item_id).toBe(a.structuredContent.review_item_id);
      expect((await approve(a.structuredContent.review_item_id)).status).toBe(200);
      expect((await getInvoice(inv.id)).status).toBe("paid");
      expect((await owner.json("GET", api(`/bank-transactions/${txn.id}`))).body.entry_id).toBe(
        a.structuredContent.entry_id,
      );

      const inv2 = await invoice(cust, 50_000);
      const txn2 = await deposit("BANK CUSTOMER PAYMENT TWO", "500.00");
      const b = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv2.number }],
        transaction_id: txn2.id,
        rationale: "Deposit matches the invoice",
      });
      expect((await reject(b.structuredContent.review_item_id)).status).toBe(200);
      expect((await owner.json("GET", api(`/bank-transactions/${txn2.id}`))).body.status).toBe("new");
      expect((await getInvoice(inv2.id)).status).toBe("sent");
      const payments = (await owner.json("GET", api(`/payments/${b.structuredContent.payment_id}`))).body;
      expect(payments.voided_at).not.toBeNull();
    });

    test("an overpayment stays as customer credit", async () => {
      const { cash } = await setup();
      const cust = await customer("Overpay Customer");
      const inv = await invoice(cust, 100_000);
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number }],
        date: "2026-07-10",
        amount: 120_000,
        account: cash.code,
        rationale: "Customer overpaid",
      });
      expect(a.structuredContent.unapplied).toBe(20_000);
      expect((await approve(a.structuredContent.review_item_id)).status).toBe(200);
      const listed = await call(token, "list_invoice_payments", { customer_id: cust });
      expect(listed.structuredContent.payments[0]).toMatchObject({ amount: 120_000, unapplied: 20_000 });
      expect((await getInvoice(inv.id)).status).toBe("paid");
    });

    test("withdraw_proposal undoes the assistant's own pending proposal", async () => {
      const { cash } = await setup();
      const cust = await customer("Withdraw Customer");
      const inv = await invoice(cust, 100_000);
      const args = {
        invoices: [{ invoice: inv.number }],
        date: "2026-07-10",
        amount: 100_000,
        account: cash.code,
        rationale: "Paid in full",
      };
      const a = await call(token, "record_invoice_payment", args);
      const w = await call(token, "withdraw_proposal", {
        review_item_id: a.structuredContent.review_item_id,
        rationale: "Wrong amount",
      });
      expect(w.structuredContent.status).toBe("withdrawn");
      const item = await call(token, "get_review_item", {
        review_item_id: a.structuredContent.review_item_id,
      });
      expect(item.structuredContent).toMatchObject({
        status: "rejected",
        decision_note: "Withdrawn by the assistant: Wrong amount",
      });
      const pay = (await owner.json("GET", api(`/payments/${a.structuredContent.payment_id}`))).body;
      expect(pay.voided_at).not.toBeNull();
      expect(await getInvoice(inv.id)).toMatchObject({ status: "sent", amount_paid: 0 });
      const audit = await owner.json("GET", api(`/audit?target_id=${a.structuredContent.review_item_id}`));
      expect(JSON.stringify(audit.body)).toContain("review.withdraw");
      // The pending guard no longer blocks a corrected proposal.
      const b = await call(token, "record_invoice_payment", {
        ...args,
        amount: 60_000,
        invoices: [{ invoice: inv.number }],
      });
      expect(b.structuredContent.status).toBe("pending_review");
      // Already decided: refused.
      expect((await approve(b.structuredContent.review_item_id)).status).toBe(200);
      const again = await call(token, "withdraw_proposal", {
        review_item_id: b.structuredContent.review_item_id,
        rationale: "Too late",
      });
      expect(again.isError).toBe(true);
      expect(again.content[0]!.text).toContain("invalid_state");
      // A person's own proposal, or another person's assistant's, can't be withdrawn.
      const h = await env.ctx.orgs.mustOpen(orgId);
      for (const [actor, by] of [
        ["user", owner.userId],
        ["mcp", admin.userId],
      ] as const) {
        const id = newId();
        await h.write((tx) =>
          tx.insert(org.reviewItems).values({
            id,
            itemType: "payment_redate",
            itemId: newId(),
            proposedByActor: actor,
            proposedById: by,
            reason: "test",
          }),
        );
        const refused = await call(token, "withdraw_proposal", { review_item_id: id, rationale: "Not mine" });
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toContain("forbidden");
      }
    });

    test("withdrawing a bank-linked proposal frees the transaction", async () => {
      const inv = await invoice(await customer("Withdraw Bank Customer"), 30_000);
      const txn = await deposit("WITHDRAW BANK DEPOSIT", "300.00");
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number }],
        transaction_id: txn.id,
        rationale: "Deposit matches",
      });
      await call(token, "withdraw_proposal", {
        review_item_id: a.structuredContent.review_item_id,
        rationale: "Mistake",
      });
      expect((await owner.json("GET", api(`/bank-transactions/${txn.id}`))).body).toMatchObject({
        status: "new",
        review_item_id: null,
      });
    });

    test("a person can still reject through REST", async () => {
      const { cash } = await setup();
      const inv = await invoice(await customer("Reject Customer"), 10_000);
      const a = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: inv.number }],
        date: "2026-07-10",
        amount: 10_000,
        account: cash.code,
        rationale: "Paid",
      });
      expect((await reject(a.structuredContent.review_item_id)).status).toBe(200);
    });

    test("refusals", async () => {
      const { cash } = await setup();
      const c1 = await customer("Refuse One");
      const c2 = await customer("Refuse Two");
      const i1 = await invoice(c1, 10_000);
      const i2 = await invoice(c2, 10_000);
      const draft = await invoice(c1, 10_000, false);
      const base = { date: "2026-07-10", amount: 10_000, account: cash.code, rationale: "Testing refusals" };
      const mixed = await call(token, "record_invoice_payment", {
        ...base,
        invoices: [{ invoice: i1.number }, { invoice: i2.number }],
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.content[0]!.text).toContain("different customers");
      const d = await call(token, "record_invoice_payment", {
        ...base,
        invoices: [{ invoice: draft.number }],
      });
      expect(d.isError).toBe(true);
      expect(d.content[0]!.text).toContain("document_not_open");
      const out = await deposit("WITHDRAWAL XYZ", "-100.00");
      const w = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: i1.number }],
        transaction_id: out.id,
        rationale: "Testing refusals",
      });
      expect(w.isError).toBe(true);
      expect(w.content[0]!.text).toContain("money out");
      const inn = await deposit("DEPOSIT ABC", "100.00");
      const both = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: i1.number }],
        transaction_id: inn.id,
        amount: 10_000,
        rationale: "Testing refusals",
      });
      expect(both.isError).toBe(true);
      expect(both.content[0]!.text).toContain("come from the transaction");
      const none = await call(token, "record_invoice_payment", {
        invoices: [{ invoice: i1.number }],
        rationale: "Testing refusals",
      });
      expect(none.isError).toBe(true);
      const ro = (await authorize(viewer, await register("Viewer Payment AI"))).tok.body.access_token;
      const v = await call(ro, "record_invoice_payment", { ...base, invoices: [{ invoice: i1.number }] });
      expect(v.isError).toBe(true);
    });
  });
  describe("record_bill_payment", () => {
    const api = (path: string) => `/api/v1/orgs/${orgId}${path}`;
    const accountsList = async () =>
      (await call(token, "get_account_balances", {})).structuredContent.accounts;
    async function vendor(name: string) {
      return (await owner.json("POST", api("/contacts"), { kind: "vendor", name })).body.id as string;
    }
    async function bill(vendorId: string, amount: number, number: string) {
      const expense = (await accountsList()).find((a: any) => a.type === "expense");
      const b = await owner.json("POST", api("/bills"), {
        vendor_id: vendorId,
        bill_number: number,
        issue_date: "2026-07-01",
        lines: [{ description: "Work", amount, account_id: expense.id }],
      });
      expect(b.status).toBe(201);
      return b.body.bill as { id: string };
    }
    const getBill = async (id: string) => (await owner.json("GET", api(`/bills/${id}`))).body;
    const approve = (reviewId: string) => owner.json("POST", api(`/review/${reviewId}/approve`), {});

    test("is listed, and an owner-equity payment is approved to paid with AP back to zero", async () => {
      const names = (await mcp(token, "tools/list")).body.result.tools.map((t: any) => t.name);
      expect(names).toContain("record_bill_payment");
      const equity = (await accountsList()).find((a: any) => a.code === "3100");
      const v = await vendor("Owner Paid Vendor");
      const b = await bill(v, 30_000, "OP-1");
      const r = await call(token, "record_bill_payment", {
        bills: [{ bill: "OP-1" }],
        date: "2026-07-10",
        amount: 30_000,
        account: equity.code,
        rationale: "The owner paid this personally",
      });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({
        status: "pending_review",
        unapplied: 0,
        bills: [{ bill_id: b.id, number: "OP-1", applied: 30_000, balance_due_after: 0 }],
      });
      expect((await getBill(b.id)).status).not.toBe("paid");
      expect((await approve(r.structuredContent.review_item_id)).status).toBe(200);
      expect((await getBill(b.id)).status).toBe("paid");
      const listed = (await call(token, "list_bill_payments", {})).structuredContent.payments;
      expect(listed.find((p: any) => p.id === r.structuredContent.payment_id)).toBeTruthy();
      expect((await owner.json("POST", api("/verify"))).body.ok).toBe(true);
    });

    test("refuses over-applied amounts, invoice IDs, and accounts payment cannot move through", async () => {
      const cash = (await accountsList()).find((a: any) => a.code === "1000");
      const v = await vendor("Refusal Vendor");
      const b = await bill(v, 10_000, "RF-1");
      const over = await call(token, "record_bill_payment", {
        bills: [{ bill: b.id, amount: 20_000 }],
        date: "2026-07-10",
        amount: 20_000,
        account: cash.code,
        rationale: "Too much",
      });
      expect(over.isError).toBe(true);
      expect(over.content[0]!.text).toContain("over_applied");
      const customerId = (await owner.json("POST", api("/contacts"), { kind: "customer", name: "Cust RF" }))
        .body.id;
      const income = (await accountsList()).find((a: any) => a.type === "income");
      const inv = (
        await owner.json("POST", api("/invoices"), {
          customer_id: customerId,
          issue_date: "2026-07-01",
          lines: [{ description: "x", unit_price: 5_000, account_id: income.id }],
        })
      ).body;
      await owner.json("POST", api(`/invoices/${inv.id}/finalize`), {});
      const wrongType = await call(token, "record_bill_payment", {
        bills: [{ bill: inv.id }],
        date: "2026-07-10",
        amount: 5_000,
        account: cash.code,
        rationale: "Wrong document type",
      });
      expect(wrongType.isError).toBe(true);
      const ap = (await accountsList()).find((a: any) => a.code === "2000");
      const badAccount = await call(token, "record_bill_payment", {
        bills: [{ bill: b.id }],
        date: "2026-07-10",
        amount: 10_000,
        account: ap.code,
        rationale: "Paying AP from AP",
      });
      expect(badAccount.isError).toBe(true);
      expect(badAccount.content[0]!.text).toContain("invalid_account");
    });
  });
  describe("withdraw_proposal covers every proposal type", () => {
    const api = (path: string) => `/api/v1/orgs/${orgId}${path}`;
    const accounts = async () => (await call(token, "get_account_balances", {})).structuredContent.accounts;
    const expenseCode = async () =>
      (await accounts()).find((a: any) => a.type === "expense" && a.subtype !== "uncategorized").code;
    const contact = async (kind: "customer" | "vendor", name: string) =>
      (await owner.json("POST", api("/contacts"), { kind, name })).body.id as string;

    /** Withdraws the item and checks it ended rejected, with the note, no decider, and an audit row. */
    async function withdraw(reviewId: string, reason = "Proposed by mistake") {
      const w = await call(token, "withdraw_proposal", { review_item_id: reviewId, rationale: reason });
      expect(w.isError).toBe(false);
      expect(w.structuredContent.status).toBe("withdrawn");
      const item = (await owner.json("GET", api(`/review/${reviewId}`))).body;
      expect(item).toMatchObject({
        status: "rejected",
        decision_note: `Withdrawn by the assistant: ${reason}`,
        decided_by: null,
      });
      const audit = (await owner.json("GET", api(`/audit?target_id=${reviewId}`))).body.data;
      expect(audit.some((r: any) => r.action === "review.withdraw")).toBe(true);
      return item;
    }
    const entryStatus = async (id: string) =>
      (await call(token, "get_entry", { entry_id: id })).structuredContent.status;

    test("categorize_transaction: the entry is rejected and the transaction is open again", async () => {
      const ba = (
        await owner.json("POST", api("/bank-accounts"), { name: "Withdraw Card", kind: "checking" })
      ).body;
      await owner.json("POST", api(`/bank-accounts/${ba.id}/import`), {
        filename: "w.csv",
        content: "Date,Description,Amount\n2026-08-02,WITHDRAW TEST SOFTWARE,-19.99\n",
      });
      const txn = (await owner.json("GET", api(`/bank-transactions?bank_account_id=${ba.id}&status=new`)))
        .body.data[0];
      const args = {
        transaction_id: txn.id,
        splits: [{ account: await expenseCode() }],
        rationale: "Software subscription",
      };
      const cat = await call(token, "categorize_transaction", args);
      expect(cat.structuredContent.status).toBe("pending_review");
      const item = await withdraw(cat.structuredContent.review_item_id);
      expect(item.item_type).toBe("bank_categorization");
      expect(await entryStatus(cat.structuredContent.entry_id)).toBe("rejected");
      expect((await owner.json("GET", api(`/bank-transactions/${txn.id}`))).body).toMatchObject({
        status: "new",
        review_item_id: null,
        entry_id: null,
      });
      expect((await call(token, "categorize_transaction", args)).structuredContent.status).toBe(
        "pending_review",
      );
    });

    test("create_manual_entry: the entry is rejected", async () => {
      const r = await call(token, "create_manual_entry", {
        date: "2026-08-03",
        memo: "Withdrawn contribution",
        lines: [
          { account: "1000", amount: 7000 },
          { account: "3100", amount: -7000 },
        ],
        rationale: "Owner contribution",
      });
      expect(r.structuredContent.status).toBe("pending_review");
      expect((await withdraw(r.structuredContent.review_item_id)).item_type).toBe("journal_entry");
      expect(await entryStatus(r.structuredContent.entry_id)).toBe("rejected");
    });

    test("propose_reversal: the reversal is rejected and the original can be reversed again", async () => {
      const { entryId } = await postedExpense("2025-02-10", 4321);
      const r = await call(token, "propose_reversal", { entry_id: entryId, rationale: "Duplicate" });
      expect(r.structuredContent.status).toBe("pending_review");
      await withdraw(r.structuredContent.review_item_id);
      expect(await entryStatus(r.structuredContent.entry_id)).toBe("rejected");
      expect(
        (await call(token, "get_entry", { entry_id: entryId })).structuredContent.reversed_by_entry_id,
      ).toBeNull();
      expect(
        (await call(token, "propose_reversal", { entry_id: entryId, rationale: "Duplicate" }))
          .structuredContent.status,
      ).toBe("pending_review");
    });

    test("create_rule: the proposed rule is deleted", async () => {
      const r = await call(token, "create_rule", {
        name: "Withdrawn rule",
        conditions: { description_contains: "WITHDRAWN RULE" },
        actions: { account: await expenseCode() },
        rationale: "Recurring payee",
      });
      expect(r.structuredContent.status).toBe("pending_review");
      expect((await withdraw(r.structuredContent.review_item_id)).item_type).toBe("rule");
      const rules = (await owner.json("GET", api("/rules"))).body;
      expect(JSON.stringify(rules)).not.toContain(r.structuredContent.rule_id);
    });

    test("create_invoice_draft and create_bill_draft: the draft is deleted", async () => {
      const inv = await call(token, "create_invoice_draft", {
        customer_id: await contact("customer", "Withdraw Invoice Customer"),
        issue_date: "2026-08-01",
        lines: [{ description: "Work", quantity: 1, unit_price: 5000, account: "4000" }],
        rationale: "Work done in July",
      });
      expect((await withdraw(inv.structuredContent.review_item_id)).item_type).toBe("invoice_draft");
      expect((await owner.json("GET", api(`/invoices/${inv.structuredContent.invoice_id}`))).status).toBe(
        404,
      );

      const bill = await call(token, "create_bill_draft", {
        vendor_id: await contact("vendor", "Withdraw Bill Vendor"),
        issue_date: "2026-08-01",
        lines: [{ description: "Supplies", amount: 3300, account: await expenseCode() }],
        rationale: "Vendor invoice",
      });
      expect((await withdraw(bill.structuredContent.review_item_id)).item_type).toBe("bill_draft");
      expect((await owner.json("GET", api(`/bills/${bill.structuredContent.bill_id}`))).status).toBe(404);
    });

    test("propose_replacement: nothing changes and a new replacement can be proposed", async () => {
      const { entryId, b, cash } = await postedExpense("2025-03-10", 1800);
      const before = await pnl("2025");
      const propose = () =>
        call(token, "propose_replacement", {
          entry_id: entryId,
          date: "2025-03-10",
          lines: [
            { account: b.code, amount: 1800 },
            { account: cash.code, amount: -1800 },
          ],
          rationale: "Wrong expense account",
        });
      const r = await propose();
      expect(r.structuredContent.status).toBe("pending_review");
      expect((await withdraw(r.structuredContent.review_item_id)).item_type).toBe("entry_replacement");
      expect(await pnl("2025")).toEqual(before);
      expect(
        (await call(token, "get_entry", { entry_id: entryId })).structuredContent.reversed_by_entry_id,
      ).toBeNull();
      expect((await propose()).structuredContent.status).toBe("pending_review");
    });

    test("propose_payment_date_change: the payment keeps its date and a new change can be proposed", async () => {
      const cust = await contact("customer", "Withdraw Redate Customer");
      const income = (await accounts()).find((a: any) => a.code === "4000");
      const cash = (await accounts()).find((a: any) => a.code === "1000");
      const inv = (
        await owner.json("POST", api("/invoices"), {
          customer_id: cust,
          issue_date: "2026-08-01",
          lines: [{ description: "Work", quantity_milli: 1000, unit_price: 9000, account_id: income.id }],
        })
      ).body;
      await owner.json("POST", api(`/invoices/${inv.id}/finalize`), {});
      const paid = await owner.json("POST", api("/payments"), {
        direction: "received",
        contact_id: cust,
        date: "2026-08-10",
        amount: 9000,
        account_id: cash.id,
        applications: [{ document_id: inv.id, amount: 9000 }],
      });
      expect(paid.status).toBe(201);
      const paymentId = paid.body.payment.id as string;
      const propose = () =>
        call(token, "propose_payment_date_change", {
          payment_id: paymentId,
          date: "2026-08-08",
          rationale: "The bank shows the 8th",
        });
      const r = await propose();
      expect(r.structuredContent.status).toBe("pending_review");
      expect((await withdraw(r.structuredContent.review_item_id)).item_type).toBe("payment_redate");
      expect((await owner.json("GET", api(`/payments/${paymentId}`))).body).toMatchObject({
        date: "2026-08-10",
        entry_id: paid.body.payment.entry_id,
      });
      expect((await propose()).structuredContent.status).toBe("pending_review");
    });

    test("propose_recurring_template: a create leaves no template; an update leaves it unchanged", async () => {
      const base = {
        kind: "bill",
        contact_id: await contact("vendor", "Withdraw Landlord"),
        schedule: { unit: "month", start_date: "2031-01-31", anchor_day: -1 },
        lines: [{ account: "6130", amount: 100_000, description: "Rent {period}" }],
        rationale: "Monthly rent",
      };
      const c = await call(token, "propose_recurring_template", {
        ...base,
        action: "create",
        name: "Withdrawn rent",
      });
      expect(c.structuredContent.status).toBe("pending_review");
      expect((await withdraw(c.structuredContent.review_item_id)).item_type).toBe("recurring_template");
      expect(
        (await owner.json("GET", api(`/recurring-templates/${c.structuredContent.template_id}`))).status,
      ).toBe(404);

      const kept = await call(token, "propose_recurring_template", {
        ...base,
        action: "create",
        name: "Kept rent",
      });
      const id = kept.structuredContent.template_id;
      expect(
        (await owner.json("POST", api(`/review/${kept.structuredContent.review_item_id}/approve`), {}))
          .status,
      ).toBe(200);
      const update = () =>
        call(token, "propose_recurring_template", {
          action: "update",
          template_id: id,
          lines: [{ account: "6130", amount: 110_000, description: "Rent {period}" }],
          rationale: "Rent went up",
        });
      const u = await update();
      expect(u.structuredContent.status).toBe("pending_review");
      await withdraw(u.structuredContent.review_item_id);
      expect((await owner.json("GET", api(`/recurring-templates/${id}`))).body.template).toMatchObject({
        status: "active",
        total: 100_000,
      });
      // The withdrawn change no longer blocks a new one.
      expect((await update()).structuredContent.status).toBe("pending_review");
    });
  });
});

describe("one connection, several organizations", () => {
  let multi: Client;
  let alpha: string; // multi is a bookkeeper
  let beta: string; // multi is a viewer
  let gamma: string; // multi is an accountant, but never grants it
  const q = () => ({
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
  });
  const refresh = (clientId: string, refresh_token: string) =>
    raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: clientId }),
    );
  const twoOrgs = (clientId: string, defaultOrg = alpha) =>
    authorizeOrgs(
      multi,
      clientId,
      [
        { org_id: alpha, role: "bookkeeper" },
        { org_id: beta, role: "owner" },
      ],
      defaultOrg,
    );
  const myConnection = async (clientId: string) =>
    (await multi.json("GET", "/api/v1/oauth/connections")).body.data.find(
      (x: any) => x.client_id === clientId,
    );

  beforeAll(async () => {
    multi = await login(env, "multi@example.com");
    alpha = await createOrg(env, owner, "Alpha Books");
    beta = await createOrg(env, owner, "Beta Books");
    gamma = await createOrg(env, owner, "Gamma Books");
    await addMember(env, alpha, multi.userId, "bookkeeper");
    await addMember(env, beta, multi.userId, "viewer");
    await addMember(env, gamma, multi.userId, "accountant");
    const h = await env.ctx.orgs.mustOpen(beta);
    await h.write((tx) => tx.update(org.orgSettings).set({ baseCurrency: "EUR" }));
    await owner.json("PUT", `/api/v1/orgs/${alpha}/profile`, { description: "Alpha does audits" });
    await owner.json("PUT", `/api/v1/orgs/${beta}/profile`, { description: "Beta sells bikes" });
  });

  test("consent needs at least one org and an explicit default among the checked ones", async () => {
    const clientId = await register("Picky AI");
    const info = await multi.json(
      "GET",
      `/api/v1/oauth/consent?${new URLSearchParams({ client_id: clientId, ...q() })}`,
    );
    expect(info.body.orgs.map((o: any) => [o.name, o.grantable_roles])).toEqual([
      ["Alpha Books", ["bookkeeper", "accountant", "viewer"]],
      ["Beta Books", ["viewer"]],
      ["Gamma Books", ["accountant", "viewer"]],
    ]);
    const post = (body: Record<string, unknown>) =>
      multi.json("POST", "/api/v1/oauth/consent", { client_id: clientId, ...q(), approve: true, ...body });
    const both = [{ org_id: alpha }, { org_id: beta }];
    expect((await post({ orgs: both })).status).toBe(400);
    const outside = await post({ orgs: both, default_org_id: gamma });
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toContain("default organization");
    expect((await post({ orgs: [], default_org_id: alpha })).status).toBe(400);
    expect((await post({ orgs: [{ org_id: alpha }, { org_id: alpha }], default_org_id: alpha })).status).toBe(
      400,
    );
    // An org the user isn't in can't be slipped in next to ones they are.
    expect((await post({ orgs: [{ org_id: alpha }, { org_id: orgId }], default_org_id: alpha })).status).toBe(
      403,
    );
  });

  test("two orgs with different roles, each capped; nothing outside the grant set is reachable", async () => {
    const clientId = await register("Two Org AI");
    const { tok } = await twoOrgs(clientId);
    expect(tok.status).toBe(200);
    const t = tok.body.access_token as string;

    // REST: both granted orgs read; a member org that wasn't granted and a foreign org are refused.
    const api = tokenClient(env, t);
    expect((await api.json("GET", `/api/v1/orgs/${alpha}/accounts`)).status).toBe(200);
    expect((await api.json("GET", `/api/v1/orgs/${beta}/accounts`)).status).toBe(200);
    expect((await api.json("GET", `/api/v1/orgs/${gamma}/accounts`)).status).toBe(403);
    expect((await api.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(403);
    const listed = (await api.json("GET", "/api/v1/orgs")).body.data.map((o: any) => o.id);
    expect(listed.sort()).toEqual([alpha, beta].sort());

    // list_orgs: the granted orgs only, with role, currency, and the default.
    const r = await call(t, "list_orgs", {});
    expect(r.structuredContent).toEqual({
      default_org_id: alpha,
      orgs: [
        {
          id: alpha,
          name: "Alpha Books",
          currency: "USD",
          role: "bookkeeper",
          is_default: true,
          propose_only: true,
        },
        // Beta was requested as owner, but multi is only a viewer there.
        {
          id: beta,
          name: "Beta Books",
          currency: "EUR",
          role: "viewer",
          is_default: false,
          propose_only: true,
        },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("Gamma");

    const c = await myConnection(clientId);
    expect(c.default_org_id).toBe(alpha);
    expect(c.orgs.map((o: any) => [o.org_name, o.role])).toEqual([
      ["Alpha Books", "bookkeeper"],
      ["Beta Books", "viewer"],
    ]);
    // An owner of one org sees only that org's grant, and no default.
    const ownerView = await owner.json("GET", `/api/v1/orgs/${beta}/oauth/connections`);
    const seen = ownerView.body.data.find((x: any) => x.id === c.id);
    expect(seen.orgs.map((o: any) => o.org_id)).toEqual([beta]);
    expect(seen.default_org_id).toBeNull();
  });

  test("tools take an optional org_id: the default when omitted, refused outside the grants", async () => {
    const t = (await twoOrgs(await register("Org Arg AI"))).tok.body.access_token as string;
    const tools = (await mcp(t, "tools/list")).body.result.tools as { name: string; inputSchema: any }[];
    for (const x of tools) {
      if (x.name === "list_orgs") expect(x.inputSchema.properties.org_id).toBeUndefined();
      else expect(x.inputSchema.properties.org_id).toMatchObject({ type: "string" });
      expect(x.inputSchema.required ?? []).not.toContain("org_id");
    }
    for (const word of ["default", "grant", "switch"])
      expect(tools.some((x) => x.name.includes(word))).toBe(false);

    const n = await call(t, "append_note", { note: "Alpha's retainers go to 4000." });
    expect(n.isError).toBe(false);
    const alphaNotes = (await owner.json("GET", `/api/v1/orgs/${alpha}/notes`)).body.data;
    expect(alphaNotes.some((x: any) => x.body_md.includes("Alpha's retainers"))).toBe(true);

    for (const other of [gamma, orgId, "not-an-org"]) {
      const refused = await call(t, "get_account_balances", { org_id: other });
      expect(refused.isError).toBe(true);
      const text = refused.content[0]!.text;
      expect(text).toContain(`not authorized for organization ${other}`);
      expect(text).toContain(`Alpha Books (org_id ${alpha}, default)`);
      expect(text).toContain(`Beta Books (org_id ${beta})`);
      expect(text).not.toContain("Gamma");
    }
    const inBeta = await call(t, "get_account_balances", { org_id: beta });
    expect(inBeta.isError).toBe(false);
  });

  test("roles apply per org: bookkeeper in one, viewer in the other", async () => {
    const t = (await twoOrgs(await register("Gate AI"))).tok.body.access_token as string;
    const a = await call(t, "create_contact", { org_id: alpha, kind: "vendor", name: "Alpha Vendor" });
    expect(a.isError).toBe(false);
    const b = await call(t, "create_contact", { org_id: beta, kind: "vendor", name: "Beta Vendor" });
    expect(b.isError).toBe(true);
    expect(b.content[0]!.text).toContain("read-only in this organization");
    const entry = await call(t, "create_manual_entry", {
      org_id: beta,
      date: "2026-06-30",
      lines: [
        { account: "1000", amount: 100 },
        { account: "3100", amount: -100 },
      ],
      rationale: "Should be refused in Beta",
    });
    expect(entry.isError).toBe(true);
    // Reads work in both.
    expect((await call(t, "list_contacts", { org_id: beta })).isError).toBe(false);
  });

  test("get_org_profile, get_org_notes, and org://{org_id}/ resources", async () => {
    const t = (await twoOrgs(await register("Profile AI"))).tok.body.access_token as string;
    const pa = await call(t, "get_org_profile", {});
    expect(pa.structuredContent.org_id).toBe(alpha);
    expect(pa.structuredContent.profile).toContain("# Alpha Books");
    expect(pa.structuredContent.profile).toContain("Alpha does audits");
    const pb = await call(t, "get_org_profile", { org_id: beta });
    expect(pb.structuredContent.profile).toContain("Beta sells bikes");
    expect((await call(t, "get_org_profile", { org_id: gamma })).isError).toBe(true);

    await call(t, "append_note", { note: "Alpha bills monthly in arrears." });
    const na = await call(t, "get_org_notes", {});
    expect(na.structuredContent.notes).toContain("monthly in arrears");
    const nb = await call(t, "get_org_notes", { org_id: beta });
    expect(nb.structuredContent.org_id).toBe(beta);
    expect(nb.structuredContent.notes).not.toContain("monthly in arrears");

    const templates = (await mcp(t, "resources/templates/list")).body.result.resourceTemplates.map(
      (r: any) => r.uriTemplate,
    );
    expect(templates).toEqual(["org://{org_id}/profile", "org://{org_id}/notes"]);
    const def = await mcp(t, "resources/read", { uri: "org://profile" });
    expect(def.body.result.contents[0].text).toContain("Alpha does audits");
    const named = await mcp(t, "resources/read", { uri: `org://${beta}/profile` });
    expect(named.body.result.contents[0]).toMatchObject({ uri: `org://${beta}/profile` });
    expect(named.body.result.contents[0].text).toContain("Beta sells bikes");
    expect(
      (await mcp(t, "resources/read", { uri: `org://${beta}/notes` })).body.result.contents[0].text,
    ).not.toContain("monthly in arrears");
    const refused = await mcp(t, "resources/read", { uri: `org://${gamma}/profile` });
    expect(refused.body.error.code).toBe(-32002);
    expect(refused.body.error.message).toContain("not authorized");
  });

  test("only the user changes the default, from their account", async () => {
    const clientId = await register("Default AI");
    const t = (await twoOrgs(clientId)).tok.body.access_token as string;
    const c = await myConnection(clientId);
    // Not through the OAuth token, not by someone else, and only to a granted org.
    expect(
      (await tokenClient(env, t).json("PATCH", `/api/v1/oauth/connections/${c.id}`, { default_org_id: beta }))
        .status,
    ).toBe(403);
    expect(
      (await owner.json("PATCH", `/api/v1/oauth/connections/${c.id}`, { default_org_id: beta })).status,
    ).toBe(404);
    expect(
      (await multi.json("PATCH", `/api/v1/oauth/connections/${c.id}`, { default_org_id: gamma })).status,
    ).toBe(400);
    expect(
      (await multi.json("PATCH", `/api/v1/oauth/connections/${c.id}`, { default_org_id: beta })).status,
    ).toBe(200);
    const r = await call(t, "list_orgs", {});
    expect(r.structuredContent.default_org_id).toBe(beta);
    expect((await call(t, "get_org_profile", {})).structuredContent.org_id).toBe(beta);
  });

  test("one org can be removed and the rest keep working; removing the last disconnects", async () => {
    const clientId = await register("Revoke AI");
    const t = (await twoOrgs(clientId, beta)).tok.body.access_token as string;
    const c = await myConnection(clientId);
    // Someone who isn't the user and doesn't own that org can't touch it.
    const other = await login(env, "stranger@example.com");
    expect((await other.json("DELETE", `/api/v1/oauth/connections/${c.id}/orgs/${beta}`)).status).toBe(404);
    expect((await multi.json("DELETE", `/api/v1/oauth/connections/${c.id}/orgs/${gamma}`)).status).toBe(404);

    expect((await multi.json("DELETE", `/api/v1/oauth/connections/${c.id}/orgs/${beta}`)).status).toBe(200);
    expect((await call(t, "list_contacts", { org_id: beta })).isError).toBe(true);
    expect((await tokenClient(env, t).json("GET", `/api/v1/orgs/${beta}/accounts`)).status).toBe(403);
    // Beta was the default; with only Alpha left, Alpha is used.
    const r = await call(t, "list_orgs", {});
    expect(r.structuredContent.orgs.map((o: any) => o.id)).toEqual([alpha]);
    expect(r.structuredContent.default_org_id).toBe(alpha);
    expect((await call(t, "list_contacts", {})).isError).toBe(false);
    expect((await myConnection(clientId)).orgs.map((o: any) => o.org_id)).toEqual([alpha]);

    expect((await multi.json("DELETE", `/api/v1/oauth/connections/${c.id}/orgs/${alpha}`)).status).toBe(200);
    expect((await mcp(t, "ping")).status).toBe(401);
    expect(await myConnection(clientId)).toBeUndefined();
  });

  test("with the default removed and several orgs left, calls must name an org until the user picks one", async () => {
    const clientId = await register("Three Org AI");
    const { tok } = await authorizeOrgs(
      multi,
      clientId,
      [
        { org_id: alpha, role: "viewer" },
        { org_id: beta, role: "viewer" },
        { org_id: gamma, role: "viewer" },
      ],
      gamma,
    );
    const t = tok.body.access_token as string;
    const c = await myConnection(clientId);
    await multi.json("DELETE", `/api/v1/oauth/connections/${c.id}/orgs/${gamma}`);
    const r = await call(t, "list_contacts", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("no default organization");
    expect((await call(t, "list_contacts", { org_id: beta })).isError).toBe(false);
    expect((await myConnection(clientId)).default_org_id).toBeNull();
  });

  test("an owner disconnecting someone's connection removes only the orgs that owner owns", async () => {
    const own = await createOrg(env, multi, "Multi's Own Co");
    const clientId = await register("Shared AI");
    const t = (
      await authorizeOrgs(
        multi,
        clientId,
        [
          { org_id: alpha, role: "bookkeeper" },
          { org_id: own, role: "owner" },
        ],
        own,
      )
    ).tok.body.access_token as string;
    const c = await myConnection(clientId);
    expect((await owner.json("DELETE", `/api/v1/oauth/connections/${c.id}`)).status).toBe(200);
    expect((await call(t, "list_contacts", { org_id: alpha })).isError).toBe(true);
    expect((await call(t, "list_contacts", {})).isError).toBe(false);
    expect((await myConnection(clientId)).orgs.map((o: any) => o.org_id)).toEqual([own]);
  });

  test("a replayed multi-org code revokes the connection it produced", async () => {
    const clientId = await register("Replay AI");
    const { tok, code, verifier } = await twoOrgs(clientId);
    const replay = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcp(tok.body.access_token, "ping")).status).toBe(401);
  });

  test("deleting an org removes it from connections; the other orgs keep working", async () => {
    const doomed = await createOrg(env, multi, "Doomed Co");
    const clientId = await register("Doomed AI");
    const { tok } = await authorizeOrgs(
      multi,
      clientId,
      [
        { org_id: alpha, role: "bookkeeper" },
        { org_id: doomed, role: "owner" },
      ],
      doomed,
    );
    await env.ctx.orgs.destroy(doomed);
    const r = await call(tok.body.access_token, "list_orgs", {});
    expect(r.structuredContent).toMatchObject({ default_org_id: alpha, orgs: [{ id: alpha }] });
    expect((await myConnection(clientId)).orgs.map((o: any) => o.org_id)).toEqual([alpha]);
  });

  test("leaving an org drops it at once; on refresh, orgs whose membership is gone are dropped too", async () => {
    // Removing a member through the API revokes that org's grant right away.
    const viaApi = await register("Leave AI");
    const t1 = (await twoOrgs(viaApi)).tok.body.access_token as string;
    const delta = await createOrg(env, owner, "Delta Books");
    await addMember(env, delta, multi.userId, "bookkeeper");
    const t2 = (
      await authorizeOrgs(
        multi,
        viaApi,
        [
          { org_id: alpha, role: "bookkeeper" },
          { org_id: delta, role: "bookkeeper" },
        ],
        delta,
      )
    ).tok.body.access_token as string;
    expect((await owner.json("DELETE", `/api/v1/orgs/${delta}/members/${multi.userId}`)).status).toBe(200);
    expect((await call(t2, "list_contacts", { org_id: delta })).isError).toBe(true);
    // Delta was the default; Alpha is the only org left, so it is used.
    expect((await call(t2, "list_orgs", {})).structuredContent.default_org_id).toBe(alpha);
    expect((await call(t2, "list_contacts", {})).isError).toBe(false);
    expect((await call(t1, "list_contacts", {})).isError).toBe(false);

    // A membership that disappears some other way: the org stops answering, and refresh drops it.
    const clientId = await register("Refresh AI");
    const { tok } = await twoOrgs(clientId);
    const { system } = await import("@cosimo/db");
    const { and, eq } = await import("drizzle-orm");
    const removeMembership = (o: string) =>
      env.ctx.system.write((tx) =>
        tx
          .delete(system.memberships)
          .where(and(eq(system.memberships.userId, multi.userId), eq(system.memberships.orgId, o))),
      );
    await removeMembership(beta);
    expect((await call(tok.body.access_token, "list_contacts", { org_id: beta })).isError).toBe(true);
    const r1 = await refresh(clientId, tok.body.refresh_token);
    expect(r1.status).toBe(200);
    expect((await myConnection(clientId)).orgs.map((o: any) => o.org_id)).toEqual([alpha]);
    expect((await call(r1.body.access_token, "list_contacts", {})).isError).toBe(false);

    await removeMembership(alpha);
    const r2 = await refresh(clientId, r1.body.refresh_token);
    expect(r2.body.error).toBe("invalid_grant");
    expect(r2.body.error_description).toContain("no longer a member");
    expect(await myConnection(clientId)).toBeUndefined();
    expect((await mcp(r1.body.access_token, "ping")).status).toBe(401);
  });
});
