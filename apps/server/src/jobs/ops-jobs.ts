/** Daily backup (SPEC §14.1) at `backups.time` (UTC), unless backups are off; housekeeping. */

import { pruneIdempotencyKeys } from "../http/idempotency.ts";
import { createBackup } from "../services/backup.ts";
import { daily, dailyAt, pruneJobRuns, registerJob } from "./scheduler.ts";

export function registerOpsJobs(backupTime: () => string, enabled: () => boolean) {
  registerJob({
    name: "backup.daily",
    scope: "instance",
    due: (now, last) => enabled() && dailyAt(backupTime)(now, last),
    async run(ctx) {
      const r = await createBackup(ctx, { reason: "scheduled" });
      return `${r.name} (${Math.round(r.bytes / 1024)} KB, ${r.orgs} org(s))${r.deleted.length ? `; removed ${r.deleted.length} old` : ""}`;
    },
  });
  registerJob({
    name: "idempotency.prune",
    scope: "instance",
    due: daily(3),
    async run(ctx) {
      await pruneIdempotencyKeys(ctx);
      const n = await pruneJobRuns(ctx);
      return `ok; pruned ${n} job run(s)`;
    },
  });
}
