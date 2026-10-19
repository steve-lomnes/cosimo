import { newId, org, system } from "@cosimo/db";
import { COA_TEMPLATES, defaultTemplateForEntity, ENTITY_TYPES, type Role, roleRank } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { hashToken, randomToken } from "../../crypto.ts";
import { appendAudit } from "../../services/audit.ts";
import { instanceAudit } from "../../services/instance-audit.ts";
import { revokeUserOrgGrantsTx } from "../../services/oauth.ts";
import { stripeOptions } from "../../services/payment-providers/index.ts";
import { verifyPlaidKeys } from "../../services/plaid.ts";
import { loadSampleData } from "../../services/sample-data.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { rateLimit, requireAuth, requireOwner, requireSession, tokenGrants } from "../middleware.ts";
import {
  bearerSecurity,
  errorResponses,
  Id,
  IsoDate,
  json,
  jsonBody,
  newRouter,
  OkSchema,
  OrgParams,
  RoleSchema,
  z,
} from "../openapi.ts";
import { authError } from "./auth.ts";

export const OrgSettingsSchema = z
  .object({
    org_id: z.string(),
    legal_name: z.string(),
    dba: z.string().nullable(),
    entity_type: z.string(),
    tax_id_last4: z.string().nullable(),
    address: z.record(z.string(), z.string()).nullable(),
    base_currency: z.string(),
    fiscal_year_start_month: z.number().int(),
    default_basis: z.enum(["cash", "accrual"]),
    books_start_date: z.string().nullable(),
    soft_lock_date: z.string().nullable(),
    hard_lock_date: z.string().nullable(),
    invoice_prefix: z.string(),
    next_invoice_number: z.number().int(),
    logo_attachment_id: z.string().nullable(),
    review_threshold: z.number().int(),
    invoice_color: z.string(),
    payment_instructions: z.string().nullable(),
    default_terms: z.string(),
    reminders_enabled: z.boolean(),
    plaid_override: z.boolean(),
    plaid_env: z.enum(["sandbox", "production"]).nullable(),
    payment_provider: z
      .enum(["off", "manual_link", "stripe"])
      .describe("Online invoice payments: off, a payment link entered per invoice, or Stripe."),
    online_pay_default: z.boolean().describe("New invoices accept online payment unless turned off."),
    payment_livemode: z.boolean().nullable().describe("With Stripe: false while using a test-mode key."),
  })
  .openapi("OrgSettings");

const OrgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: RoleSchema,
    is_sample: z.boolean(),
    settings: OrgSettingsSchema,
  })
  .openapi("Org");

export function settingsView(s: typeof org.orgSettings.$inferSelect) {
  return {
    org_id: s.orgId,
    legal_name: s.legalName,
    dba: s.dba,
    entity_type: s.entityType,
    tax_id_last4: s.taxIdLast4,
    address: s.addressJson ? (JSON.parse(s.addressJson) as Record<string, string>) : null,
    base_currency: s.baseCurrency,
    fiscal_year_start_month: s.fiscalYearStartMonth,
    default_basis: s.defaultBasis,
    books_start_date: s.booksStartDate,
    soft_lock_date: s.softLockDate,
    hard_lock_date: s.hardLockDate,
    invoice_prefix: s.invoicePrefix,
    next_invoice_number: s.nextInvoiceNumber,
    logo_attachment_id: s.logoAttachmentId,
    review_threshold: s.reviewThreshold,
    invoice_color: s.invoiceColor,
    payment_instructions: s.paymentInstructions,
    default_terms: s.defaultTerms,
    reminders_enabled: s.remindersEnabled,
    plaid_override: Boolean(s.plaidClientId),
    plaid_env: s.plaidClientId
      ? s.plaidEnv === "production"
        ? ("production" as const)
        : ("sandbox" as const)
      : null,
    payment_provider: s.paymentProvider,
    online_pay_default: s.onlinePayDefault,
    payment_livemode: s.paymentProvider === "stripe" ? stripeOptions(s).livemode : null,
  };
}

