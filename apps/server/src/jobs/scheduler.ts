/**
 * In-process job scheduler. Jobs declare when they are due based on their last successful run;
 * the scheduler ticks once a minute and records every run in `job_runs` so status survives
 * restarts and shows in the admin screen. Per-org jobs run once for every active org.
 */
import { newId, system } from "@cosimo/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";

export interface JobDef {
  name: string;
  /** "org" jobs run for each active org; "instance" jobs once. */
  scope: "org" | "instance";
  /**
   * Given the last successful start time (or null), is the job due now? Org jobs also get the org,
   * for schedules that depend on its settings.
   */
  due(now: Date, last: Date | null, ctx: AppContext, orgId?: string | null): boolean | Promise<boolean>;
  run(ctx: AppContext, orgId: string | null): Promise<string | undefined>;
}

const jobs: JobDef[] = [];

export function registerJob(j: JobDef) {
  if (!jobs.some((x) => x.name === j.name)) jobs.push(j);
}

export function registeredJobs(): readonly JobDef[] {
  return jobs;
}

/** Due once per UTC day after `HH:MM` (UTC), e.g. backups.time. */
export function dailyAt(time: () => string) {
  return (now: Date, last: Date | null) => {
    const [h, m] = time().split(":").map(Number);
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (mins < (h ?? 3) * 60 + (m ?? 0)) return false;
    return !last || last.toISOString().slice(0, 10) < now.toISOString().slice(0, 10);
  };
}

/** Due once per UTC day, after `hour`. */
export function daily(hour = 2) {
  return (now: Date, last: Date | null) => {
    if (now.getUTCHours() < hour) return false;
    return !last || last.toISOString().slice(0, 10) < now.toISOString().slice(0, 10);
  };
}

/** Due every `hours` hours. */
export function everyHours(hours: number) {
  return (now: Date, last: Date | null) =>
    !last || now.getTime() - last.getTime() >= hours * 3_600_000 - 30_000;
}

/** Due once a week on `weekday` (0 = Sunday), after `hour` UTC. */
export function weekly(weekday: () => number, hour = 3) {
  return (now: Date, last: Date | null) => {
    if (now.getUTCDay() !== weekday() || now.getUTCHours() < hour) return false;
    return !last || now.getTime() - last.getTime() > 24 * 3_600_000;
  };
}

export class Scheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly tickMs = 60_000,
  ) {}

  start() {
    if (this.#timer || !this.ctx.config.jobs.enabled) return;
    this.#timer = setInterval(() => void this.tick(), this.tickMs);
    // First tick shortly after start so a restart does not delay overdue work by a minute.
    setTimeout(() => void this.tick(), 5_000);
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /**
   * The last successful run of `job` for `orgId`. This runs for every job and org on every tick, so
   * it must stay an index seek (`job_runs_last_ok_idx`), not a walk over the job's history.
   */
  lastRunQuery(job: string, orgId: string | null) {
    return this.ctx.system.db
      .select({ startedAt: system.jobRuns.startedAt })
      .from(system.jobRuns)
      .where(
        and(
          eq(system.jobRuns.job, job),
          eq(system.jobRuns.status, "ok"),
          orgId ? eq(system.jobRuns.orgId, orgId) : isNull(system.jobRuns.orgId),
        ),
      )
      .orderBy(desc(system.jobRuns.startedAt))
      .limit(1);
  }

  async lastRun(job: string, orgId: string | null) {
    const row = await this.lastRunQuery(job, orgId).get();
    return row ? new Date(row.startedAt) : null;
  }

  /** Run every due job once. Overlapping ticks are skipped. */
  tick(now = new Date()): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      try {
        // One org listing per tick, not one per org-scoped job.
        let orgIds: string[] | null = null;
        for (const j of jobs) {
          if (j.scope === "org" && !orgIds) orgIds = (await this.ctx.orgs.list()).map((o) => o.id);
          const targets = j.scope === "org" ? orgIds! : [null];
          for (const orgId of targets) {
            if (!(await j.due(now, await this.lastRun(j.name, orgId), this.ctx, orgId))) continue;
            await this.runJob(j, orgId);
          }
        }
      } catch (err) {
        this.ctx.logger.error("scheduler tick failed", { err });
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  async runJob(j: JobDef, orgId: string | null) {
    const id = newId();
    const startedAt = new Date().toISOString();
    await this.ctx.system.write((tx) =>
      tx.insert(system.jobRuns).values({ id, job: j.name, orgId, startedAt, status: "running" }),
    );
    let status: "ok" | "error" = "ok";
    let detail: string | null = null;
    try {
      detail = (await j.run(this.ctx, orgId)) ?? null;
    } catch (err) {
      status = "error";
      detail = String((err as Error)?.message ?? err).slice(0, 2000);
      this.ctx.logger.error("job failed", { job: j.name, org_id: orgId, err });
    }
    await this.ctx.system.write((tx) =>
      tx
        .update(system.jobRuns)
        .set({ status, detail, finishedAt: new Date().toISOString() })
        .where(eq(system.jobRuns.id, id)),
    );
    return { status, detail };
  }
}
