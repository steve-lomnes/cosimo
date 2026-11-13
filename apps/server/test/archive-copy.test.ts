import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { copyRemote } from "../src/services/archive.ts";

const dir = mkdtempSync(join(tmpdir(), "cosimo-copy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("copyRemote keyset paging", () => {
  test("copies every row without OFFSET, in ceil(n/500) data queries", async () => {
    const src = createClient({ url: `file:${join(dir, "src.db")}` });
    await src.execute("create table big (id integer primary key, name text, n integer)");
    await src.execute("create index big_name_idx on big (name)");
    await src.execute("create table small (k text, v text)");
    await src.batch(
      Array.from({ length: 1500 }, (_, i) => ({
        sql: "insert into big (id, name, n) values (?, ?, ?)",
        args: [i + 1, `row ${i + 1}`, i % 7 === 0 ? null : i],
      })),
      "write",
    );
    // Gaps in rowid.
    await src.execute("delete from big where id % 5 = 0 or id between 600 and 640");
    await src.batch(
      [
        { sql: "insert into small values (?, ?)", args: ["a", "1"] },
        { sql: "insert into small values (?, ?)", args: ["b", null] },
      ],
      "write",
    );
    const total = Number((await src.execute("select count(*) c from big")).rows[0]!.c);

    const seen: string[] = [];
    const spy = new Proxy(src, {
      get(t, p, r) {
        if (p === "execute")
          return (stmt: string | { sql: string }) => {
            seen.push(typeof stmt === "string" ? stmt : stmt.sql);
            return t.execute(stmt as never);
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;

    const out = join(dir, "out.db");
    await copyRemote(spy, out);

    expect(seen.some((s) => /offset/i.test(s))).toBe(false);
    const pages = seen.filter((s) => /from "big"/.test(s)).length;
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(total / 500));
    expect(pages).toBeLessThanOrEqual(Math.ceil(total / 500) + 1);

    const dst = createClient({ url: `file:${out}` });
    for (const sql of ["select * from big order by id", "select * from small order by k"]) {
      expect((await dst.execute(sql)).rows.map((r) => ({ ...r }))).toEqual(
        (await src.execute(sql)).rows.map((r) => ({ ...r })),
      );
    }
    const idx = await dst.execute(
      "select name from sqlite_master where type = 'index' and name = 'big_name_idx'",
    );
    expect(idx.rows.length).toBe(1);
    src.close();
    dst.close();
  });
});
