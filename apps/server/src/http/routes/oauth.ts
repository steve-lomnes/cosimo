/**
 * OAuth 2.1 endpoints (SPEC §10.4). Protocol endpoints live at the root (`/.well-known/*`,
 * `/oauth/*`); the consent screen is the web app's `/connect` page, which calls the JSON API under
 * `/api/v1/oauth/*` with the user's session.
 */
import type { Role } from "@cosimo/shared";
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppContext } from "../../context.ts";
import { instanceAudit } from "../../services/instance-audit.ts";
import { type AuthorizeRequest, OAuthError, OAuthService } from "../../services/oauth.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { rateLimit, requireAdmin, requireOwner, requireSession } from "../middleware.ts";
import { errorResponses, json, jsonBody, newRouter, OkSchema, OrgParams, z } from "../openapi.ts";
import type { AppEnv } from "../types.ts";

export function oauthService(ctx: AppContext) {
  return ctx.services.oauth as OAuthService;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function oauthJson(c: Context<AppEnv>, body: unknown, status: 200 | 201 | 400 | 401 | 403 | 429 = 200) {
  for (const [k, v] of Object.entries(CORS)) c.header(k, v);
  c.header("cache-control", "no-store");
  return c.json(body as object, status);
}

function oauthFail(c: Context<AppEnv>, e: unknown) {
  if (e instanceof OAuthError) {
    if (e.status === 401) c.header("www-authenticate", 'Basic realm="cosimo"');
    return oauthJson(c, { error: e.error, error_description: e.message }, e.status);
  }
  throw e;
}

async function formOrJson(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)]));
  }
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)]));
}

/** client_secret_basic or client_secret_post (RFC 6749 §2.3.1). */
function clientCreds(c: Context<AppEnv>, body: Record<string, string>) {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    const [id, secret] = Buffer.from(auth.slice(6), "base64").toString().split(":", 2);
    return { client_id: decodeURIComponent(id ?? ""), client_secret: decodeURIComponent(secret ?? "") };
  }
  return { client_id: body.client_id, client_secret: body.client_secret ?? null };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Root-level protocol endpoints. */
