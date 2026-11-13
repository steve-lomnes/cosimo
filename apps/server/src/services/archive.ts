/**
 * Shared pieces for backups and exports: consistent database snapshots and ZIP files.
 *
 * Local SQLite databases are snapshotted with `VACUUM INTO` (never a raw copy of a live file).
 * Remote databases (sqld, Turso) are copied table by table into a local SQLite file, with indexes
 * and triggers created after the data (SPEC §14.1).
 */
import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { sha256Hex } from "@cosimo/core";
import { type Client, createClient, type ResultSet } from "@libsql/client";
import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** Name of the helper column that carries the rowid for keyset paging. */
const ROWID_COL = "__cosimo_rowid";

export async function snapshotDb(client: Client, url: string, out: string): Promise<void> {
  if (existsSync(out)) rmSync(out);
  if (url.startsWith("file:")) {
    await client.execute({ sql: "VACUUM INTO ?", args: [out] });
    return;
  }
  await copyRemote(client, out);
}

/** Copy every table of a remote database into a new local SQLite file. */
export async function copyRemote(src: Client, out: string) {
  const dst = createClient({ url: `file:${out}` });
  try {
    // Rows are copied table by table, not in dependency order.
    await dst.execute("pragma foreign_keys = off");
    const schema = await src.execute(
      "select type, name, tbl_name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by rowid",
    );
    const rows = schema.rows.map((r) => ({
      type: String(r.type),
      name: String(r.name),
      sql: String(r.sql),
    }));
    for (const r of rows.filter((x) => x.type === "table")) await dst.execute(r.sql);
    for (const t of rows.filter((x) => x.type === "table")) {
      const q = `"${t.name.replace(/"/g, '""')}"`;
      // Keyset paging on rowid: an OFFSET makes the server re-read every skipped row, which on a
      // remote database is O(N^2) rows read for a table of N rows.
      let last: number | bigint | null = null;
      for (;;) {
        const rs: ResultSet = await src.execute({
          sql: `select rowid as "${ROWID_COL}", * from ${q} ${last === null ? "" : "where rowid > ? "}order by rowid limit 500`,
          args: last === null ? [] : [last],
        });
        if (!rs.rows.length) break;
        const cols = rs.columns.slice(1);
        const placeholders = cols.map(() => "?").join(", ");
        const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
        await dst.batch(
          rs.rows.map((row) => ({
            sql: `insert into ${q} (${colList}) values (${placeholders})`,
            args: cols.map((_, i) => row[i + 1] ?? null),
          })),
          "write",
        );
        if (rs.rows.length < 500) break;
        last = rs.rows[rs.rows.length - 1]![0] as number | bigint;
      }
    }
    for (const r of rows.filter((x) => x.type !== "table")) await dst.execute(r.sql);
  } finally {
    dst.close();
  }
}

/** The target of `copyToRemote` already holds tables. */
export class TargetNotEmptyError extends Error {
  readonly code = "target_not_empty";
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Schema objects to copy: skips SQLite's and libSQL's internal objects. */
async function userSchema(c: Client) {
  const rs = await c.execute(
    "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and name not like 'libsql_%' and name not like '_litestream%' order by rowid",
  );
  return rs.rows.map((r) => ({ type: String(r.type), name: String(r.name), sql: String(r.sql) }));
}

/** Names of the user tables in a database (the same set `copyToRemote` copies). */
export async function userTables(c: Client): Promise<string[]> {
  return (await userSchema(c)).filter((x) => x.type === "table").map((x) => x.name);
}

/**
 * Copy every table of a local SQLite database into an empty remote one (sqld, Turso): the reverse
 * of `copyRemote`. Tables first, then the rows, then indexes, triggers, and views, so triggers
 * that guard inserts (such as `je_no_insert_posted`) don't fire on copied rows. Rows go in chunks
 * through `migrate`, which turns foreign keys off for its transaction, since tables are copied in
 * schema order rather than dependency order. `_cosimo_migrations` is copied like any other table,
 * so nothing is applied twice. Refuses a target that already has tables.
 */
export async function copyToRemote(src: Client, dst: Client, chunk = 200): Promise<void> {
  const existing = await userTables(dst);
  if (existing.length)
    throw new TargetNotEmptyError(
      `The target database is not empty (it has ${existing.length} table(s), e.g. ${existing[0]}).`,
    );
  const schema = await userSchema(src);
  const tables = schema.filter((x) => x.type === "table");
  await dst.migrate(tables.map((t) => t.sql));
  for (const t of tables) {
    const q = quote(t.name);
    let last: number | bigint | null = null;
    for (;;) {
      const rs: ResultSet = await src.execute({
        sql: `select rowid as "${ROWID_COL}", * from ${q} ${last === null ? "" : "where rowid > ? "}order by rowid limit ${chunk}`,
        args: last === null ? [] : [last],
      });
      if (!rs.rows.length) break;
      const cols = rs.columns.slice(1);
      const sql = `insert into ${q} (${cols.map(quote).join(", ")}) values (${cols.map(() => "?").join(", ")})`;
      await dst.migrate(rs.rows.map((row) => ({ sql, args: cols.map((_, i) => row[i + 1] ?? null) })));
      if (rs.rows.length < chunk) break;
      last = rs.rows[rs.rows.length - 1]![0] as number | bigint;
    }
  }
  const rest = schema.filter((x) => x.type !== "table");
  if (rest.length) await dst.migrate(rest.map((x) => x.sql));
}

export interface ZipSource {
  name: string;
  /** Bytes, or a path to read. */
  data?: Uint8Array;
  path?: string;
  /** Store without compression (already-compressed files such as images and PDFs). */
  store?: boolean;
}

/**
 * Write a ZIP to disk, streaming entry by entry. Returns sha256 and size of every entry. `last`
 * builds a final entry (such as a manifest) from the checksums of everything before it.
 */
export async function writeZip(
  out: string,
  entries: Iterable<ZipSource> | AsyncIterable<ZipSource>,
  last?: (sums: Record<string, { sha256: string; bytes: number }>) => ZipSource,
) {
  const sums: Record<string, { sha256: string; bytes: number }> = {};
  const stream = createWriteStream(out, { mode: 0o600 });
  const done = new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  let failed: Error | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failed = err;
      stream.destroy(err);
      return;
    }
    stream.write(chunk);
    if (final) stream.end();
  });
  const add = (e: ZipSource, record: boolean) => {
    const bytes = e.data ?? new Uint8Array(readFileSync(e.path!));
    if (record) sums[e.name] = { sha256: sha256Hex(bytes), bytes: bytes.length };
    const f = e.store ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 6 });
    zip.add(f);
    f.push(bytes, true);
  };
  for await (const e of entries) add(e, true);
  if (last) add(last({ ...sums }), false);
  zip.end();
  await done;
  if (failed) throw failed;
  return sums;
}

export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export function json(v: unknown) {
  return strToU8(`${JSON.stringify(v, null, 2)}\n`);
}

/** Verify entries against a manifest's `files` map. Returns the names that don't match. */
export function checkSums(
  files: Record<string, Uint8Array>,
  expected: Record<string, { sha256: string }>,
): string[] {
  const bad: string[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = files[name];
    if (!got || sha256Hex(got) !== want.sha256) bad.push(name);
  }
  return bad;
}
