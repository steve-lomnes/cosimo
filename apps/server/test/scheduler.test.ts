import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId, system } from "@cosimo/db";
import { sql } from "drizzle-orm";
import type { Scheduler } from "../src/jobs/scheduler.ts";
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
