import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hashToken } from "../../crypto.ts";
import { instanceAudit } from "../../services/instance-audit.ts";
import { AuthError } from "../../services/users.ts";
import { ApiError, badRequest, forbidden } from "../errors.ts";
import {
  CSRF_COOKIE,
  csrfFor,
  isSecure,
  rateLimit,
  requireAuth,
  requireSession,
  SESSION_COOKIE,
  tokenGrants,
} from "../middleware.ts";
import { errorResponses, json, jsonBody, newRouter, OkSchema, RoleSchema, z } from "../openapi.ts";
import type { AppEnv } from "../types.ts";

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    is_instance_admin: z.boolean(),
    totp_enabled: z.boolean(),
  })
  .openapi("User");

const SessionSchema = z
  .object({
    user: UserSchema.nullable(),
    orgs: z.array(z.object({ id: z.string(), name: z.string(), role: RoleSchema, is_sample: z.boolean() })),
    csrf_token: z.string().nullable(),
    auth_kind: z.enum(["session", "api_token", "oauth"]).nullable(),
    instance: z.object({ version: z.string(), signup_mode: z.string(), setup_required: z.boolean() }),
  })
  .openapi("Session");

export function authError(e: unknown): never {
  if (e instanceof AuthError) {
    const status =
      e.code === "email_taken"
        ? 409
        : ["invalid_credentials", "totp_required", "invalid_totp"].includes(e.code)
          ? 401
          : 400;
    throw new ApiError(status, e.code, e.message);
  }
  throw e;
}

async function startSession(c: Context<AppEnv>, userId: string) {
  const ctx = c.get("ctx");
  const { token, expiresAt } = await ctx.users.createSession(userId, {
    userAgent: c.req.header("user-agent"),
    ip: c.get("ip"),
  });
  const secure = isSecure(c);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
  const csrfToken = csrfFor(c, hashToken(token));
  setCookie(c, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
  return csrfToken;
}

async function sessionView(c: Context<AppEnv>, csrfOverride?: string, userIdOverride?: string) {
  const ctx = c.get("ctx");
  const p = c.get("principal");
  const userId = userIdOverride ?? p?.userId;
  const user = userId ? await ctx.users.byId(userId) : null;
  const orgs = user ? await ctx.orgs.listForUser(user.id) : [];
  const grants = p ? tokenGrants(p) : null;
  const scoped = grants ? orgs.filter((o) => grants.some((g) => g.orgId === o.id)) : orgs;
  return {
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          is_instance_admin: user.isInstanceAdmin,
          totp_enabled: user.totpEnabled,
        }
      : null,
    orgs: scoped.map((o) => ({ id: o.id, name: o.name, role: o.role, is_sample: o.isSample })),
    csrf_token:
      csrfOverride ?? (p?.kind === "session" && p.sessionTokenHash ? csrfFor(c, p.sessionTokenHash) : null),
    auth_kind: userIdOverride ? ("session" as const) : (p?.kind ?? null),
    instance: {
      version: ctx.version,
      signup_mode: await ctx.settings.get("signup_mode"),
      setup_required: (await ctx.users.count()) === 0,
    },
  };
}

