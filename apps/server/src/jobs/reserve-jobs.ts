/**
 * Monthly reserve true-ups (#114): on the 1st of each month, propose a true-up as of the end of the
 * month before for every book-mode reserve on the `monthly` schedule. It runs as the system actor
 * and always waits in the review queue. A reserve with a true-up already pending is skipped.
 */
import { addDays, today } from "@cosimo/shared";
import type { AppContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { systemActor } from "../services/actor.ts";
import { listReserves, pendingTrueUp, proposeReserveTrueUpTx } from "../services/reserves.ts";
import { daily, registerJob } from "./scheduler.ts";

export async function runReserveTrueUps(ctx: AppContext, orgId: string, asOf = today()) {
  const out = { proposed: 0, skipped: 0, unchanged: 0 };
  if (!asOf.endsWith("-01")) return out;
  const through = addDays(asOf, -1);
  const h = await ctx.orgs.mustOpen(orgId);
  for (const r of await listReserves(h.db)) {
    if (r.mode !== "book" || r.true_up_schedule !== "monthly") continue;
    if (await pendingTrueUp(h.db, r.id)) {
      ctx.logger.info("reserve true-up skipped: one is already pending", { org_id: orgId, reserve_id: r.id });
      out.skipped++;
      continue;
    }
    try {
      await h.write((tx) =>
        proposeReserveTrueUpTx(
          tx,
          orgId,
          systemActor(),
          r.id,
          { as_of: through, rationale: `Monthly true-up of ${r.name} through ${through}.` },
          { requireReview: "Scheduled reserve true-up" },
        ),
      );
      out.proposed++;
    } catch (err) {
      if (err instanceof ApiError && err.code === "nothing_to_true_up") out.unchanged++;
      else throw err;
    }
  }
  return out;
}

export function registerReserveJobs() {
  registerJob({
    name: "reserves.true_up",
    scope: "org",
    due: daily(5),
    async run(ctx, orgId) {
      const r = await runReserveTrueUps(ctx, orgId!);
      return `${r.proposed} proposed, ${r.skipped} skipped (pending), ${r.unchanged} already at target`;
    },
  });
}
