/**
 * OAuth 2.1 authorization server for AI clients (SPEC §10.4, MCP authorization spec).
 *
 * - Dynamic client registration (RFC 7591) unless an instance admin turns it off; admins can also
 *   register clients manually, which issues a client secret.
 * - Authorization code flow with PKCE (S256 only). Codes last 10 minutes and are single-use.
 * - Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use.
 * - A connection (one token pair) covers one or more orgs, each with a role capped at the user's own
 *   role there, and a default org the user picks on consent. Each org can be revoked on its own.
 *   OAuth callers act as the `mcp` actor and are always propose-only, so their writes go to the
 *   review queue.
 * - Codes, tokens, and client secrets are stored as SHA-256 hashes.
 * - Redirect URIs match exactly. `http://` is allowed only for loopback hosts (any port).
 */
import { createHash } from "node:crypto";
import { newId, type SystemDb, type SystemTx, system } from "@cosimo/db";
import { minRole, type Role, roleAtLeast } from "@cosimo/shared";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { hashToken, randomToken, safeEqual, TOKEN_PREFIX } from "../crypto.ts";
import type { Principal } from "../http/types.ts";

/** One org on a code or connection, with the role it was granted. */
export interface OrgRole {
  orgId: string;
  role: Role;
}

/**
 * The default org a connection actually uses: the stored one while it is still granted, otherwise
 * the only granted org, otherwise none (calls must then name an org).
 */
export function effectiveDefault(stored: string | null, orgIds: string[]): string | null {
  if (stored && orgIds.includes(stored)) return stored;
  return orgIds.length === 1 ? orgIds[0]! : null;
}

/** The orgs a connection still covers (not revoked), with their role caps. */
function activeOrgs(db: SystemDb | SystemTx, tokenId: string): Promise<OrgRole[]> {
  return db
    .select({ orgId: system.oauthTokenOrgs.orgId, role: system.oauthTokenOrgs.role })
    .from(system.oauthTokenOrgs)
    .where(and(eq(system.oauthTokenOrgs.tokenId, tokenId), isNull(system.oauthTokenOrgs.revokedAt)))
    .orderBy(asc(system.oauthTokenOrgs.createdAt), asc(system.oauthTokenOrgs.orgId))
    .all();
}

/**
 * Revoke one org's grant on these connections. A connection whose default it was loses its default,
 * and a connection left with no org is revoked outright.
 */
export async function revokeOrgGrantsTx(tx: SystemTx, tokenIds: string[], orgId: string) {
  if (!tokenIds.length) return;
  const now = new Date().toISOString();
  const t = system.oauthTokenOrgs;
  await tx
    .update(t)
    .set({ revokedAt: now })
    .where(and(inArray(t.tokenId, tokenIds), eq(t.orgId, orgId), isNull(t.revokedAt)));
  await tx
    .update(system.oauthTokens)
    .set({ defaultOrgId: null })
    .where(and(inArray(system.oauthTokens.id, tokenIds), eq(system.oauthTokens.defaultOrgId, orgId)));
  const left = await tx
    .select({ tokenId: t.tokenId })
    .from(t)
    .where(and(inArray(t.tokenId, tokenIds), isNull(t.revokedAt)))
    .all();
  const keep = new Set(left.map((r) => r.tokenId));
  const empty = tokenIds.filter((id) => !keep.has(id));
  if (empty.length)
    await tx
      .update(system.oauthTokens)
      .set({ revokedAt: now })
      .where(and(inArray(system.oauthTokens.id, empty), isNull(system.oauthTokens.revokedAt)));
}

/** Revoke a user's grants for one org on every connection (the user left the org). */
export async function revokeUserOrgGrantsTx(tx: SystemTx, userId: string, orgId: string) {
  const rows = await tx
    .select({ id: system.oauthTokens.id })
    .from(system.oauthTokens)
    .innerJoin(system.oauthTokenOrgs, eq(system.oauthTokenOrgs.tokenId, system.oauthTokens.id))
    .where(
      and(
        eq(system.oauthTokens.userId, userId),
        eq(system.oauthTokenOrgs.orgId, orgId),
        isNull(system.oauthTokenOrgs.revokedAt),
      ),
    )
    .all();
  await revokeOrgGrantsTx(
    tx,
    rows.map((r) => r.id),
    orgId,
  );
}