export function authRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/auth/session",
      tags: ["Auth"],
      summary: "Current session, memberships, and CSRF token",
      responses: { 200: json(SessionSchema) },
    }),
    async (c) => {
      const view = await sessionView(c);
      if (view.csrf_token && getCookie(c, CSRF_COOKIE) !== view.csrf_token) {
        setCookie(c, CSRF_COOKIE, view.csrf_token, {
          httpOnly: false,
          secure: isSecure(c),
          sameSite: "Lax",
          path: "/",
        });
      }
      return c.json(view, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/login",
      tags: ["Auth"],
      summary: "Sign in with email and password (and TOTP code when enabled)",
      request: {
        body: jsonBody(
          z.object({
            email: z.string().email(),
            password: z.string().min(1),
            totp_code: z.string().optional(),
          }),
        ),
      },
      responses: { 200: json(SessionSchema), ...errorResponses },
    }),
    async (c) => {
      const body = c.req.valid("json");
      rateLimit(c, "login", 10, 60_000);
      rateLimit(c, "login-email", 20, 15 * 60_000, body.email.toLowerCase());
      const user = await c
        .get("ctx")
        .users.verifyLogin(body.email, body.password, body.totp_code)
        .catch(authError);
      const csrfToken = await startSession(c, user.id);
      return c.json(await sessionView(c, csrfToken, user.id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      tags: ["Auth"],
      summary: "Sign out",
      responses: { 200: json(OkSchema) },
    }),
    async (c) => {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) await c.get("ctx").users.deleteSession(cookie);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      deleteCookie(c, CSRF_COOKIE, { path: "/" });
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/auth/claim/{token}",
      tags: ["Auth"],
      summary: "Look up a claim or password reset link",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: json(
          z.object({ email: z.string(), name: z.string(), purpose: z.string(), expires_at: z.string() }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      rateLimit(c, "claim", 20, 60_000);
      const row = await c.get("ctx").users.peekClaimLink(c.req.valid("param").token);
      if (!row) throw new ApiError(404, "invalid_link", "This link is invalid, expired, or already used.");
      return c.json(
        {
          email: row.user.email,
          name: row.user.name,
          purpose: row.link.purpose,
          expires_at: row.link.expiresAt,
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/claim",
      tags: ["Auth"],
      summary: "Use a claim or password reset link to set a password, then sign in",
      request: {
        body: jsonBody(z.object({ token: z.string(), password: z.string(), name: z.string().optional() })),
      },
      responses: { 200: json(SessionSchema), ...errorResponses },
    }),
    async (c) => {
      rateLimit(c, "claim", 10, 60_000);
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const user = await ctx.users.consumeClaimLink(body.token, body.password).catch(authError);
      if (body.name) await ctx.users.update(user.id, { name: body.name });
      await instanceAudit(ctx.system, { userId: user.id, action: "user.claim", ip: c.get("ip") });
      const csrfToken = await startSession(c, user.id);
      return c.json(await sessionView(c, csrfToken, user.id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/password",
      tags: ["Auth"],
      summary: "Change your password",
      request: { body: jsonBody(z.object({ current_password: z.string(), new_password: z.string() })) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      rateLimit(c, "password", 10, 60_000);
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const user = await ctx.users.byId(p.userId);
      if (!user?.passwordHash || !(await Bun.password.verify(body.current_password, user.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "Current password is incorrect.");
      }
      await ctx.users.setPassword(p.userId, body.new_password).catch(authError);
      await startSession(c, p.userId);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/password-reset",
      tags: ["Auth"],
      summary: "Request a password reset email (always succeeds to avoid account enumeration)",
      request: { body: jsonBody(z.object({ email: z.string() })) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      rateLimit(c, "reset", 5, 15 * 60_000);
      const { email } = c.req.valid("json");
      const ctx = c.get("ctx");
      const user = await ctx.users.byEmail(email);
      const mailer = ctx.services.mailer as
        | { isConfigured(): Promise<boolean>; sendPasswordReset(to: string, link: string): Promise<void> }
        | undefined;
      if (user && !user.disabledAt && mailer && (await mailer.isConfigured())) {
        const { token } = await ctx.users.issueClaimLink(user.id, "password_reset", 2);
        await mailer
          .sendPasswordReset(user.email, `${ctx.config.server.public_url}/claim/${token}`)
          .catch((e) => ctx.logger.error("password reset email failed", { err: e }));
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/signup",
      tags: ["Auth"],
      summary: "Create an account (open signup mode only)",
      request: {
        body: jsonBody(z.object({ email: z.string().email(), password: z.string(), name: z.string() })),
      },
      responses: { 200: json(SessionSchema), ...errorResponses },
    }),
    async (c) => {
      rateLimit(c, "signup", 5, 15 * 60_000);
      const ctx = c.get("ctx");
      if ((await ctx.settings.get("signup_mode")) !== "open") throw forbidden("Public signup is disabled.");
      const body = c.req.valid("json");
      const user = await ctx.users.create(body).catch(authError);
      const csrfToken = await startSession(c, user.id);
      return c.json(await sessionView(c, csrfToken, user.id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/setup",
      tags: ["Auth"],
      summary: "Begin two-factor setup; returns the secret and otpauth URI",
      responses: { 200: json(z.object({ secret: z.string(), uri: z.string() })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const user = await c.get("ctx").users.byId(p.userId);
      if (user?.totpEnabled) throw badRequest("Two-factor authentication is already enabled.");
      return c.json(await c.get("ctx").users.beginTotp(p.userId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/enable",
      tags: ["Auth"],
      summary: "Confirm a TOTP code to enable two-factor; returns one-time recovery codes",
      request: { body: jsonBody(z.object({ code: z.string() })) },
      responses: { 200: json(z.object({ recovery_codes: z.array(z.string()) })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      rateLimit(c, "totp", 10, 60_000);
      const res = await c.get("ctx").users.enableTotp(p.userId, c.req.valid("json").code).catch(authError);
      return c.json({ recovery_codes: res.recoveryCodes }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/disable",
      tags: ["Auth"],
      summary: "Disable two-factor (requires a current code or recovery code)",
      request: { body: jsonBody(z.object({ code: z.string() })) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      rateLimit(c, "totp", 10, 60_000);
      const ctx = c.get("ctx");
      if (!(await ctx.users.checkSecondFactor(p.userId, c.req.valid("json").code))) {
        throw new ApiError(401, "invalid_totp", "Invalid two-factor code.");
      }
      await ctx.users.disableTotp(p.userId);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/auth/me",
      tags: ["Auth"],
      summary: "Update your profile",
      request: { body: jsonBody(z.object({ name: z.string().min(1).max(200) })) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireAuth(c);
      if (p.kind !== "session") throw forbidden();
      await c.get("ctx").users.update(p.userId, { name: c.req.valid("json").name });
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
