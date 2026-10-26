/**
 * Open-format export and import of one organization (SPEC §14.2, docs/export-format.md).
 *
 * A ZIP with `manifest.json`, `org.json`, `members.json`, one JSON Lines file per table under
 * `tables/`, and attachment blobs under `attachments/`. Secrets (Plaid access tokens and org-level
 * Plaid secrets) are omitted and the manifest says so.
 *
 * Import keeps the organization ID, because the hash chains commit to it: the ledger and audit
 * chains of an imported org verify exactly as they did before export.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditGenesis, ledgerGenesis } from "@cosimo/core";
import { connectOrg, migrate, migrateOrg, orgMigrations, system } from "@cosimo/db";
import { VERSION } from "@cosimo/shared";
import type { Client, InValue } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, unprocessable } from "../http/errors.ts";
import { checkSums, json, readZip, writeZip, type ZipSource } from "./archive.ts";
import { appendAudit } from "./audit.ts";
import { auditHead, ledgerHead, verifyOrg } from "./chain.ts";
import type { BlobStore } from "./storage.ts";

export const EXPORT_FORMAT = "cosimo-export";
export const EXPORT_FORMAT_VERSION = 1;

/** Columns blanked on export: [table, column, replacement]. */
const SECRET_COLUMNS: [string, string, InValue][] = [
  ["bank_connections", "access_token_enc", ""],
  ["org_settings", "plaid_secret_enc", null],
  ["org_settings", "payment_credentials_enc", null],
];
const SKIP_TABLES = new Set(["_cosimo_migrations"]);

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  format_version: number;
  exported_at: string;
  cosimo_version: string;
  schema: string[];
  org: { id: string; name: string };
  secrets_omitted: true;
  chain_heads: { ledger: { seq: number; hash: string }; audit: { seq: number; hash: string } };
  tables: Record<string, { rows: number }>;
  files: Record<string, { sha256: string; bytes: number }>;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Encode a SQLite value for JSON: blobs as {"$base64": "..."}. */
function enc(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return { $base64: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v))
    return { $base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (typeof v === "bigint") return Number(v);
  return v;
}
function dec(v: unknown): InValue {
  if (v && typeof v === "object" && "$base64" in (v as Record<string, unknown>))
    return new Uint8Array(Buffer.from(String((v as { $base64: string }).$base64), "base64"));
  return v as InValue;
}

async function tableNames(client: Client) {
  const rs = await client.execute(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  );
  return rs.rows.map((r) => String(r.name)).filter((n) => !SKIP_TABLES.has(n));
}

/** Write `<org>.zip` for one organization. Returns the manifest. */
export async function exportOrg(ctx: AppContext, orgId: string, out: string): Promise<ExportManifest> {
  const reg = await ctx.orgs.get(orgId);
  if (!reg) throw new ApiError(404, "not_found", "Organization not found.");
  const h = await ctx.orgs.mustOpen(orgId);
  const store = ctx.services.storage as BlobStore;
  const entries: ZipSource[] = [];
  const tables: ExportManifest["tables"] = {};

  // One read transaction so every table comes from the same moment.
  const tx = await h.client.transaction("read");
  let lh: { seq: number; hash: string };
  let ah: { seq: number; hash: string };
  const storageKeys: string[] = [];
  let schema: string[];
  try {
    schema = (await tx.execute("select tag from _cosimo_migrations order by tag")).rows.map((r) =>
      String(r.tag),
    );
    for (const t of await tableNames(h.client)) {
      const rs = await tx.execute(`select * from ${q(t)} order by rowid`);
      const blank = SECRET_COLUMNS.filter(([tt]) => tt === t);
      const lines = rs.rows.map((row) => {
        const o: Record<string, unknown> = {};
        rs.columns.forEach((c, i) => {
          o[c] = enc(row[i]);
        });
        for (const [, col, repl] of blank) if (col in o && o[col] !== null) o[col] = repl;
        if (t === "attachments" && typeof o.storage_key === "string") storageKeys.push(o.storage_key);
        return JSON.stringify(o);
      });
      tables[t] = { rows: lines.length };
      entries.push({
        name: `tables/${t}.jsonl`,
        data: new TextEncoder().encode(lines.length ? `${lines.join("\n")}\n` : ""),
      });
    }
    lh = await ledgerHeadRaw(tx, orgId);
    ah = await auditHeadRaw(tx, orgId);
  } finally {
    tx.close();
  }

  entries.push({ name: "org.json", data: json({ id: orgId, name: reg.name, created_at: reg.createdAt }) });
  const members = await ctx.system.db
    .select({ email: system.users.email, name: system.users.name, role: system.memberships.role })
    .from(system.memberships)
    .innerJoin(system.users, eq(system.users.id, system.memberships.userId))
    .where(eq(system.memberships.orgId, orgId))
    .all();
  entries.push({ name: "members.json", data: json(members) });
  for (const key of [...new Set(storageKeys)]) {
    const bytes = await store.get(key);
    if (bytes) entries.push({ name: `attachments/${key}`, data: bytes, store: true });
  }

  let manifest!: ExportManifest;
  await writeZip(out, entries, (files) => {
    manifest = {
      format: EXPORT_FORMAT,
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      cosimo_version: VERSION,
      schema,
      org: { id: orgId, name: reg.name },
      secrets_omitted: true,
      chain_heads: { ledger: lh, audit: ah },
      tables,
      files,
    };
    return { name: "manifest.json", data: json(manifest) };
  });
  return manifest;
}