/** Remove every OAuth reference to an org that is being deleted. */
export async function forgetOrgTx(tx: SystemTx, orgId: string) {
  const rows = await tx
    .select({ id: system.oauthTokenOrgs.tokenId })
    .from(system.oauthTokenOrgs)
    .where(eq(system.oauthTokenOrgs.orgId, orgId))
    .all();
  await revokeOrgGrantsTx(
    tx,
    rows.map((r) => r.id),
    orgId,
  );
  await tx.delete(system.oauthTokenOrgs).where(eq(system.oauthTokenOrgs.orgId, orgId));
  await tx
    .update(system.oauthTokens)
    .set({ defaultOrgId: null })
    .where(eq(system.oauthTokens.defaultOrgId, orgId));
  await tx.delete(system.oauthCodeOrgs).where(eq(system.oauthCodeOrgs.orgId, orgId));
  await tx
    .update(system.oauthCodes)
    .set({ defaultOrgId: null })
    .where(eq(system.oauthCodes.defaultOrgId, orgId));
}

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
export const CODE_TTL_S = 600;
export const OAUTH_SCOPE = "books";

/** RFC 6749 error, rendered as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status: 400 | 401 | 403 = 400,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A redirect URI must be absolute, https (or http on loopback), and have no fragment. */
export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  // Native apps may use private-use schemes (RFC 8252 §7.1), e.g. com.example.app:/callback.
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !LOOPBACK.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (
        u.protocol === "http:" &&
        u.hostname === g.hostname &&
        u.pathname === g.pathname &&
        u.search === g.search
      );
    } catch {
      return false;
    }
  });
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export class OAuthService {
  constructor(private ctx: AppContext) {}

  get issuer() {
    return this.ctx.config.server.public_url.replace(/\/$/, "");
  }
  get resource() {
    return `${this.issuer}/mcp`;
  }

  // -------------------------------------------------------------------------- clients

  async registerClient(input: {
    client_name?: string;
    redirect_uris?: unknown;
    via: "dynamic" | "manual";
    createdBy?: string | null;
    confidential?: boolean;
  }) {
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
    if (!uris.length) throw new OAuthError("invalid_redirect_uri", "At least one redirect_uri is required.");
    if (uris.length > 10) throw new OAuthError("invalid_redirect_uri", "Too many redirect URIs.");
    for (const u of uris)
      if (!validRedirectUri(u))
        throw new OAuthError(
          "invalid_redirect_uri",
          `Redirect URI ${u} must use https (http is allowed only for localhost) and have no fragment.`,
        );
    const name = (input.client_name ?? "").trim().slice(0, 100) || "Unnamed client";
    const id = `cosimo_oci_${newId().toLowerCase()}`;
    const secret = input.confidential ? randomToken(TOKEN_PREFIX.clientSecret) : null;
    await this.ctx.system.write((tx) =>
      tx.insert(system.oauthClients).values({
        id,
        clientName: name,
        redirectUrisJson: JSON.stringify(uris),
        registeredVia: input.via,
        clientSecretHash: secret ? hashToken(secret) : null,
        createdBy: input.createdBy ?? null,
      }),
    );
    return { client_id: id, client_secret: secret, client_name: name, redirect_uris: uris };
  }

  async getClient(id: string) {
    const c = await this.ctx.system.db
      .select()
      .from(system.oauthClients)
      .where(eq(system.oauthClients.id, id))
      .get();
    if (!c || c.revokedAt) return null;
    return { ...c, redirectUris: JSON.parse(c.redirectUrisJson) as string[] };
  }

  listClients() {
    return this.ctx.system.db
      .select()
      .from(system.oauthClients)
      .orderBy(desc(system.oauthClients.createdAt))
      .all();
  }

  async revokeClient(id: string) {
    const now = new Date().toISOString();
    await this.ctx.system.write(async (tx) => {
      await tx.update(system.oauthClients).set({ revokedAt: now }).where(eq(system.oauthClients.id, id));
      await tx
        .update(system.oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(system.oauthTokens.clientId, id), isNull(system.oauthTokens.revokedAt)));
    });
  }

  // -------------------------------------------------------------------------- authorize

  /**
   * Validate an authorization request. Client and redirect problems throw with `redirect: false`
   * (never redirect to an unverified URI); other problems are reported to the redirect URI.
   */
  async checkAuthorize(q: AuthorizeRequest) {
    const client = q.client_id ? await this.getClient(q.client_id) : null;
    if (!client)
      return { ok: false as const, redirect: false, error: "invalid_client", message: "Unknown client." };
    if (!q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri))
      return {
        ok: false as const,
        redirect: false,
        error: "invalid_request",
        message: "The redirect URI does not match the one registered for this client.",
      };
    const fail = (error: string, message: string) => ({
      ok: false as const,
      redirect: true,
      error,
      message,
      client,
    });
    if (q.response_type !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!q.code_challenge || q.code_challenge_method !== "S256")
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge))
      return fail("invalid_request", "code_challenge must be a base64url SHA-256 value.");
    if (
      q.resource &&
      q.resource.replace(/\/$/, "") !== this.resource &&
      q.resource.replace(/\/$/, "") !== this.issuer
    )
      return fail("invalid_target", `Unknown resource. Use ${this.resource}.`);
    return { ok: true as const, client };
  }

  errorRedirect(redirectUri: string, error: string, message: string, state?: string) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", message);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.issuer);
    return u.toString();
  }

  /**
   * The signed-in user approved: issue one code covering every org they checked, each with a role
   * capped at theirs, and the default org they picked (which must be one of those orgs).
   */
  async approve(q: AuthorizeRequest, userId: string, requested: OrgRole[], defaultOrgId: string) {
    const check = await this.checkAuthorize(q);
    if (!check.ok) throw new OAuthError(check.error, check.message);
    if (!requested.length) throw new OAuthError("invalid_request", "Pick at least one organization.");
    if (new Set(requested.map((r) => r.orgId)).size !== requested.length)
      throw new OAuthError("invalid_request", "Each organization can be listed only once.");
    if (!requested.some((r) => r.orgId === defaultOrgId))
      throw new OAuthError(
        "invalid_request",
        "The default organization must be one of the organizations you picked.",
      );
    const grants: OrgRole[] = [];
    for (const r of requested) {
      const member = await this.ctx.orgs.membership(userId, r.orgId);
      if (!member) throw new OAuthError("access_denied", "You are not a member of that organization.", 403);
      grants.push({ orgId: r.orgId, role: minRole(r.role, member) });
    }
    const code = randomToken(TOKEN_PREFIX.oauthCode);
    const codeHash = hashToken(code);
    await this.ctx.system.write(async (tx) => {
      await tx.insert(system.oauthCodes).values({
        codeHash,
        clientId: q.client_id,
        userId,
        defaultOrgId,
        scope: OAUTH_SCOPE,
        codeChallenge: q.code_challenge!,
        redirectUri: q.redirect_uri,
        resource: q.resource ?? null,
        expiresAt: iso(CODE_TTL_S * 1000),
      });
      await tx.insert(system.oauthCodeOrgs).values(grants.map((g) => ({ codeHash, ...g })));
    });
    const u = new URL(q.redirect_uri);
    u.searchParams.set("code", code);
    if (q.state) u.searchParams.set("state", q.state);
    u.searchParams.set("iss", this.issuer);
    return { redirect_to: u.toString(), grants };
  }

  // -------------------------------------------------------------------------- token

  private async authenticateClient(clientId: string, secret: string | null) {
    const client = await this.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown or revoked client.", 401);
    if (client.clientSecretHash) {
      if (!secret || !safeEqual(hashToken(secret), client.clientSecretHash))
        throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return client;
  }

  /** Fresh tokens for an existing connection (`{ id }`), or a new connection covering `conn.orgs`. */
  private async issue(
    tx: SystemTx,
    scope: string,
    conn: { id: string } | { clientId: string; userId: string; defaultOrgId: string | null; orgs: OrgRole[] },
  ) {
    const access = randomToken(TOKEN_PREFIX.oauthAccess);
    const refresh = randomToken(TOKEN_PREFIX.oauthRefresh);
    const values = {
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      accessExpiresAt: iso(ACCESS_TTL_S * 1000),
      refreshExpiresAt: iso(REFRESH_TTL_S * 1000),
    };
    if ("id" in conn) {
      await tx.update(system.oauthTokens).set(values).where(eq(system.oauthTokens.id, conn.id));
    } else {
      const { orgs, ...rest } = conn;
      const id = newId();
      await tx.insert(system.oauthTokens).values({ id, ...rest, scope, ...values });
      await tx.insert(system.oauthTokenOrgs).values(orgs.map((o) => ({ tokenId: id, ...o })));
    }
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope,
    };
  }

  async exchangeCode(p: {
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    client_secret?: string | null;
    code_verifier?: string;
  }) {
    if (!p.code || !p.client_id || !p.code_verifier || !p.redirect_uri)
      throw new OAuthError(
        "invalid_request",
        "code, client_id, redirect_uri and code_verifier are required.",
      );
    await this.authenticateClient(p.client_id, p.client_secret ?? null);
    const h = hashToken(p.code);
    const out = await this.ctx.system.write(async (tx) => {
      const row = await tx.select().from(system.oauthCodes).where(eq(system.oauthCodes.codeHash, h)).get();
      if (!row || row.clientId !== p.client_id)
        throw new OAuthError("invalid_grant", "The authorization code is invalid.");
      const codeOrgs = await tx
        .select({ orgId: system.oauthCodeOrgs.orgId, role: system.oauthCodeOrgs.role })
        .from(system.oauthCodeOrgs)
        .where(eq(system.oauthCodeOrgs.codeHash, h))
        .all();
      if (row.usedAt) {
        // A replayed code: revoke whatever it produced (RFC 6749 §4.1.2): connections for this
        // client and user, issued since the code was, that cover any of the code's orgs.
        const produced = codeOrgs.length
          ? await tx
              .selectDistinct({ id: system.oauthTokens.id })
              .from(system.oauthTokens)
              .innerJoin(system.oauthTokenOrgs, eq(system.oauthTokenOrgs.tokenId, system.oauthTokens.id))
              .where(
                and(
                  eq(system.oauthTokens.clientId, row.clientId),
                  eq(system.oauthTokens.userId, row.userId),
                  inArray(
                    system.oauthTokenOrgs.orgId,
                    codeOrgs.map((o) => o.orgId),
                  ),
                  gt(
                    system.oauthTokens.createdAt,
                    new Date(Date.parse(row.expiresAt) - CODE_TTL_S * 1000).toISOString(),
                  ),
                ),
              )
              .all()
          : [];
        if (produced.length)
          await tx
            .update(system.oauthTokens)
            .set({ revokedAt: new Date().toISOString() })
            .where(
              inArray(
                system.oauthTokens.id,
                produced.map((t) => t.id),
              ),
            );
        // Commit the revocation, then report the error (throwing here would roll it back).
        return null;
      }
      if (Date.parse(row.expiresAt) < Date.now())
        throw new OAuthError("invalid_grant", "The authorization code expired.");
      if (row.redirectUri !== p.redirect_uri)
        throw new OAuthError("invalid_grant", "redirect_uri does not match.");
      if (!safeEqual(pkceChallenge(p.code_verifier!), row.codeChallenge))
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      await tx
        .update(system.oauthCodes)
        .set({ usedAt: new Date().toISOString() })
        .where(eq(system.oauthCodes.codeHash, h));
      // An org the user left since consenting is dropped; the rest still connect.
      const orgs: OrgRole[] = [];
      for (const o of codeOrgs) {
        const member = await this.ctx.orgs.membership(row.userId, o.orgId);
        if (member) orgs.push({ orgId: o.orgId, role: minRole(o.role, member) });
      }
      if (!orgs.length)
        throw new OAuthError(
          "invalid_grant",
          "The user is no longer a member of any of those organizations.",
        );
      return this.issue(tx, row.scope, {
        clientId: row.clientId,
        userId: row.userId,
        defaultOrgId: orgs.some((o) => o.orgId === row.defaultOrgId) ? row.defaultOrgId : null,
        orgs,
      });
    });
    if (!out) throw new OAuthError("invalid_grant", "The authorization code was already used.");
    return out;
  }

  async refresh(p: { refresh_token?: string; client_id?: string; client_secret?: string | null }) {
    if (!p.refresh_token || !p.client_id)
      throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
    await this.authenticateClient(p.client_id, p.client_secret ?? null);
    const h = hashToken(p.refresh_token);
    const out = await this.ctx.system.write(async (tx) => {
      const row = await tx
        .select()
        .from(system.oauthTokens)
        .where(eq(system.oauthTokens.refreshTokenHash, h))
        .get();
      if (!row || row.clientId !== p.client_id || row.revokedAt)
        throw new OAuthError("invalid_grant", "The refresh token is invalid or was revoked.");
      if (!row.refreshExpiresAt || Date.parse(row.refreshExpiresAt) < Date.now())
        throw new OAuthError("invalid_grant", "The refresh token expired. Connect again.");
      // Orgs the user has left are dropped from the connection; the rest keep working.
      let left = 0;
      for (const g of await activeOrgs(tx, row.id)) {
        if (await this.ctx.orgs.membership(row.userId, g.orgId)) left++;
        else await revokeOrgGrantsTx(tx, [row.id], g.orgId);
      }
      // Commit the drops (the connection is revoked once none is left), then report the error.
      if (!left) return null;
      return this.issue(tx, row.scope, { id: row.id });
    });
    if (!out)
      throw new OAuthError(
        "invalid_grant",
        "The user is no longer a member of any organization on this connection. Connect again.",
      );
    return out;
  }

  /** RFC 7009: revoke by access or refresh token. Unknown tokens are not an error. */
  async revokeToken(token: string, clientId?: string) {
    const h = hashToken(token);
    const col = token.startsWith(TOKEN_PREFIX.oauthRefresh)
      ? system.oauthTokens.refreshTokenHash
      : system.oauthTokens.accessTokenHash;
    await this.ctx.system.write(async (tx) => {
      const row = await tx.select().from(system.oauthTokens).where(eq(col, h)).get();
      if (!row || (clientId && row.clientId !== clientId)) return;
      await tx
        .update(system.oauthTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(system.oauthTokens.id, row.id));
    });
  }

  // -------------------------------------------------------------------------- resource server

  async resolveAccessToken(token: string): Promise<Principal | null> {
    const row = await this.ctx.system.db
      .select({ t: system.oauthTokens, u: system.users, c: system.oauthClients })
      .from(system.oauthTokens)
      .innerJoin(system.users, eq(system.users.id, system.oauthTokens.userId))
      .innerJoin(system.oauthClients, eq(system.oauthClients.id, system.oauthTokens.clientId))
      .where(eq(system.oauthTokens.accessTokenHash, hashToken(token)))
      .get();
    if (!row || row.t.revokedAt || row.c.revokedAt || row.u.disabledAt) return null;
    if (Date.parse(row.t.accessExpiresAt) < Date.now()) return null;
    const last = row.t.lastUsedAt ? Date.parse(row.t.lastUsedAt) : 0;
    if (Date.now() - last > 60_000)
      await this.ctx.system.write((tx) =>
        tx
          .update(system.oauthTokens)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(system.oauthTokens.id, row.t.id)),
      );
    // Only orgs still granted; a connection with none left is dead.
    const orgs = await activeOrgs(this.ctx.system.db, row.t.id);
    if (!orgs.length) return null;
    return {
      kind: "oauth",
      userId: row.u.id,
      email: row.u.email,
      name: row.u.name,
      isInstanceAdmin: false,
      oauthTokenId: row.t.id,
      oauthClientId: row.c.id,
      orgGrants: orgs.map((o) => ({ orgId: o.orgId, roleCap: o.role })),
      defaultOrgId: effectiveDefault(
        row.t.defaultOrgId,
        orgs.map((o) => o.orgId),
      ),
      proposeOnly: true,
    };
  }

  // -------------------------------------------------------------------------- connections

  /**
   * Live connections, each with its granted orgs: a user's own list, or an owner's view of one org
   * (which shows only that org's grant, not the user's other orgs).
   */
  async connections(filter: { userId?: string; orgId?: string }) {
    const conds = [
      isNull(system.oauthTokens.revokedAt),
      gt(system.oauthTokens.refreshExpiresAt, new Date().toISOString()),
      isNull(system.oauthClients.revokedAt),
    ];
    if (filter.userId) conds.push(eq(system.oauthTokens.userId, filter.userId));
    const rows = await this.ctx.system.db
      .select({ t: system.oauthTokens, c: system.oauthClients, u: system.users })
      .from(system.oauthTokens)
      .innerJoin(system.oauthClients, eq(system.oauthClients.id, system.oauthTokens.clientId))
      .innerJoin(system.users, eq(system.users.id, system.oauthTokens.userId))
      .where(and(...conds))
      .orderBy(desc(system.oauthTokens.createdAt))
      .all();
    if (!rows.length) return [];
    const gconds = [
      inArray(
        system.oauthTokenOrgs.tokenId,
        rows.map((r) => r.t.id),
      ),
      isNull(system.oauthTokenOrgs.revokedAt),
    ];
    if (filter.orgId) gconds.push(eq(system.oauthTokenOrgs.orgId, filter.orgId));
    const grants = await this.ctx.system.db
      .select({ g: system.oauthTokenOrgs, o: system.organizations })
      .from(system.oauthTokenOrgs)
      .innerJoin(system.organizations, eq(system.organizations.id, system.oauthTokenOrgs.orgId))
      .where(and(...gconds))
      .orderBy(asc(system.organizations.name))
      .all();
    const byToken = new Map<string, typeof grants>();
    for (const g of grants) byToken.set(g.g.tokenId, [...(byToken.get(g.g.tokenId) ?? []), g]);
    return rows
      .filter((r) => byToken.has(r.t.id))
      .map((r) => {
        const orgs = byToken.get(r.t.id)!;
        // An owner's view of one org doesn't reveal the user's other orgs, so no default either.
        const defaultOrgId = filter.orgId
          ? null
          : effectiveDefault(
              r.t.defaultOrgId,
              orgs.map((g) => g.g.orgId),
            );
        return {
          id: r.t.id,
          client_id: r.c.id,
          client_name: r.c.clientName,
          user_id: r.u.id,
          user_email: r.u.email,
          default_org_id: defaultOrgId,
          orgs: orgs.map((g) => ({
            org_id: g.o.id,
            org_name: g.o.name,
            role: g.g.role,
            granted_at: g.g.createdAt,
          })),
          created_at: r.t.createdAt,
          last_used_at: r.t.lastUsedAt,
        };
      });
  }

  /** A connection and the orgs it still covers. */
  async getGrant(id: string) {
    const t = await this.ctx.system.db
      .select()
      .from(system.oauthTokens)
      .where(eq(system.oauthTokens.id, id))
      .get();
    if (!t || t.revokedAt) return null;
    return { ...t, orgIds: (await activeOrgs(this.ctx.system.db, id)).map((o) => o.orgId) };
  }

  /** Disconnect the whole connection: every org on it. */
  async revokeGrant(id: string) {
    await this.ctx.system.write((tx) =>
      tx
        .update(system.oauthTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(system.oauthTokens.id, id)),
    );
  }

  /** Drop one org from a connection; the other orgs keep working. */
  async revokeOrgGrant(id: string, orgId: string) {
    await this.ctx.system.write((tx) => revokeOrgGrantsTx(tx, [id], orgId));
  }

  /** The user picks which granted org tools use when a call names none. */
  async setDefaultOrg(id: string, orgId: string) {
    await this.ctx.system.write((tx) =>
      tx.update(system.oauthTokens).set({ defaultOrgId: orgId }).where(eq(system.oauthTokens.id, id)),
    );
  }

  /** Roles a user may grant for an org: at most their own. */
  static grantableRoles(member: Role): Role[] {
    return (["owner", "bookkeeper", "accountant", "viewer"] as Role[]).filter((r) => roleAtLeast(member, r));
  }
}
