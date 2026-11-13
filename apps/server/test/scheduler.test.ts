import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId, system } from "@cosimo/db";
import { sql } from "drizzle-orm";
import { JOB_RUN_RETENTION_DAYS, pruneJobRuns, type Scheduler } from "../src/jobs/scheduler.ts";
import { createTestEnv, DB_MODE, type TestEnv } from "./harness.ts";

let env: TestEnv;
let scheduler: Scheduler;

beforeAll(async () => {
  env = await createTestEnv();
  scheduler = env.ctx.services.scheduler as Scheduler;
  // Open the write path (it switches local databases to WAL) before an EXPLAIN holds a read open.
  await env.ctx.system.write(async () => {});
});
afterAll(async () => {
  await env.close();
});

/** EXPLAIN QUERY PLAN for exactly the SQL the scheduler runs, with its parameters bound. */
async function plan(job: string, orgId: string | null) {
  const q = scheduler.lastRunQuery(job, orgId).toSQL();
  const parts = q.sql.split("?");
  const stmt = sql.join(
    parts.flatMap((p, i) => (i < q.params.length ? [sql.raw(p), sql`${q.params[i]}`] : [sql.raw(p)])),
  );
  const rows = await env.ctx.system.db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${stmt}`);
  return rows.map((r) => r.detail).join("\n");
}

describe(`scheduler last-run lookup (${DB_MODE})`, () => {
  test("seeks the covering index for org and instance jobs", async () => {
    expect(await plan("payments.poll", "org_x")).toContain("COVERING INDEX job_runs_last_ok_idx");
    expect(await plan("backup.daily", null)).toContain("COVERING INDEX job_runs_last_ok_idx");
  });

  test("returns the newest ok run for that org only", async () => {
    const row = (orgId: string | null, startedAt: string, status: "ok" | "error" | "running") => ({
      id: newId(),
      job: "test.job",
      orgId,
      startedAt,
      status,
    });
    await env.ctx.system.write((tx) =>
      tx
        .insert(system.jobRuns)
        .values([
          row("org_a", "2026-06-01T00:00:00.000Z", "ok"),
          row("org_a", "2026-06-02T00:00:00.000Z", "ok"),
          row("org_a", "2026-06-03T00:00:00.000Z", "error"),
          row("org_b", "2026-06-04T00:00:00.000Z", "ok"),
          row(null, "2026-06-05T00:00:00.000Z", "ok"),
          row(null, "2026-06-06T00:00:00.000Z", "running"),
        ]),
    );
    expect((await scheduler.lastRun("test.job", "org_a"))?.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    expect((await scheduler.lastRun("test.job", "org_b"))?.toISOString()).toBe("2026-06-04T00:00:00.000Z");
    expect((await scheduler.lastRun("test.job", null))?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(await scheduler.lastRun("test.job", "org_c")).toBeNull();
  });
});

describe(`job_runs retention (${DB_MODE})`, () => {
  test("prunes old runs but keeps each pair's newest ok run and recent rows", async () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    expect(JOB_RUN_RETENTION_DAYS).toBe(90);
    const row = (job: string, orgId: string | null, days: number, status: "ok" | "error" | "running") => ({
      id: newId(),
      job,
      orgId,
      startedAt: ago(days),
      status,
    });
    const keep = [
      row("prune.a", "org_a", 200, "ok"), // newest ok for the pair, however old
      row("prune.a", "org_a", 5, "error"),
      row("prune.b", null, 100, "ok"), // newest ok for the NULL-org pair
    ];
    const drop = [
      row("prune.a", "org_a", 300, "ok"), // older ok superseded by a newer one
      row("prune.a", "org_a", 120, "error"),
      row("prune.a", "org_a", 100, "running"),
      row("prune.b", null, 150, "ok"),
      row("prune.b", null, 110, "error"),
      row("prune.c", "org_c", 150, "ok"), // superseded by recentOk below
    ];
    const recentOk = row("prune.c", "org_c", 1, "ok");
    const all = [...keep, ...drop, recentOk];
    await env.ctx.system.write((tx) => tx.insert(system.jobRuns).values(all));
    const before = await Promise.all([
      scheduler.lastRun("prune.a", "org_a"),
      scheduler.lastRun("prune.b", null),
      scheduler.lastRun("prune.c", "org_c"),
    ]);

    await pruneJobRuns(env.ctx, now);

    const left = new Set(
      (await env.ctx.system.db.select({ id: system.jobRuns.id }).from(system.jobRuns)).map((r) => r.id),
    );
    for (const r of [...keep, recentOk]) expect(left.has(r.id)).toBe(true);
    for (const r of drop) expect(left.has(r.id)).toBe(false);
    expect(
      await Promise.all([
        scheduler.lastRun("prune.a", "org_a"),
        scheduler.lastRun("prune.b", null),
        scheduler.lastRun("prune.c", "org_c"),
      ]),
    ).toEqual(before);
  });
});