// Same results as chain.ts ledgerHead/auditHead, read inside the export's transaction.
async function ledgerHeadRaw(tx: { execute: Client["execute"] }, orgId: string) {
  const r = (
    await tx.execute(
      "select chain_seq as seq, entry_hash as hash from journal_entries where chain_seq is not null order by chain_seq desc limit 1",
    )
  ).rows[0];
  return r ? { seq: Number(r.seq), hash: String(r.hash) } : { seq: 0, hash: ledgerGenesis(orgId) };
}
async function auditHeadRaw(tx: { execute: Client["execute"] }, orgId: string) {
  const r = (await tx.execute("select seq, hash from audit_log order by seq desc limit 1")).rows[0];
  return r ? { seq: Number(r.seq), hash: String(r.hash) } : { seq: 0, hash: auditGenesis(orgId) };
}

/** Bytes of an export (for the HTTP download). */
export async function exportOrgBytes(ctx: AppContext, orgId: string) {
  const dir = mkdtempSync(join(tmpdir(), "cosimo-export-"));
  try {
    const path = join(dir, "export.zip");
    const manifest = await exportOrg(ctx, orgId, path);
    return { bytes: new Uint8Array(readFileSync(path)), manifest };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------- import

export interface ImportResult {
  org_id: string;
  name: string;
  tables: Record<string, number>;
  attachments: number;
  members_added: string[];
  members_skipped: string[];
  chains_ok: true;
}

/** Order tables so referenced tables load before the ones pointing at them. */
async function loadOrder(client: Client, names: string[]) {
  const deps = new Map<string, Set<string>>();
  for (const n of names) {
    const fk = await client.execute(`pragma foreign_key_list(${q(n)})`);
    deps.set(n, new Set(fk.rows.map((r) => String(r.table)).filter((t) => t !== n && names.includes(t))));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: Set<string>) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const d of deps.get(n) ?? []) visit(d, stack);
    stack.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of [...names].sort()) visit(n, new Set());
  return out;
}

/**
 * Import an export ZIP as a new organization with its original ID. The importing user becomes an
 * owner; other members are added when a user with the same email exists on this instance.
 */
