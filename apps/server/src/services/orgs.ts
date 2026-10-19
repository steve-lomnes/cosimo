import { auditGenesis, ledgerGenesis } from "@cosimo/core";
import {
  connectOrg,
  type DbHandle,
  migrateOrg,
  newId,
  type OrgSchema,
  type OrgTx,
  org,
  system,
} from "@cosimo/db";
import type { Basis, CoaTemplate, EntityType, Role } from "@cosimo/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SecretBox } from "../crypto.ts";
import { unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { instanceAudit } from "./instance-audit.ts";
import { forgetOrgTx } from "./oauth.ts";
import type { OrgProvisioner } from "./provisioning.ts";
import type { SystemHandle } from "./types.ts";

export interface CreateOrgInput {
  name: string;
  createdBy: string | null;
  entityType?: EntityType;
  coaTemplate?: CoaTemplate;
  fiscalYearStartMonth?: number;
  basis?: Basis;
  booksStartDate?: string;
  baseCurrency?: string;
  /** The first owner. */
  ownerUserId?: string | null;
  ip?: string | null;
  isSample?: boolean;
}

export type OrgSeeder = (tx: OrgTx, orgId: string, input: CreateOrgInput) => Promise<void>;

export class OrgService {
  readonly #cache = new Map<string, DbHandle<OrgSchema>>();
  readonly #seeders: OrgSeeder[] = [];

  constructor(
    private readonly system: SystemHandle,
    private readonly provisioner: OrgProvisioner,
    private readonly secrets: SecretBox,
  ) {}

  /** Create an empty database for `orgId` (open-format import); the caller registers the org. */
  provisionDatabase(orgId: string) {
    return this.provisioner.create(orgId);
  }

  dropDatabase(orgId: string, url: string) {
    return this.provisioner.destroy(orgId, url);
  }

  /** Register a seeder that runs inside the org creation transaction (chart of accounts, etc). */
  addSeeder(s: OrgSeeder) {
    this.#seeders.push(s);
  }

  get provisionerKind() {
    return this.provisioner.kind;
  }

  async get(orgId: string) {
    return this.system.db.select().from(system.organizations).where(eq(system.organizations.id, orgId)).get();
  }

  /** Open (and cache) the org database handle. Returns null for unknown orgs. */
  async open(orgId: string): Promise<DbHandle<OrgSchema> | null> {
    const cached = this.#cache.get(orgId);
    if (cached) return cached;
    // Only columns from the first system migration: this runs before migrations (pre-migration backup).
    const row = await this.system.db
      .select({ dbUrl: system.organizations.dbUrl, dbTokenEnc: system.organizations.dbTokenEnc })
      .from(system.organizations)
      .where(eq(system.organizations.id, orgId))
      .get();
    if (!row) return null;
    const h = connectOrg(row.dbUrl, this.secrets.reveal(row.dbTokenEnc) ?? undefined);
    this.#cache.set(orgId, h);
    return h;
  }

  async mustOpen(orgId: string): Promise<DbHandle<OrgSchema>> {
    const h = await this.open(orgId);
    if (!h) throw new Error(`Unknown org ${orgId}`);
    return h;
  }

  forget(orgId: string) {
    const h = this.#cache.get(orgId);
    if (h) {
      h.close();
      this.#cache.delete(orgId);
    }
  }

  closeAll() {
    for (const h of this.#cache.values()) h.close();
    this.#cache.clear();
  }

  async list(opts: { includeArchived?: boolean } = {}) {
    const rows = await this.system.db.select().from(system.organizations).all();
    return opts.includeArchived ? rows : rows.filter((r) => !r.archivedAt);
  }

  /**
   * Every org, archived included, for maintenance that runs before migrations (the pre-migration
   * backup, the pending-migrations check). The system schema may be older than the code, so this
   * selects only columns created by `system/drizzle/0000_init.sql`; never add a newer one here.
   */
  async listForMaintenance() {
    return this.system.db
      .select({
        id: system.organizations.id,
        name: system.organizations.name,
        dbUrl: system.organizations.dbUrl,
        archivedAt: system.organizations.archivedAt,
      })
      .from(system.organizations)
      .all();
  }

  async listForUser(userId: string) {
    return this.system.db
      .select({
        id: system.organizations.id,
        name: system.organizations.name,
        role: system.memberships.role,
        archivedAt: system.organizations.archivedAt,
        createdAt: system.organizations.createdAt,
        isSample: system.organizations.isSample,
      })
      .from(system.memberships)
      .innerJoin(system.organizations, eq(system.organizations.id, system.memberships.orgId))
      .where(and(eq(system.memberships.userId, userId), isNull(system.organizations.archivedAt)))
      .orderBy(system.organizations.isSample, sql`lower(${system.organizations.name})`)
      .all();
  }

  async membership(userId: string, orgId: string): Promise<Role | null> {
    const m = await this.system.db
      .select({ role: system.memberships.role })
      .from(system.memberships)
      .innerJoin(system.organizations, eq(system.organizations.id, system.memberships.orgId))
      .where(
        and(
          eq(system.memberships.userId, userId),
          eq(system.memberships.orgId, orgId),
          isNull(system.organizations.archivedAt),
        ),
      )
      .get();
    return m?.role ?? null;
  }

  async create(input: CreateOrgInput): Promise<{ id: string }> {
    const id = newId();
    const prov = await this.provisioner.create(id);
    const handle = connectOrg(prov.url, prov.authToken);
    try {
      await migrateOrg(handle.client);
      const actor: ActorInfo = {
        actor: input.createdBy ? "user" : "system",
        role: "owner",
        userId: input.createdBy,
        ip: input.ip ?? null,
      };
      await handle.write(async (tx) => {
        await tx.insert(org.schemaMeta).values([
          { key: "org_id", value: id },
          { key: "ledger_genesis", value: ledgerGenesis(id) },
          { key: "audit_genesis", value: auditGenesis(id) },
          { key: "created_at", value: new Date().toISOString() },
        ]);
        await tx.insert(org.orgSettings).values({
          id: 1,
          orgId: id,
          legalName: input.name,
          entityType: input.entityType ?? "single_member_llc",
          baseCurrency: input.baseCurrency ?? "USD",
          fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
          defaultBasis: input.basis ?? "cash",
          booksStartDate: input.booksStartDate ?? null,
        });
        for (const s of this.#seeders) await s(tx, id, input);
        await appendAudit(tx, id, actor, {
          action: "org.create",
          targetType: "org",
          targetId: id,
          after: { name: input.name, entityType: input.entityType, coaTemplate: input.coaTemplate },
        });
      });
    } catch (e) {
      handle.close();
      await this.provisioner.destroy(id, prov.url).catch(() => {});
      throw e;
    }
    await this.system.write(async (tx) => {
      await tx.insert(system.organizations).values({
        id,
        name: input.name,
        dbUrl: prov.url,
        dbTokenEnc: prov.authToken ? this.secrets.encrypt(prov.authToken) : null,
        createdBy: input.createdBy,
        isSample: input.isSample ?? false,
      });
      const owner = input.ownerUserId ?? input.createdBy;
      if (owner) await tx.insert(system.memberships).values({ userId: owner, orgId: id, role: "owner" });
    });
    this.#cache.set(id, handle);
    return { id };
  }

  async archive(orgId: string, actor: ActorInfo) {
    const h = await this.mustOpen(orgId);
    await h.write((tx) =>
      appendAudit(tx, orgId, actor, { action: "org.archive", targetType: "org", targetId: orgId }),
    );
    await this.system.write((tx) =>
      tx
        .update(system.organizations)
        .set({ archivedAt: new Date().toISOString() })
        .where(eq(system.organizations.id, orgId)),
    );
  }

  /** Permanently delete a sample org's database and registry rows. Refuses real orgs. */
  async deleteSample(orgId: string, actor: ActorInfo) {
    const row = await this.get(orgId);
    if (!row?.isSample)
      throw unprocessable("Only demo organizations can be permanently deleted.", "not_sample");
    await this.destroy(orgId);
    await instanceAudit(this.system, {
      userId: actor.userId,
      action: "org.delete_sample",
      targetType: "org",
      targetId: orgId,
      ip: actor.ip,
    });
  }

  /** Permanently delete an org's database and registry rows. */
  async destroy(orgId: string) {
    const row = await this.get(orgId);
    if (!row) return;
    this.forget(orgId);
    await this.system.write(async (tx) => {
      await tx.delete(system.memberships).where(eq(system.memberships.orgId, orgId));
      await tx.delete(system.apiTokens).where(eq(system.apiTokens.orgId, orgId));
      await tx.delete(system.invitations).where(eq(system.invitations.orgId, orgId));
      await forgetOrgTx(tx, orgId);
      await tx.delete(system.organizations).where(eq(system.organizations.id, orgId));
    });
    await this.provisioner.destroy(orgId, row.dbUrl);
  }

  async migrateAll(): Promise<{ orgId: string; applied: string[] }[]> {
    const out: { orgId: string; applied: string[] }[] = [];
    for (const o of await this.listForMaintenance()) {
      const h = await this.mustOpen(o.id);
      try {
        out.push({ orgId: o.id, applied: await migrateOrg(h.client) });
      } catch (e) {
        throw new Error(`Migration failed for org ${o.id} (${o.name}): ${(e as Error).message}`, {
          cause: e,
        });
      }
    }
    return out;
  }
}
