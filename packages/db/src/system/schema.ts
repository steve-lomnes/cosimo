import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name").notNull().default(""),
  isInstanceAdmin: integer("is_instance_admin", { mode: "boolean" }).notNull().default(false),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  recoveryCodesJson: text("recovery_codes_json"),
  createdAt: text("created_at").notNull().default(now),
  disabledAt: text("disabled_at"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the session cookie value; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    /** set when the password step succeeded but TOTP is still required */
    pendingTotp: integer("pending_totp", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role", { enum: ["owner", "bookkeeper", "accountant", "viewer"] }).notNull(),
    proposeOnly: integer("propose_only", { mode: "boolean" }).notNull().default(false),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().default(now),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  dbUrl: text("db_url").notNull(),
  dbTokenEnc: text("db_token_enc"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull().default(now),
  archivedAt: text("archived_at"),
  isSample: integer("is_sample", { mode: "boolean" }).notNull().default(false),
});

export const memberships = sqliteTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    role: text("role", { enum: ["owner", "bookkeeper", "accountant", "viewer"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgId] }), index("memberships_org_idx").on(t.orgId)],
);

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id),
  email: text("email").notNull(),
  role: text("role", { enum: ["owner", "bookkeeper", "accountant", "viewer"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").notNull(),
  expiresAt: text("expires_at").notNull(),
  acceptedAt: text("accepted_at"),
  createdAt: text("created_at").notNull().default(now),
});

export const claimLinks = sqliteTable("claim_links", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  purpose: text("purpose", { enum: ["claim", "password_reset"] })
    .notNull()
    .default("claim"),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(now),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  registeredVia: text("registered_via", { enum: ["dynamic", "manual"] }).notNull(),
  clientSecretHash: text("client_secret_hash"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull().default(now),
  revokedAt: text("revoked_at"),
});

export const oauthCodes = sqliteTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  /** The org that tools use when a call names none; one of the code's orgs. */
  defaultOrgId: text("default_org_id").references(() => organizations.id),
  scope: text("scope").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource"),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** The org that tools use when a call names none. Null when the user removed it and has more than one left. */
    defaultOrgId: text("default_org_id").references(() => organizations.id),
    scope: text("scope").notNull(),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    accessExpiresAt: text("access_expires_at").notNull(),
    refreshExpiresAt: text("refresh_expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().default(now),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("oauth_tokens_user_idx").on(t.userId)],
);

/** The orgs one authorization code covers, each with the role the user granted. */
export const oauthCodeOrgs = sqliteTable(
  "oauth_code_orgs",
  {
    codeHash: text("code_hash")
      .notNull()
      .references(() => oauthCodes.codeHash),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    role: text("role", { enum: ["owner", "bookkeeper", "accountant", "viewer"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.codeHash, t.orgId] })],
);

/**
 * The orgs one connection (token pair) covers, each with a role cap. Each org can be revoked on its
 * own; the connection stops working once none is left.
 */
export const oauthTokenOrgs = sqliteTable(
  "oauth_token_orgs",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => oauthTokens.id),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    role: text("role", { enum: ["owner", "bookkeeper", "accountant", "viewer"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
    revokedAt: text("revoked_at"),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.orgId] }), index("oauth_token_orgs_org_idx").on(t.orgId)],
);

export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

/** Instance-level events that do not belong to one org (user created, admin changes). */
export const instanceAudit = sqliteTable("instance_audit", {
  id: text("id").primaryKey(),
  at: text("at").notNull().default(now),
  userId: text("user_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detailJson: text("detail_json"),
  ip: text("ip"),
});

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    principal: text("principal").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    responseBody: text("response_body"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.principal, t.key] })],
);

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    orgId: text("org_id"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
    detail: text("detail"),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.startedAt)],
);