export async function importOrgArchive(
  ctx: AppContext,
  zipBytes: Uint8Array,
  opts: { userId: string; name?: string },
): Promise<ImportResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = readZip(zipBytes);
  } catch {
    throw unprocessable("Not a ZIP file.", "invalid_export");
  }
  const m = files["manifest.json"];
  if (!m) throw unprocessable("Not a Cosimo export (no manifest.json).", "invalid_export");
  const manifest = JSON.parse(new TextDecoder().decode(m)) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) throw unprocessable("Not a Cosimo export.", "invalid_export");
  if (manifest.format_version > EXPORT_FORMAT_VERSION)
    throw unprocessable("This export comes from a newer Cosimo. Upgrade first.", "export_too_new");
  const known = new Set(orgMigrations.map((x) => x.tag));
  const unknown = manifest.schema.filter((t) => !known.has(t));
  if (unknown.length)
    throw unprocessable(
      `This export uses a newer database schema (${unknown.join(", ")}). Upgrade first.`,
      "export_too_new",
    );
  const bad = checkSums(files, manifest.files);
  if (bad.length)
    throw unprocessable(`The export is damaged: ${bad.slice(0, 5).join(", ")}`, "checksum_mismatch");

  const orgId = manifest.org.id;
  if (await ctx.orgs.get(orgId))
    throw conflict(
      "An organization with this ID already exists on this instance. Delete it first to replace it.",
      "org_exists",
    );
  const name = opts.name ?? manifest.org.name;
  const prov = await ctx.orgs.provisionDatabase(orgId);
  const h = connectOrg(prov.url, prov.authToken);
  const counts: Record<string, number> = {};
  try {
    // Migrate to the export's schema level; newer migrations run after the load so their data steps
    // apply (0011, for one, moves receipts.attachment_id into attachment_links).
    const level = new Set(manifest.schema);
    await migrate(
      h.client,
      orgMigrations.filter((x) => level.has(x.tag)),
    );
    const names = (await tableNames(h.client)).filter((t) => files[`tables/${t}.jsonl`] !== undefined);
    const extra = Object.keys(manifest.tables).filter((t) => !names.includes(t));
    if (extra.length) throw unprocessable(`Unknown tables in export: ${extra.join(", ")}`, "invalid_export");
    const triggers = (
      await h.client.execute("select name, sql from sqlite_master where type = 'trigger' and sql is not null")
    ).rows.map((r) => ({ name: String(r.name), sql: String(r.sql) }));
    const order = await loadOrder(h.client, names);

    const stmts: { sql: string; args?: InValue[] }[] = [];
    for (const t of triggers) stmts.push({ sql: `drop trigger ${q(t.name)}` });
    for (const t of [...order].reverse()) stmts.push({ sql: `delete from ${q(t)}` });
    for (const t of order) {
      const text = new TextDecoder().decode(files[`tables/${t}.jsonl`]!);
      let n = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as Record<string, unknown>;
        const cols = Object.keys(row);
        stmts.push({
          sql: `insert into ${q(t)} (${cols.map(q).join(", ")}) values (${cols.map(() => "?").join(", ")})`,
          args: cols.map((c) => dec(row[c])),
        });
        n++;
      }
      counts[t] = n;
    }
    for (const t of triggers) stmts.push({ sql: t.sql });
    await h.client.batch(stmts, "write");
    await migrateOrg(h.client);

    const v = await verifyOrg(h.db, orgId);
    if (!v.ok)
      throw unprocessable("The imported books do not verify: the export was altered.", "chain_broken");
    const lh = await ledgerHead(h.db, orgId);
    const ah = await auditHead(h.db, orgId);
    if (lh.hash !== manifest.chain_heads.ledger.hash || ah.hash !== manifest.chain_heads.audit.hash)
      throw unprocessable("The imported chain heads differ from the export's manifest.", "chain_broken");
    await h.write((tx) =>
      appendAudit(
        tx,
        orgId,
        { actor: "user", role: "owner", userId: opts.userId },
        {
          action: "org.import",
          targetType: "org",
          targetId: orgId,
          after: { name, exported_at: manifest.exported_at, cosimo_version: manifest.cosimo_version },
        },
      ),
    );
  } catch (e) {
    h.close();
    await ctx.orgs.dropDatabase(orgId, prov.url).catch(() => {});
    throw e;
  }
  h.close();

  // Registry rows, the importer as owner, and matching members.
  const members = files["members.json"]
    ? (JSON.parse(new TextDecoder().decode(files["members.json"])) as { email: string; role: string }[])
    : [];
  const added: string[] = [];
  const skipped: string[] = [];
  await ctx.system.write(async (tx) => {
    await tx.insert(system.organizations).values({
      id: orgId,
      name,
      dbUrl: prov.url,
      dbTokenEnc: prov.authToken ? ctx.secrets.encrypt(prov.authToken) : null,
      createdBy: opts.userId,
    });
    await tx.insert(system.memberships).values({ userId: opts.userId, orgId, role: "owner" });
  });
  for (const mem of members) {
    const u = await ctx.users.byEmail(mem.email);
    if (!u) {
      skipped.push(mem.email);
      continue;
    }
    if (u.id === opts.userId) continue;
    await ctx.system.write((tx) =>
      tx
        .insert(system.memberships)
        .values({ userId: u.id, orgId, role: mem.role as "owner" | "bookkeeper" | "accountant" | "viewer" })
        .onConflictDoNothing(),
    );
    added.push(mem.email);
  }

  const store = ctx.services.storage as BlobStore;
  let attachments = 0;
  for (const [n, bytes] of Object.entries(files)) {
    if (!n.startsWith("attachments/")) continue;
    await store.put(n.slice("attachments/".length), bytes, "application/octet-stream");
    attachments++;
  }
  return {
    org_id: orgId,
    name,
    tables: counts,
    attachments,
    members_added: added,
    members_skipped: skipped,
    chains_ok: true,
  };
}