const MemberSchema = z
  .object({
    user_id: z.string(),
    email: z.string(),
    name: z.string(),
    role: RoleSchema,
    created_at: z.string(),
  })
  .openapi("Member");

const InvitationSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: RoleSchema,
    expires_at: z.string(),
    accepted_at: z.string().nullable(),
    link: z.string().optional(),
    emailed: z.boolean().optional(),
  })
  .openapi("Invitation");

const AuditRowSchema = z
  .object({
    id: z.string(),
    seq: z.number().int(),
    at: z.string(),
    user_id: z.string().nullable(),
    api_token_id: z.string().nullable(),
    oauth_client_id: z.string().nullable(),
    actor: z.string(),
    action: z.string(),
    target_type: z.string().nullable(),
    target_id: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    ip: z.string().nullable(),
    hash: z.string(),
  })
  .openapi("AuditRow");

export function orgRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs",
      tags: ["Organizations"],
      summary: "List organizations you belong to",
      security: bearerSecurity,
      responses: {
        200: json(
          z.object({
            data: z.array(
              z.object({ id: z.string(), name: z.string(), role: RoleSchema, is_sample: z.boolean() }),
            ),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const p = requireAuth(c);
      let orgs = await c.get("ctx").orgs.listForUser(p.userId);
      const grants = tokenGrants(p);
      if (grants) orgs = orgs.filter((o) => grants.some((g) => g.orgId === o.id));
      return c.json(
        { data: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, is_sample: o.isSample })) },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs",
      tags: ["Organizations"],
      summary: "Create an organization (you become its owner)",
      security: bearerSecurity,
      request: {
        body: jsonBody(
          z.object({
            name: z.string().min(1).max(200),
            entity_type: z.enum(ENTITY_TYPES).default("single_member_llc"),
            coa_template: z.enum(COA_TEMPLATES).optional(),
            fiscal_year_start_month: z.number().int().min(1).max(12).default(1),
            basis: z.enum(["cash", "accrual"]).default("cash"),
            books_start_date: IsoDate.optional(),
          }),
        ),
      },
      responses: { 201: json(z.object({ id: z.string() })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const body = c.req.valid("json");
      const res = await c.get("ctx").orgs.create({
        name: body.name,
        createdBy: p.userId,
        entityType: body.entity_type,
        coaTemplate: body.coa_template ?? defaultTemplateForEntity(body.entity_type),
        fiscalYearStartMonth: body.fiscal_year_start_month,
        basis: body.basis,
        booksStartDate: body.books_start_date ?? `${new Date().getUTCFullYear()}-01-01`,
        ip: c.get("ip"),
      });
      return c.json(res, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}",
      tags: ["Organizations"],
      summary: "Get an organization and its settings",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(OrgSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const s = await o.handle.db.select().from(org.orgSettings).get();
      const reg = await c.get("ctx").orgs.get(o.id);
      if (!s || !reg) throw notFound("Organization");
      return c.json(
        { id: o.id, name: reg.name, role: o.role, is_sample: reg.isSample, settings: settingsView(s) },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}",
      tags: ["Organizations"],
      summary: "Update organization settings (owner). Lock dates use the lock-dates endpoint.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z
            .object({
              name: z.string().min(1).max(200),
              legal_name: z.string().min(1).max(200),
              dba: z.string().max(200).nullable(),
              entity_type: z.enum(ENTITY_TYPES),
              tax_id_last4: z
                .string()
                .regex(/^\d{4}$/)
                .nullable(),
              address: z.record(z.string(), z.string()).nullable(),
              fiscal_year_start_month: z.number().int().min(1).max(12),
              default_basis: z.enum(["cash", "accrual"]),
              books_start_date: IsoDate.nullable(),
              invoice_prefix: z.string().max(20),
              next_invoice_number: z.number().int().min(1),
              review_threshold: z.number().int().min(0),
              invoice_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
              payment_instructions: z.string().max(2000).nullable(),
              default_terms: z.string().max(200),
              reminders_enabled: z.boolean(),
              logo_attachment_id: z.string().nullable(),
              plaid: z
                .object({
                  env: z.enum(["sandbox", "production"]),
                  client_id: z.string().trim().min(1).max(100),
                  secret: z.string().trim().min(1).max(200),
                })
                .nullable()
                .describe("Org-level Plaid keys that override the instance keys; null removes them."),
            })
            .partial(),
        ),
      },
      responses: { 200: json(OrgSettingsSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json");
      const ctx = c.get("ctx");
      const patch: Partial<typeof org.orgSettings.$inferInsert> = {};
      if (b.legal_name !== undefined) patch.legalName = b.legal_name;
      if (b.dba !== undefined) patch.dba = b.dba;
      if (b.entity_type !== undefined) patch.entityType = b.entity_type;
      if (b.tax_id_last4 !== undefined) patch.taxIdLast4 = b.tax_id_last4;
      if (b.address !== undefined) patch.addressJson = b.address ? JSON.stringify(b.address) : null;
      if (b.fiscal_year_start_month !== undefined) patch.fiscalYearStartMonth = b.fiscal_year_start_month;
      if (b.default_basis !== undefined) patch.defaultBasis = b.default_basis;
      if (b.books_start_date !== undefined) patch.booksStartDate = b.books_start_date;
      if (b.invoice_prefix !== undefined) patch.invoicePrefix = b.invoice_prefix;
      if (b.next_invoice_number !== undefined) patch.nextInvoiceNumber = b.next_invoice_number;
      if (b.review_threshold !== undefined) patch.reviewThreshold = b.review_threshold;
      if (b.invoice_color !== undefined) patch.invoiceColor = b.invoice_color;
      if (b.payment_instructions !== undefined) patch.paymentInstructions = b.payment_instructions;
      if (b.default_terms !== undefined) patch.defaultTerms = b.default_terms;
      if (b.reminders_enabled !== undefined) patch.remindersEnabled = b.reminders_enabled;
      if (b.logo_attachment_id !== undefined) patch.logoAttachmentId = b.logo_attachment_id;
      if (b.plaid !== undefined) {
        if (o.actor.actor === "mcp" || o.actor.proposeOnly)
          throw forbidden("AI assistants cannot change bank connection keys.");
        if (b.plaid)
          await verifyPlaidKeys({ env: b.plaid.env, clientId: b.plaid.client_id, secret: b.plaid.secret });
        patch.plaidEnv = b.plaid?.env ?? null;
        patch.plaidClientId = b.plaid?.client_id ?? null;
        patch.plaidSecretEnc = b.plaid ? ctx.secrets.encrypt(b.plaid.secret) : null;
      }
      const updated = await o.handle.write(async (tx) => {
        const before = await tx.select().from(org.orgSettings).get();
        if (Object.keys(patch).length)
          await tx.update(org.orgSettings).set(patch).where(eq(org.orgSettings.id, 1));
        const after = await tx.select().from(org.orgSettings).get();
        await appendAudit(tx, o.id, o.actor, {
          action: "settings.update",
          targetType: "org_settings",
          targetId: o.id,
          before: before && settingsView(before),
          after: after && settingsView(after),
        });
        return after!;
      });
      if (b.name) {
        await ctx.system.write((tx) =>
          tx.update(system.organizations).set({ name: b.name! }).where(eq(system.organizations.id, o.id)),
        );
      }
      return c.json(settingsView(updated), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}",
      tags: ["Organizations"],
      summary:
        "Archive an organization (owner). Data is kept; use the CLI to delete permanently. " +
        "`?permanent=true` permanently deletes a demo organization instead.",
      security: bearerSecurity,
      request: { params: OrgParams, query: z.object({ permanent: z.enum(["true", "false"]).optional() }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      if (c.get("principal")?.kind !== "session") throw forbidden("Archiving requires a signed-in session.");
      const { permanent } = c.req.valid("query");
      if (permanent === "true") await c.get("ctx").orgs.deleteSample(o.id, o.actor);
      else await c.get("ctx").orgs.archive(o.id, o.actor);
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/sample-org",
      tags: ["Organizations"],
      summary: "Load a demo organization with sample books for the signed-in user",
      security: bearerSecurity,
      responses: { 201: json(z.object({ id: z.string() })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const existing = await c.get("ctx").orgs.listForUser(p.userId);
      const already = existing.find((o) => o.isSample);
      if (already)
        throw conflict("You already have a demo organization.", "sample_exists", { id: already.id });
      const { id } = await loadSampleData(c.get("ctx"), p.userId);
      return c.json({ id }, 201);
    },
  );

  // ------------------------------------------------------------------ members

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/members",
      tags: ["Members"],
      summary: "List members",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(MemberSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const rows = await c
        .get("ctx")
        .system.db.select({
          user_id: system.memberships.userId,
          email: system.users.email,
          name: system.users.name,
          role: system.memberships.role,
          created_at: system.memberships.createdAt,
        })
        .from(system.memberships)
        .innerJoin(system.users, eq(system.users.id, system.memberships.userId))
        .where(eq(system.memberships.orgId, o.id))
        .all();
      return c.json({ data: rows }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/members/{userId}",
      tags: ["Members"],
      summary: "Change a member's role (owner)",
      security: bearerSecurity,
      request: {
        params: OrgParams.extend({ userId: Id }),
        body: jsonBody(z.object({ role: RoleSchema })),
      },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const { userId } = c.req.valid("param");
      const { role } = c.req.valid("json");
      const ctx = c.get("ctx");
      const current = await ctx.orgs.membership(userId, o.id);
      if (!current) throw notFound("Member");
      if (current === "owner" && role !== "owner" && (await ownerCount(ctx, o.id)) <= 1) {
        throw new ApiError(422, "last_owner", "An organization must always have at least one owner.");
      }
      await ctx.system.write((tx) =>
        tx
          .update(system.memberships)
          .set({ role })
          .where(and(eq(system.memberships.orgId, o.id), eq(system.memberships.userId, userId))),
      );
      await capTokens(ctx, o.id, userId, role);
      await o.handle.write((tx) =>
        appendAudit(tx, o.id, o.actor, {
          action: "membership.update",
          targetType: "user",
          targetId: userId,
          before: { role: current },
          after: { role },
        }),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/members/{userId}",
      tags: ["Members"],
      summary: "Remove a member (owner), or leave the organization yourself",
      security: bearerSecurity,
      request: { params: OrgParams.extend({ userId: Id }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const p = requireAuth(c);
      const { userId } = c.req.valid("param");
      if (userId !== p.userId) requireOwner(c);
      const ctx = c.get("ctx");
      const current = await ctx.orgs.membership(userId, o.id);
      if (!current) throw notFound("Member");
      if (current === "owner" && (await ownerCount(ctx, o.id)) <= 1) {
        throw new ApiError(422, "last_owner", "An organization must always have at least one owner.");
      }
      await ctx.system.write(async (tx) => {
        await tx
          .delete(system.memberships)
          .where(and(eq(system.memberships.orgId, o.id), eq(system.memberships.userId, userId)));
        await tx
          .update(system.apiTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(and(eq(system.apiTokens.orgId, o.id), eq(system.apiTokens.userId, userId)));
        await revokeUserOrgGrantsTx(tx, userId, o.id);
      });
      await o.handle.write((tx) =>
        appendAudit(tx, o.id, o.actor, {
          action: "membership.remove",
          targetType: "user",
          targetId: userId,
          before: { role: current },
        }),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ invitations

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/invitations",
      tags: ["Members"],
      summary: "List pending invitations (owner)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(InvitationSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const rows = await c
        .get("ctx")
        .system.db.select()
        .from(system.invitations)
        .where(
          and(
            eq(system.invitations.orgId, o.id),
            isNull(system.invitations.acceptedAt),
            gt(system.invitations.expiresAt, new Date().toISOString()),
          ),
        )
        .all();
      return c.json(
        {
          data: rows.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            expires_at: i.expiresAt,
            accepted_at: i.acceptedAt,
          })),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invitations",
      tags: ["Members"],
      summary: "Invite someone by email (owner). The link is returned once and emailed when SMTP is set up.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(z.object({ email: z.string().email(), role: RoleSchema })),
      },
      responses: { 201: json(InvitationSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const p = requireAuth(c);
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const inv = await createInvitation(ctx, {
        orgId: o.id,
        email: body.email,
        role: body.role,
        invitedBy: p.userId,
      });
      await o.handle.write((tx) =>
        appendAudit(tx, o.id, o.actor, {
          action: "invitation.create",
          targetType: "invitation",
          targetId: inv.id,
          after: { email: body.email, role: body.role },
        }),
      );
      return c.json(inv, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/invitations/{invitationId}",
      tags: ["Members"],
      summary: "Revoke an invitation (owner)",
      security: bearerSecurity,
      request: { params: OrgParams.extend({ invitationId: Id }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const { invitationId } = c.req.valid("param");
      await c.get("ctx").system.write((tx) =>
        tx
          .update(system.invitations)
          .set({ expiresAt: new Date(0).toISOString() })
          .where(and(eq(system.invitations.id, invitationId), eq(system.invitations.orgId, o.id))),
      );
      await o.handle.write((tx) =>
        appendAudit(tx, o.id, o.actor, {
          action: "invitation.revoke",
          targetType: "invitation",
          targetId: invitationId,
        }),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/invitations/{token}",
      tags: ["Members"],
      summary: "Look up an invitation",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: json(
          z.object({
            email: z.string(),
            role: RoleSchema,
            org_name: z.string().nullable(),
            user_exists: z.boolean(),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      rateLimit(c, "invite", 20, 60_000);
      const ctx = c.get("ctx");
      const inv = await findInvitation(ctx, c.req.valid("param").token);
      const orgRow = inv.orgId ? await ctx.orgs.get(inv.orgId) : null;
      return c.json(
        {
          email: inv.email,
          role: inv.role,
          org_name: orgRow?.name ?? null,
          user_exists: Boolean(await ctx.users.byEmail(inv.email)),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/invitations/accept",
      tags: ["Members"],
      summary: "Accept an invitation. New users set a password; existing users must be signed in.",
      request: {
        body: jsonBody(
          z.object({ token: z.string(), password: z.string().optional(), name: z.string().optional() }),
        ),
      },
      responses: {
        200: json(z.object({ org_id: z.string().nullable(), user_id: z.string() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      rateLimit(c, "invite", 10, 60_000);
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const inv = await findInvitation(ctx, body.token);
      let user = await ctx.users.byEmail(inv.email);
      const p = c.get("principal");
      if (user) {
        if (p?.kind !== "session" || p.userId !== user.id) {
          throw new ApiError(
            401,
            "sign_in_required",
            "Sign in as the invited user to accept this invitation.",
          );
        }
      } else {
        if (!body.password) throw badRequest("Choose a password to create your account.");
        user = await ctx.users
          .create({ email: inv.email, name: body.name ?? "", password: body.password })
          .catch(authError);
        await instanceAudit(ctx.system, {
          userId: user.id,
          action: "user.create.invitation",
          targetId: inv.id,
        });
      }
      const u = user;
      await ctx.system.write(async (tx) => {
        await tx
          .update(system.invitations)
          .set({ acceptedAt: new Date().toISOString() })
          .where(eq(system.invitations.id, inv.id));
        if (inv.orgId) {
          await tx
            .insert(system.memberships)
            .values({ userId: u.id, orgId: inv.orgId, role: inv.role })
            .onConflictDoUpdate({
              target: [system.memberships.userId, system.memberships.orgId],
              set: { role: inv.role },
            });
        }
      });
      if (inv.orgId) {
        const h = await ctx.orgs.mustOpen(inv.orgId);
        await h.write((tx) =>
          appendAudit(
            tx,
            inv.orgId!,
            { actor: "user", role: inv.role, userId: u.id, ip: c.get("ip") },
            {
              action: "membership.add",
              targetType: "user",
              targetId: u.id,
              after: { role: inv.role, invitation_id: inv.id },
            },
          ),
        );
      }
      return c.json({ org_id: inv.orgId, user_id: u.id }, 200);
    },
  );

  // ------------------------------------------------------------------ audit log

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/audit",
      tags: ["Audit"],
      summary: "Audit log (newest first)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          before_seq: z.coerce.number().int().optional(),
          target_type: z.string().optional(),
          target_id: z.string().optional(),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(AuditRowSchema), next_cursor: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const q = c.req.valid("query");
      const conds = [];
      if (q.before_seq) conds.push(lt(org.auditLog.seq, q.before_seq));
      if (q.target_type) conds.push(eq(org.auditLog.targetType, q.target_type));
      if (q.target_id) conds.push(eq(org.auditLog.targetId, q.target_id));
      const rows = await o.handle.db
        .select()
        .from(org.auditLog)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(org.auditLog.seq))
        .limit(q.limit + 1)
        .all();
      const data = rows.slice(0, q.limit).map(auditView);
      return c.json(
        { data, next_cursor: rows.length > q.limit ? String(data[data.length - 1]!.seq) : null },
        200,
      );
    },
  );

  return r;
}

export function auditView(a: typeof org.auditLog.$inferSelect) {
  return {
    id: a.id,
    seq: a.seq,
    at: a.at,
    user_id: a.userId,
    api_token_id: a.apiTokenId,
    oauth_client_id: a.oauthClientId,
    actor: a.actor,
    action: a.action,
    target_type: a.targetType,
    target_id: a.targetId,
    before: a.beforeJson ? JSON.parse(a.beforeJson) : null,
    after: a.afterJson ? JSON.parse(a.afterJson) : null,
    ip: a.ip,
    hash: a.hash,
  };
}

type Ctx = import("../../context.ts").AppContext;

async function ownerCount(ctx: Ctx, orgId: string): Promise<number> {
  const rows = await ctx.system.db
    .select()
    .from(system.memberships)
    .where(and(eq(system.memberships.orgId, orgId), eq(system.memberships.role, "owner")))
    .all();
  return rows.length;
}

/** When a member's role drops, tokens they issued are capped to the new role. */
async function capTokens(ctx: Ctx, orgId: string, userId: string, role: Role) {
  const tokens = await ctx.users.listApiTokens({ userId, orgId });
  for (const t of tokens) {
    if (!t.revokedAt && roleRank(t.role) > roleRank(role)) {
      await ctx.system.write((tx) =>
        tx.update(system.apiTokens).set({ role }).where(eq(system.apiTokens.id, t.id)),
      );
    }
  }
}

export async function createInvitation(
  ctx: Ctx,
  input: { orgId: string | null; email: string; role: Role; invitedBy: string; ttlDays?: number },
) {
  const token = randomToken("", 24);
  const id = newId();
  const expiresAt = new Date(Date.now() + (input.ttlDays ?? 7) * 86_400_000).toISOString();
  await ctx.system.write((tx) =>
    tx.insert(system.invitations).values({
      id,
      orgId: input.orgId,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: input.invitedBy,
      expiresAt,
    }),
  );
  const link = `${ctx.config.server.public_url}/invite/${token}`;
  let emailed = false;
  const mailer = ctx.services.mailer as
    | {
        isConfigured(): Promise<boolean>;
        sendInvitation(to: string, link: string, orgName: string | null): Promise<void>;
      }
    | undefined;
  if (mailer && (await mailer.isConfigured())) {
    const orgRow = input.orgId ? await ctx.orgs.get(input.orgId) : null;
    await mailer
      .sendInvitation(input.email, link, orgRow?.name ?? null)
      .then(() => {
        emailed = true;
      })
      .catch((e) => ctx.logger.error("invitation email failed", { err: e }));
  }
  return {
    id,
    email: input.email,
    role: input.role,
    expires_at: expiresAt,
    accepted_at: null,
    link,
    emailed,
  };
}

async function findInvitation(ctx: Ctx, token: string) {
  const inv = await ctx.system.db
    .select()
    .from(system.invitations)
    .where(
      and(
        eq(system.invitations.tokenHash, hashToken(token)),
        isNull(system.invitations.acceptedAt),
        gt(system.invitations.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
  if (!inv)
    throw new ApiError(404, "invalid_invitation", "This invitation is invalid, expired, or already used.");
  return inv;
}
