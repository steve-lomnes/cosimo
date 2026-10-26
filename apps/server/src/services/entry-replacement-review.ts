/**
 * Replacements of posted entries proposed by AI assistants (SPEC §6 #2, §10.2). A replacement is one
 * `entry_replacement` review item holding the original entry and the corrected one; nothing is
 * written to the ledger while it waits. Approving posts the reversal and the replacement together,
 * rejecting posts neither, so a reviewer can never approve half of it.
 */
import { decide, type LineInput } from "@cosimo/core";
import { newId, type OrgTx, org } from "@cosimo/db";
import type { SourceType } from "@cosimo/shared";
import { and, eq } from "drizzle-orm";
import { conflict } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import {
  assertReversible,
  DOCUMENT_SOURCES,
  debitTotal,
  mustGetEntry,
  policyRules,
  replaceEntryTx,
  settingsRow,
  validateForSave,
} from "./ledger.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";

export interface ReplacementInput {
  date: string;
  memo: string | null;
  lines: LineInput[];
  rationale: string | null;
  /** Copy the original's files to the replacement (default true). */
  keep_attachments?: boolean;
}

/** The replacement as stored in the review item's payload (snake_case, like EntryView lines). */
interface StoredReplacement {
  date: string;
  memo: string | null;
  lines: { account_id: string; amount: number; description: string | null; contact_id: string | null }[];
  /** Absent in payloads stored before #95, which means true. */
  keep_attachments?: boolean;
}

/** Refuses when a replacement of this entry is already waiting in the review queue. */
export async function assertNoPendingReplacement(tx: OrgTx, entryId: string) {
  const pending = await tx
    .select({ id: org.reviewItems.id })
    .from(org.reviewItems)
    .where(
      and(
        eq(org.reviewItems.itemType, "entry_replacement"),
        eq(org.reviewItems.itemId, entryId),
        eq(org.reviewItems.status, "pending"),
      ),
    )
    .get();
  if (pending)
    throw conflict(
      `A replacement of this entry is already waiting for review (${pending.id}).`,
      "already_pending",
    );
}

/**
 * Propose replacing a posted entry. Returns the review item ID, or, when a review policy
 * auto-approves it, the posted reversal and replacement.
 */
export async function proposeReplacementTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  entryId: string,
  input: ReplacementInput,
) {
  const orig = await mustGetEntry(tx, entryId);
  await assertReversible(tx, entryId, null);
  if (DOCUMENT_SOURCES.includes(orig.source_type as SourceType)) {
    throw conflict(
      "This entry was created by a document (invoice, bill, or payment). Correct the document instead.",
      "document_entry",
    );
  }
  await assertNoPendingReplacement(tx, entryId);
  await validateForSave(tx, input.lines, true);
  const amount = Math.max(orig.total, debitTotal(input.lines));
  const s = await settingsRow(tx);
  const decision = decide(
    { actor: a.actor, itemType: "entry_replacement", amount, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (decision.action === "auto_approve") {
    const r = await replaceEntryTx(
      tx,
      orgId,
      a,
      entryId,
      { date: input.date, memo: input.memo, lines: input.lines, rationale: input.rationale },
      { forcePost: true, keepAttachments: input.keep_attachments ?? true },
    );
    return { reviewItemId: null, ...r };
  }
  const replacement: StoredReplacement = {
    date: input.date,
    memo: input.memo,
    lines: input.lines.map((l) => ({
      account_id: l.accountId,
      amount: l.amount,
      description: l.description ?? null,
      contact_id: l.contactId ?? null,
    })),
    keep_attachments: input.keep_attachments ?? true,
  };
  const id = newId();
  const payload = JSON.stringify({ original: orig, replacement });
  await tx.insert(org.reviewItems).values({
    id,
    itemType: "entry_replacement",
    itemId: entryId,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason: decision.reason,
    rationale: input.rationale,
    payloadJson: payload,
    originalPayloadJson: payload,
    amount,
  });
  await appendAudit(tx, orgId, a, {
    action: "entry.propose_replacement",
    targetType: "journal_entry",
    targetId: entryId,
    after: { review_item_id: id, reason: decision.reason, rationale: input.rationale, replacement },
  });
  return { reviewItemId: id, reversal: null, replacement: null };
}

registerReviewHandler("entry_replacement", {
  async approve(tx, orgId, a, item, input) {
    const { replacement } = JSON.parse(item.payloadJson ?? "{}") as { replacement: StoredReplacement };
    // replaceEntryTx rechecks that the original is still reversible, so an entry a person reversed
    // in the meantime fails here with a clear conflict instead of being reversed twice.
    const result = await replaceEntryTx(
      tx,
      orgId,
      a,
      item.itemId,
      {
        date: replacement.date,
        memo: replacement.memo,
        lines: replacement.lines.map((l) => ({
          accountId: l.account_id,
          amount: l.amount,
          description: l.description,
          contactId: l.contact_id,
        })),
        lockOverrideNote: input.lock_override_note ?? null,
        rationale: item.rationale,
      },
      { forcePost: true, keepAttachments: replacement.keep_attachments ?? true },
    );
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return result;
  },
  async reject(tx, orgId, a, item, note) {
    // Nothing was written to the ledger while the proposal waited.
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});