export function mountOAuth(app: OpenAPIHono<AppEnv>, ctx: AppContext) {
  const svc = () => oauthService(ctx);

  const protectedResource = (c: Context<AppEnv>) =>
    oauthJson(c, {
      resource: svc().resource,
      authorization_servers: [svc().issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["books"],
      resource_name: "Cosimo",
      resource_documentation: `${svc().issuer}/api/docs`,
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const asMetadata = async (c: Context<AppEnv>) => {
    const dcr = await ctx.settings.get("dynamic_client_registration");
    const iss = svc().issuer;
    return oauthJson(c, {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      ...(dcr ? { registration_endpoint: `${iss}/oauth/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["books"],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${iss}/api/docs`,
    });
  };
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
  app.get("/.well-known/openid-configuration", (c) =>
    oauthJson(
      c,
      { error: "not_supported", error_description: "Cosimo is an OAuth 2.1 server, not OpenID Connect." },
      400,
    ),
  );

  for (const p of ["/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/*"])
    app.options(p, (c) => {
      for (const [k, v] of Object.entries(CORS)) c.header(k, v);
      return c.body(null, 204);
    });

  const DCR_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

  app.post("/oauth/register", async (c) => {
    // Parsed outside the try so a rejection can log what the client asked for.
    let b: Record<string, unknown> | null = null;
    try {
      rateLimit(c, "oauth-register", 20, 3_600_000);
      if (!(await ctx.settings.get("dynamic_client_registration")))
        throw new OAuthError(
          "access_denied",
          "Dynamic client registration is turned off on this server. Ask the admin for a client ID.",
          403,
        );
      b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || Array.isArray(b))
        throw new OAuthError("invalid_client_metadata", "Send JSON client metadata.");
      // Public clients (none) or confidential ones (a secret, sent by post body or Basic auth).
      const method = b.token_endpoint_auth_method ?? "none";
      if (typeof method !== "string" || !DCR_AUTH_METHODS.includes(method))
        throw new OAuthError(
          "invalid_client_metadata",
          "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.",
        );
      const grants = b.grant_types ?? ["authorization_code", "refresh_token"];
      if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token"))
        throw new OAuthError(
          "invalid_client_metadata",
          "Only authorization_code and refresh_token grants are supported.",
        );
      const responseTypes = b.response_types ?? ["code"];
      if (!Array.isArray(responseTypes) || responseTypes.some((t) => t !== "code"))
        throw new OAuthError("invalid_client_metadata", 'Only the "code" response type is supported.');
      const confidential = method !== "none";
      const r = await svc().registerClient({
        client_name: b.client_name as string | undefined,
        redirect_uris: b.redirect_uris,
        via: "dynamic",
        confidential,
      });
      await instanceAudit(ctx.system, {
        userId: null,
        action: "oauth.client.register",
        targetType: "oauth_client",
        targetId: r.client_id,
        ip: c.get("ip"),
        detail: { confidential },
      });
      // RFC 7591 §3.2.1: a confidential client gets its secret now, and it never expires.
      return oauthJson(
        c,
        {
          client_id: r.client_id,
          ...(r.client_secret ? { client_secret: r.client_secret, client_secret_expires_at: 0 } : {}),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: r.client_name,
          redirect_uris: r.redirect_uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: method,
        },
        201,
      );
    } catch (e) {
      // Only non-secret metadata, never the raw body. The logger redacts keys containing
      // "token", so the auth method goes under auth_method.
      if (e instanceof OAuthError)
        ctx.logger.warn("oauth register rejected", {
          error: e.error,
          error_description: e.message,
          request_id: c.get("requestId"),
          client_name: b?.client_name,
          redirect_uris: b?.redirect_uris,
          auth_method: b?.token_endpoint_auth_method,
          grant_types: b?.grant_types,
          response_types: b?.response_types,
        });
      return oauthFail(c, e);
    }
  });

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query() as unknown as AuthorizeRequest;
    const check = await svc().checkAuthorize(q);
    if (!check.ok && !check.redirect) {
      c.header("cache-control", "no-store");
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Cannot connect</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>This app can't connect</h1><p>${esc(check.message)}</p></body>`,
        400,
      );
    }
    if (!check.ok)
      return c.redirect(svc().errorRedirect(q.redirect_uri, check.error, check.message, q.state), 302);
    const qs = new URLSearchParams(c.req.query()).toString();
    return c.redirect(`/connect?${qs}`, 302);
  });

  app.post("/oauth/token", async (c) => {
    try {
      rateLimit(c, "oauth-token", 60, 60_000);
      const b = await formOrJson(c);
      const creds = clientCreds(c, b);
      if (b.grant_type === "authorization_code")
        return oauthJson(c, await svc().exchangeCode({ ...b, ...creds }));
      if (b.grant_type === "refresh_token") return oauthJson(c, await svc().refresh({ ...b, ...creds }));
      throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    } catch (e) {
      return oauthFail(c, e);
    }
  });

  app.post("/oauth/revoke", async (c) => {
    try {
      rateLimit(c, "oauth-token", 60, 60_000);
      const b = await formOrJson(c);
      if (!b.token) throw new OAuthError("invalid_request", "token is required.");
      await svc().revokeToken(b.token, clientCreds(c, b).client_id || undefined);
      return oauthJson(c, {});
    } catch (e) {
      return oauthFail(c, e);
    }
  });
}

// ---------------------------------------------------------------------------- JSON API

const AuthorizeQuery = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  response_type: z.string(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

const ConnectionSchema = z
  .object({
    id: z.string(),
    client_id: z.string(),
    client_name: z.string(),
    user_id: z.string(),
    user_email: z.string(),
    /** Null in an owner's view of one org, or when the user removed the default and has several orgs left. */
    default_org_id: z.string().nullable(),
    orgs: z.array(
      z.object({ org_id: z.string(), org_name: z.string(), role: z.string(), granted_at: z.string() }),
    ),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .openapi("OAuthConnection");

const ClientSchema = z
  .object({
    client_id: z.string(),
    client_name: z.string(),
    redirect_uris: z.array(z.string()),
    registered_via: z.enum(["dynamic", "manual"]),
    confidential: z.boolean(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .openapi("OAuthClient");

const ROLES = ["owner", "bookkeeper", "accountant", "viewer"] as const;

export function oauthRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/oauth/consent",
      tags: ["OAuth"],
      summary: "Describe an authorization request for the consent screen (browser session)",
      request: { query: AuthorizeQuery },
      responses: {
        200: json(
          z.object({
            client: z.object({ id: z.string(), name: z.string(), redirect_host: z.string() }),
            orgs: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                role: z.string(),
                grantable_roles: z.array(z.string()),
              }),
            ),
            default_role: z.string(),
            error: z.object({ error: z.string(), message: z.string() }).nullable(),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const q = c.req.valid("query");
      const check = await oauthService(ctx).checkAuthorize(q);
      if (!check.ok && !check.redirect) throw badRequest(check.message);
      const client = check.client!;
      const orgs = [];
      for (const o of await ctx.orgs.listForUser(p.userId)) {
        orgs.push({
          id: o.id,
          name: o.name,
          role: o.role,
          grantable_roles: OAuthService.grantableRoles(o.role as Role),
        });
      }
      return c.json(
        {
          client: { id: client.id, name: client.clientName, redirect_host: new URL(q.redirect_uri).host },
          orgs,
          default_role: "bookkeeper",
          error: check.ok ? null : { error: check.error, message: check.message },
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/oauth/consent",
      tags: ["OAuth"],
      summary: "Approve or deny an authorization request (browser session); returns where to redirect",
      request: {
        body: jsonBody(
          AuthorizeQuery.extend({
            approve: z.boolean(),
            /** Every org the user checked, each with the role it grants (capped at the user's own). */
            orgs: z
              .array(z.object({ org_id: z.string(), role: z.enum(ROLES).default("bookkeeper") }))
              .max(100)
              .optional(),
            /** Required to approve, and must be one of `orgs`: the user picks it, it is never inferred. */
            default_org_id: z.string().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ redirect_to: z.string() })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const svc = oauthService(ctx);
      const b = c.req.valid("json");
      const check = await svc.checkAuthorize(b);
      if (!check.ok && !check.redirect) throw badRequest(check.message);
      if (!check.ok)
        return c.json(
          { redirect_to: svc.errorRedirect(b.redirect_uri, check.error, check.message, b.state) },
          200,
        );
      if (!b.approve)
        return c.json(
          { redirect_to: svc.errorRedirect(b.redirect_uri, "access_denied", "The user declined.", b.state) },
          200,
        );
      if (!b.orgs?.length) throw badRequest("Pick at least one organization.");
      if (!b.default_org_id) throw badRequest("Pick the default organization.");
      try {
        const out = await svc.approve(
          b,
          p.userId,
          b.orgs.map((o) => ({ orgId: o.org_id, role: o.role })),
          b.default_org_id,
        );
        await instanceAudit(ctx.system, {
          userId: p.userId,
          action: "oauth.grant",
          targetType: "oauth_client",
          targetId: b.client_id,
          detail: {
            orgs: out.grants.map((g) => ({ org_id: g.orgId, role: g.role })),
            default_org_id: b.default_org_id,
          },
          ip: c.get("ip"),
        });
        return c.json({ redirect_to: out.redirect_to }, 200);
      } catch (e) {
        if (e instanceof OAuthError) throw e.status === 403 ? forbidden(e.message) : badRequest(e.message);
        throw e;
      }
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/oauth/connections",
      tags: ["OAuth"],
      summary: "Your connected AI clients",
      responses: { 200: json(z.object({ data: z.array(ConnectionSchema) })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      return c.json({ data: await oauthService(c.get("ctx")).connections({ userId: p.userId }) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/oauth/connections/{grantId}",
      tags: ["OAuth"],
      summary:
        "Disconnect a client: your own connection entirely, or, as an owner, its access to the orgs you own",
      request: { params: z.object({ grantId: z.string() }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const svc = oauthService(ctx);
      const g = await svc.getGrant(c.req.valid("param").grantId);
      if (!g) throw notFound("Connection");
      if (g.userId === p.userId) {
        await svc.revokeGrant(g.id);
        await instanceAudit(ctx.system, {
          userId: p.userId,
          action: "oauth.revoke",
          targetType: "oauth_grant",
          targetId: g.id,
          ip: c.get("ip"),
        });
        return c.json({ ok: true as const }, 200);
      }
      // Someone else's connection: an owner drops it from the orgs they own, and only those.
      const owned = [];
      for (const orgId of g.orgIds)
        if ((await ctx.orgs.membership(p.userId, orgId)) === "owner") owned.push(orgId);
      if (!owned.length) throw notFound("Connection");
      for (const orgId of owned) {
        await svc.revokeOrgGrant(g.id, orgId);
        await instanceAudit(ctx.system, {
          userId: p.userId,
          action: "oauth.revoke_org",
          targetType: "oauth_grant",
          targetId: g.id,
          detail: { org_id: orgId },
          ip: c.get("ip"),
        });
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/oauth/connections/{grantId}/orgs/{orgId}",
      tags: ["OAuth"],
      summary:
        "Remove one org from a connection (your own, or any connected to an org you own); its other orgs keep working",
      request: { params: z.object({ grantId: z.string(), orgId: z.string() }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const svc = oauthService(ctx);
      const { grantId, orgId } = c.req.valid("param");
      const g = await svc.getGrant(grantId);
      if (!g?.orgIds.includes(orgId)) throw notFound("Connection");
      if (g.userId !== p.userId && (await ctx.orgs.membership(p.userId, orgId)) !== "owner")
        throw notFound("Connection");
      await svc.revokeOrgGrant(g.id, orgId);
      await instanceAudit(ctx.system, {
        userId: p.userId,
        action: "oauth.revoke_org",
        targetType: "oauth_grant",
        targetId: g.id,
        detail: { org_id: orgId },
        ip: c.get("ip"),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/oauth/connections/{grantId}",
      tags: ["OAuth"],
      summary: "Change which of a connection's orgs its tools use by default (your own connection)",
      request: {
        params: z.object({ grantId: z.string() }),
        body: jsonBody(z.object({ default_org_id: z.string() })),
      },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const svc = oauthService(ctx);
      const g = await svc.getGrant(c.req.valid("param").grantId);
      if (!g || g.userId !== p.userId) throw notFound("Connection");
      const { default_org_id } = c.req.valid("json");
      if (!g.orgIds.includes(default_org_id))
        throw badRequest("The default organization must be one this connection covers.");
      await svc.setDefaultOrg(g.id, default_org_id);
      await instanceAudit(ctx.system, {
        userId: p.userId,
        action: "oauth.set_default_org",
        targetType: "oauth_grant",
        targetId: g.id,
        detail: { org_id: default_org_id },
        ip: c.get("ip"),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/oauth/connections",
      tags: ["OAuth"],
      summary: "All AI clients connected to this organization, each with only this org's grant (owner)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(ConnectionSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json({ data: await oauthService(c.get("ctx")).connections({ orgId: o.id }) }, 200);
    },
  );

  // ------------------------------------------------------------------ admin: manual clients
  const clientView = (x: Awaited<ReturnType<OAuthService["listClients"]>>[number]) => ({
    client_id: x.id,
    client_name: x.clientName,
    redirect_uris: JSON.parse(x.redirectUrisJson) as string[],
    registered_via: x.registeredVia,
    confidential: Boolean(x.clientSecretHash),
    created_at: x.createdAt,
    revoked_at: x.revokedAt,
  });

  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/oauth-clients",
      tags: ["Admin"],
      summary: "List OAuth clients (instance admin)",
      responses: { 200: json(z.object({ data: z.array(ClientSchema) })), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      return c.json({ data: (await oauthService(c.get("ctx")).listClients()).map(clientView) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/oauth-clients",
      tags: ["Admin"],
      summary: "Register a client manually; the secret is shown once (instance admin)",
      request: {
        body: jsonBody(
          z.object({
            client_name: z.string().min(1).max(100),
            redirect_uris: z.array(z.string()).min(1).max(10),
            confidential: z.boolean().default(true),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({
            client_id: z.string(),
            client_secret: z.string().nullable(),
            client_name: z.string(),
            redirect_uris: z.array(z.string()),
          }),
          "Created",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const b = c.req.valid("json");
      try {
        const out = await oauthService(ctx).registerClient({ ...b, via: "manual", createdBy: admin.userId });
        await instanceAudit(ctx.system, {
          userId: admin.userId,
          action: "oauth.client.create",
          targetType: "oauth_client",
          targetId: out.client_id,
          ip: c.get("ip"),
        });
        return c.json(out, 201);
      } catch (e) {
        if (e instanceof OAuthError) throw badRequest(e.message);
        throw e;
      }
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/admin/oauth-clients/{clientId}",
      tags: ["Admin"],
      summary: "Revoke a client and every token issued to it (instance admin)",
      request: { params: z.object({ clientId: z.string() }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const id = c.req.valid("param").clientId;
      if (!(await oauthService(ctx).getClient(id))) throw notFound("Client");
      await oauthService(ctx).revokeClient(id);
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "oauth.client.revoke",
        targetType: "oauth_client",
        targetId: id,
        ip: c.get("ip"),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
