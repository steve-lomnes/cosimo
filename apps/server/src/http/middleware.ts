import { minRole, type Role, roleAtLeast } from "@cosimo/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { hashToken, safeEqual, TOKEN_PREFIX } from "../crypto.ts";
import type { ActorInfo } from "../services/actor.ts";
import { ApiError, forbidden, notFound, tooMany, unauthorized } from "./errors.ts";
import type { AppEnv, OrgGrant, OrgScope, Principal } from "./types.ts";

export const SESSION_COOKIE = "cosimo_session";
export const CSRF_COOKIE = "cosimo_csrf";
export const CSRF_HEADER = "x-csrf-token";

type C = Context<AppEnv>;

export function clientIp(c: C): string {
  const ctx = c.get("ctx");
  if (ctx.config.server.trust_proxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  const env = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  try {
    return env?.requestIP?.(c.req.raw)?.address ?? "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

export function csrfFor(c: C, sessionTokenHash: string): string {
  return c.get("ctx").secrets.hmac(`csrf:${sessionTokenHash}`);
}

export function isSecure(c: C): boolean {
  return c.get("ctx").config.server.public_url.startsWith("https://");
}

/** Resolve the caller from a bearer token or session cookie. Never throws for anonymous requests. */
export const resolvePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get("ctx");
  c.set("ip", clientIp(c));
  let principal: Principal | null = null;
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token.startsWith(TOKEN_PREFIX.api)) {
      const row = await ctx.users.resolveApiToken(token);
      if (!row) throw unauthorized("Invalid or revoked API token.", "invalid_token");
      principal = {
        kind: "api_token",
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        isInstanceAdmin: false,
        apiTokenId: row.token.id,
        orgId: row.token.orgId,
        roleCap: row.token.role,
        proposeOnly: row.token.proposeOnly,
      };
    } else if (token.startsWith(TOKEN_PREFIX.oauthAccess)) {
      const oauth = ctx.services.oauth as
        | { resolveAccessToken(t: string): Promise<Principal | null> }
        | undefined;
      principal = (await oauth?.resolveAccessToken(token)) ?? null;
      if (!principal) throw unauthorized("Invalid or expired access token.", "invalid_token");
      // OAuth grants are for AI assistants: they write only through MCP, where every write is a
      // proposal. Through the REST API they can read.
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase()))
        throw forbidden(
          "OAuth access tokens can only read through the REST API; make changes through the MCP tools.",
        );
    } else {
      throw unauthorized("Unrecognized bearer token.", "invalid_token");
    }
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const row = await ctx.users.resolveSession(cookie);
      if (row) {
        principal = {
          kind: "session",
          userId: row.user.id,
          email: row.user.email,
          name: row.user.name,
          isInstanceAdmin: row.user.isInstanceAdmin,
          sessionTokenHash: hashToken(cookie),
        };
      }
    }
  }
  c.set("principal", principal);
  await next();
};

/** CSRF protection for cookie-authenticated, state-changing requests. */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.get("principal");
  const method = c.req.method.toUpperCase();
  if (p?.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const header = c.req.header(CSRF_HEADER) ?? "";
    const expected = csrfFor(c, p.sessionTokenHash!);
    if (!header || !safeEqual(header, expected)) {
      throw new ApiError(403, "csrf_failed", "Missing or invalid CSRF token.");
    }
  }
  await next();
};

export function requireAuth(c: C): Principal {
  const p = c.get("principal");
  if (!p) throw unauthorized();
  return p;
}

export function requireSession(c: C): Principal {
  const p = requireAuth(c);
  if (p.kind !== "session") throw forbidden("This action requires a signed-in browser session.");
  return p;
}

export function requireAdmin(c: C): Principal {
  const p = requireSession(c);
  if (!p.isInstanceAdmin) throw forbidden("Instance admin only.");
  return p;
}

export function rateLimit(c: C, bucket: string, limit: number, windowMs: number, extraKey = "") {
  const wait = c.get("ctx").rateLimiter.hit(`${bucket}:${c.get("ip")}:${extraKey}`, limit, windowMs);
  if (wait > 0) {
    c.header("retry-after", String(wait));
    throw tooMany(wait);
  }
}

/**
 * The orgs a bearer token may reach, each with its role cap, or null for a browser session (no limit
 * beyond membership). An API token covers its one org; an OAuth connection covers its granted orgs.
 */
export function tokenGrants(p: Principal): OrgGrant[] | null {
  if (p.orgGrants) return p.orgGrants;
  if (p.orgId) return [{ orgId: p.orgId, roleCap: p.roleCap ?? "viewer" }];
  return null;
}

/** Resolve org membership and effective role for /api/v1/orgs/:orgId/* routes. */
export const orgScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get("ctx");
  const p = requireAuth(c);
  const orgId = c.req.param("orgId");
  if (!orgId) throw notFound("Organization");
  const grants = tokenGrants(p);
  const grant = grants?.find((g) => g.orgId === orgId);
  if (grants && !grant) throw forbidden("This token is not valid for that organization.");
  const membershipRole = await ctx.orgs.membership(p.userId, orgId);
  if (!membershipRole) throw notFound("Organization");
  const handle = await ctx.orgs.open(orgId);
  if (!handle) throw notFound("Organization");
  const role: Role = grant ? minRole(grant.roleCap, membershipRole) : membershipRole;
  const actor: ActorInfo = {
    actor: p.kind === "session" ? "user" : p.kind === "oauth" ? "mcp" : "api_token",
    role,
    userId: p.userId,
    apiTokenId: p.apiTokenId ?? null,
    oauthClientId: p.oauthClientId ?? null,
    ip: c.get("ip"),
    proposeOnly: p.kind === "oauth" ? true : (p.proposeOnly ?? false),
    displayName: p.name || p.email,
  };
  const scope: OrgScope = { id: orgId, handle, role, actor };
  c.set("org", scope);
  await next();
};

export function requireRole(c: C, min: Role): OrgScope {
  const o = c.get("org");
  if (!roleAtLeast(o.role, min)) throw forbidden(`Requires the ${min} role or higher.`);
  return o;
}

/** Roles allowed to change books data. Accountants and viewers are read-only. */
export function requireWriter(c: C): OrgScope {
  const o = c.get("org");
  if (o.role !== "owner" && o.role !== "bookkeeper")
    throw forbidden("Your role is read-only in this organization.");
  return o;
}

export function requireOwner(c: C): OrgScope {
  const o = c.get("org");
  if (o.role !== "owner") throw forbidden("Only owners can do that.");
  return o;
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const path = c.req.path;
    const h = c.res.headers;
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("cross-origin-opener-policy", "same-origin");
    if (!h.has("content-security-policy")) {
      const docs = path.startsWith("/api/docs");
      h.set(
        "content-security-policy",
        [
          "default-src 'self'",
          docs
            ? "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
            : "script-src 'self' https://cdn.plaid.com",
          "style-src 'self' 'unsafe-inline'" +
            (docs ? " https://cdn.jsdelivr.net https://fonts.googleapis.com" : ""),
          "img-src 'self' data: blob:",
          `font-src 'self' data:${docs ? " https://fonts.gstatic.com https://cdn.jsdelivr.net" : ""}`,
          "connect-src 'self' https://*.plaid.com",
          "frame-src https://cdn.plaid.com https://*.plaid.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join("; "),
      );
    }
    if (isSecure(c)) h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  };
}
