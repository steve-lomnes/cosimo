/**
 * Recurring templates (#24): invoices, bills, and journal entries created on a schedule.
 *
 * Each occurrence runs in its own transaction and is recorded in `recurring_runs`, keyed on
 * (template, scheduled date), so a rerun or a concurrent run never creates a second document for
 * the same date. A run that fails records `last_error` on the template and doesn't advance; the
 * daily job retries it, and other templates are unaffected. Runs act as the `system` actor, so a
 * template that posts still goes through the review threshold and review policies.
 *
 * Invoices from `post_and_send` templates are emailed from an outbox (`send_status` on the run)
 * after the run commits, including an invoice approved later from the review queue.
 *
 * AI assistants and propose-only tokens can't change templates directly: their changes wait as a
 * `recurring_template` review item, and a proposed template stays inactive until approved.
 */
import {
  decide,
  describeSchedule,
  firstIndexOnOrAfter,
  type LineInput,
  occurrence,
  RECURRENCE_UNITS,
  renderPeriodText,
  type Schedule,
  upcoming,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { addDays, isIsoDate, parseTerms, termsAgree, today } from "@cosimo/shared";
import { and, asc, count, eq, inArray, like, lte, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, forbidden, fromDbError, notFound, unprocessable } from "../http/errors.ts";
import { type ActorInfo, SYSTEM_ACTOR } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { mustGetContact } from "./contacts.ts";
import {
  checkDocLines,
  createBillTx,
  createInvoiceTx,
  finalizeInvoiceTx,
  lineAmount,
  markInvoiceSentTx,
} from "./documents.ts";
import { emailInvoice } from "./invoice-delivery.ts";
import {
  createDraftTx,
  debitTotal,
  policyRules,
  settingsRow,
  submitEntryTx,
  validateForSave,
} from "./ledger.ts";
import type { Mailer } from "./mailer.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgDb | OrgTx;
export type TemplateRow = typeof org.recurringTemplates.$inferSelect;
export type RunRow = typeof org.recurringRuns.$inferSelect;
export type TemplateKind = TemplateRow["kind"];
export type RunMode = TemplateRow["runMode"];
export type TemplateStatus = TemplateRow["status"];

/** One line of a template. Invoices use quantity and unit price, bills an amount, entries a signed amount. */
export interface TemplateLine {
  description?: string | null;
  quantity_milli?: number;
  unit_price?: number;
  amount?: number;
  account_id: string;
  contact_id?: string | null;
}

/** What each run creates. Memo, terms, bill number, and line descriptions may hold period placeholders. */
export interface TemplateBody {
  memo?: string | null;
  terms?: string | null;
  due_days?: number | null;
  bill_number?: string | null;
  lines: TemplateLine[];
}

export interface TemplateInput {
  kind: TemplateKind;
  name: string;
  contact_id?: string | null;
  run_mode: RunMode;
  schedule: Schedule;
  template: TemplateBody;
}

export type ProposalAction = "create" | "update" | "pause" | "resume";

/** Most runs one template makes in one pass: a long-paused catch-up spreads over several days. */
export const MAX_RUNS_PER_PASS = 12;
/** An auto-send invoice still held in review this long after its run is no longer emailed. */
export const SEND_GIVE_UP_DAYS = 30;

// ----------------------------------------------------------------------------- views

export function scheduleOf(t: TemplateRow): Schedule {
  return {
    unit: t.unit,
    interval: t.interval,
    anchor_day: t.anchorDay,
    start_date: t.startDate,
    end_date: t.endDate,
    max_occurrences: t.maxOccurrences,
  };
}

export function bodyOf(t: TemplateRow): TemplateBody {
  return JSON.parse(t.templateJson) as TemplateBody;
}

export function inputOf(t: TemplateRow): TemplateInput {
  return {
    kind: t.kind,
    name: t.name,
    contact_id: t.contactId,
    run_mode: t.runMode,
    schedule: scheduleOf(t),
    template: bodyOf(t),
  };
}

/** The amount one run creates: the document total, or an entry's debit total. */
export function templateTotal(kind: TemplateKind, body: TemplateBody): number {
  if (kind === "invoice")
    return body.lines.reduce((s, l) => s + lineAmount(l.quantity_milli ?? 1000, l.unit_price ?? 0), 0);
  if (kind === "bill") return body.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  return debitTotal(body.lines.map((l) => ({ amount: l.amount ?? 0 })));
}

async function pendingProposal(db: Reader, templateId: string) {
  return db
    .select()
    .from(org.reviewItems)
    .where(
      and(
        eq(org.reviewItems.itemType, "recurring_template"),
        eq(org.reviewItems.itemId, templateId),
        eq(org.reviewItems.status, "pending"),
      ),
    )
    .get();
}

export async function templateView(db: Reader, t: TemplateRow, opts: { upcoming?: number } = {}) {
  const contact = t.contactId
    ? await db
        .select({ name: org.contacts.name })
        .from(org.contacts)
        .where(eq(org.contacts.id, t.contactId))
        .get()
    : undefined;
  const generated = await db
    .select({ n: count() })
    .from(org.recurringRuns)
    .where(and(eq(org.recurringRuns.templateId, t.id), eq(org.recurringRuns.status, "created")))
    .get();
  const review = await pendingProposal(db, t.id);
  const body = bodyOf(t);
  const s = scheduleOf(t);
  const live = t.status === "active" || t.status === "paused" || t.status === "proposed";
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    contact_id: t.contactId,
    contact_name: contact?.name ?? null,
    run_mode: t.runMode,
    status: t.status,
    schedule: {
      unit: t.unit,
      interval: t.interval,
      anchor_day: t.anchorDay,
      start_date: t.startDate,
      end_date: t.endDate,
      max_occurrences: t.maxOccurrences,
    },
    schedule_summary: describeSchedule(s),
    next_index: t.nextIndex,
    next_date: t.nextDate,
    upcoming: live ? upcoming(s, t.nextIndex, opts.upcoming ?? 3).map((o) => o.date) : [],
    total: templateTotal(t.kind, body),
    last_run_date: t.lastRunDate,
    last_error: t.lastError,
    last_error_at: t.lastErrorAt,
    generated_count: generated?.n ?? 0,
    pending_review: review
      ? {
          review_item_id: review.id,
          action:
            ((review.payloadJson ? JSON.parse(review.payloadJson) : {}) as { action?: string }).action ?? "",
        }
      : null,
    template: {
      memo: body.memo ?? null,
      terms: body.terms ?? null,
      due_days: body.due_days ?? null,
      bill_number: body.bill_number ?? null,
      lines: body.lines,
    },
    created_by_actor: t.createdByActor,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}
export type TemplateView = Awaited<ReturnType<typeof templateView>>;

export async function mustGetTemplate(db: Reader, id: string) {
  const t = await db.select().from(org.recurringTemplates).where(eq(org.recurringTemplates.id, id)).get();
  if (!t) throw notFound("Recurring template");
  return t;
}

/** Templates, archived ones left out unless asked for by status. */
export async function listTemplates(
  db: Reader,
  f: { kind?: TemplateKind; status?: TemplateStatus[]; upcoming?: number } = {},
) {
  const conds: SQL[] = [];
  if (f.kind) conds.push(eq(org.recurringTemplates.kind, f.kind));
  conds.push(
    inArray(
      org.recurringTemplates.status,
      f.status?.length ? f.status : ["proposed", "active", "paused", "ended"],
    ),
  );
  const rows = await db
    .select()
    .from(org.recurringTemplates)
    .where(and(...conds))
    .orderBy(asc(org.recurringTemplates.name), asc(org.recurringTemplates.id))
    .all();
  return Promise.all(rows.map((r) => templateView(db, r, { upcoming: f.upcoming })));
}

/** Run history, newest first, with each generated document's number and status. */
export async function listRuns(db: Reader, templateId: string) {
  const rows = await db
    .select()
    .from(org.recurringRuns)
    .where(eq(org.recurringRuns.templateId, templateId))
    .orderBy(asc(org.recurringRuns.scheduledDate))
    .all();
  const out = [];
  for (const r of rows.reverse()) {
    let number: string | null = null;
    let docStatus: string | null = null;
    if (r.docId && r.docType === "invoice") {
      const d = await db
        .select({ n: org.invoices.number, s: org.invoices.status })
        .from(org.invoices)
        .where(eq(org.invoices.id, r.docId))
        .get();
      number = d?.n ?? null;
      docStatus = d?.s ?? "deleted";
    } else if (r.docId && r.docType === "bill") {
      const d = await db
        .select({ n: org.bills.billNumber, s: org.bills.status })
        .from(org.bills)
        .where(eq(org.bills.id, r.docId))
        .get();
      number = d?.n ?? null;
      docStatus = d?.s ?? "deleted";
    } else if (r.docId && r.docType === "entry") {
      const d = await db
        .select({ s: org.journalEntries.status })
        .from(org.journalEntries)
        .where(eq(org.journalEntries.id, r.docId))
        .get();
      docStatus = d?.s ?? "deleted";
    }
    out.push({
      id: r.id,
      occurrence_index: r.occurrenceIndex,
      scheduled_date: r.scheduledDate,
      status: r.status,
      doc_type: r.docType,
      doc_id: r.docId,
      doc_number: number,
      doc_status: docStatus,
      send_status: r.sendStatus,
      error: r.error,
      created_at: r.createdAt,
    });
  }
  return out;
}

/** The run that created a document, for the link back to its template. */
export async function runForDoc(db: Reader, docType: TemplateKind, docId: string) {
  return db
    .select()
    .from(org.recurringRuns)
    .where(and(eq(org.recurringRuns.docType, docType), eq(org.recurringRuns.docId, docId)))
    .get();
}

// ----------------------------------------------------------------------------- validation

function validateSchedule(s: Schedule) {
  if (!RECURRENCE_UNITS.includes(s.unit)) throw unprocessable("Unknown schedule unit.", "invalid_schedule");
  if (!Number.isInteger(s.interval) || s.interval < 1 || s.interval > 1000)
    throw unprocessable("Repeat every 1 to 1000 units.", "invalid_schedule");
  if (s.anchor_day != null) {
    if (s.unit !== "month" && s.unit !== "year")
      throw unprocessable(
        "A day of the month applies only to monthly and yearly schedules.",
        "invalid_schedule",
      );
    if (
      !Number.isInteger(s.anchor_day) ||
      !(s.anchor_day === -1 || (s.anchor_day >= 1 && s.anchor_day <= 31))
    )
      throw unprocessable("The day of the month is 1 to 31, or -1 for the last day.", "invalid_schedule");
  }
  if (!isIsoDate(s.start_date))
    throw unprocessable("The start date is not a valid date.", "invalid_schedule");
  if (s.end_date != null && s.max_occurrences != null)
    throw unprocessable("Give an end date or a number of times, not both.", "invalid_schedule");
  if (s.end_date != null) {
    if (!isIsoDate(s.end_date)) throw unprocessable("The end date is not a valid date.", "invalid_schedule");
    if (s.end_date < s.start_date)
      throw unprocessable("The end date is before the start date.", "invalid_schedule");
  }
  if (s.max_occurrences != null && (!Number.isInteger(s.max_occurrences) || s.max_occurrences < 1))
    throw unprocessable("The number of times must be at least 1.", "invalid_schedule");
  if (!occurrence(s, 0)) throw unprocessable("The schedule has no dates.", "invalid_schedule");
}

/** Keep only the fields a kind uses, with defaults filled in. */
function normalizeBody(kind: TemplateKind, b: TemplateBody): TemplateBody {
  const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  if (kind === "invoice")
    return {
      memo: text(b.memo),
      terms: text(b.terms),
      due_days: b.due_days ?? null,
      lines: b.lines.map((l) => ({
        description: l.description?.trim() || "Item",
        quantity_milli: l.quantity_milli ?? 1000,
        unit_price: l.unit_price ?? l.amount ?? 0,
        account_id: l.account_id,
      })),
    };
  if (kind === "bill")
    return {
      bill_number: text(b.bill_number),
      memo: text(b.memo),
      due_days: b.due_days ?? null,
      lines: b.lines.map((l) => ({
        description: l.description?.trim() || "Item",
        amount: l.amount ?? lineAmount(l.quantity_milli ?? 1000, l.unit_price ?? 0),
        account_id: l.account_id,
      })),
    };
  return {
    memo: text(b.memo),
    lines: b.lines.map((l) => ({
      account_id: l.account_id,
      amount: l.amount ?? 0,
      description: text(l.description),
      contact_id: l.contact_id ?? null,
    })),
  };
}

/** An invoice template's terms and due days must agree, the way an invoice's terms and due date do. */
function checkInvoiceTerms(b: TemplateBody) {
  const rule = parseTerms(b.terms);
  if (rule === "on_due_date") {
    if (b.due_days == null) throw unprocessable('"On due date" needs the due days.', "due_date_required");
  } else if (rule && b.due_days != null) {
    if (rule.kind === "eom" || rule.days !== b.due_days)
      throw unprocessable(
        `${b.terms} doesn't match ${b.due_days} due days. Change one, or leave the due days out and Cosimo sets them from the terms.`,
        "terms_conflict",
      );
  }
}

/**
 * Check a template against the books as they are now: the kind and run mode fit, the contact can
 * take this kind of document and isn't archived, the lines are valid, and the total is positive.
 * Runs call this again, so a contact archived or an account deactivated since shows as a run error.
 */
export async function validateTemplateTx(tx: Reader, input: TemplateInput, opts: { run?: boolean } = {}) {
  if (!input.name?.trim()) throw unprocessable("Give the template a name.", "invalid_template");
  if (input.run_mode === "post_and_send" && input.kind !== "invoice")
    throw unprocessable("Only invoice templates can email automatically.", "invalid_run_mode");
  if (!["draft", "post", "post_and_send"].includes(input.run_mode))
    throw unprocessable("Unknown run mode.", "invalid_run_mode");
  validateSchedule(input.schedule);
  const body = normalizeBody(input.kind, input.template);
  if (!body.lines.length) throw unprocessable("Add at least one line.", "empty");
  // Runs skip this: a template saved before the check existed still runs, with its terms settled below.
  if (input.kind === "invoice" && !opts.run) checkInvoiceTerms(body);
  if (input.kind !== "entry" && !input.contact_id)
    throw unprocessable(
      input.kind === "invoice" ? "Choose the customer." : "Choose the vendor.",
      "invalid_contact",
    );
  if (input.contact_id) {
    const c = await mustGetContact(tx, input.contact_id);
    if (c.archivedAt)
      throw unprocessable(
        `${c.name} is archived. Unarchive the contact or choose another.`,
        "archived_contact",
      );
    if (input.kind === "invoice" && c.kind === "vendor")
      throw unprocessable("That contact is a vendor. Mark it as a customer first.", "invalid_contact");
    if (input.kind === "bill" && c.kind === "customer")
      throw unprocessable("That contact is a customer. Mark it as a vendor first.", "invalid_contact");
  }
  if (input.kind === "entry") {
    const lines: LineInput[] = body.lines.map((l) => ({ accountId: l.account_id, amount: l.amount ?? 0 }));
    await validateForSave(tx, lines, true);
    for (const l of body.lines) if (l.contact_id) await mustGetContact(tx, l.contact_id);
  } else {
    await checkDocLines(
      tx,
      body.lines.map((l) => ({ ...l, description: l.description ?? "" })),
      input.kind,
    );
    if (input.kind === "bill" && body.lines.some((l) => !Number.isSafeInteger(l.amount) || l.amount === 0))
      throw unprocessable("Bill line amounts must be non-zero cents.", "invalid_amount");
  }
  const total = templateTotal(input.kind, body);
  if (total <= 0) throw unprocessable("The template's total must be more than zero.", "invalid_total");
  return { body, total };
}

// ----------------------------------------------------------------------------- changes

const nowIso = () => new Date().toISOString();

/** Where the schedule stands at `index`: its date, and whether an active template has ended. */
function placement(s: Schedule, index: number, status: TemplateStatus) {
  const nextDate = occurrence(s, index);
  let next = status;
  if (!nextDate && (status === "active" || status === "paused")) next = "ended";
  else if (nextDate && status === "ended") next = "active";
  return { nextIndex: index, nextDate, status: next };
}

export async function createTemplateTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: TemplateInput,
  opts: { proposed?: boolean } = {},
) {
  const { body } = await validateTemplateTx(tx, input);
  const id = newId();
  const s = input.schedule;
  await tx.insert(org.recurringTemplates).values({
    id,
    kind: input.kind,
    name: input.name.trim(),
    contactId: input.contact_id ?? null,
    runMode: input.run_mode,
    status: opts.proposed ? "proposed" : "active",
    unit: s.unit,
    interval: s.interval,
    anchorDay: s.anchor_day ?? null,
    startDate: s.start_date,
    endDate: s.end_date ?? null,
    maxOccurrences: s.max_occurrences ?? null,
    nextIndex: 0,
    nextDate: occurrence(s, 0),
    templateJson: JSON.stringify(body),
    createdByActor: a.actor,
  });
  const row = await mustGetTemplate(tx, id);
  await appendAudit(tx, orgId, a, {
    action: opts.proposed ? "recurring_template.propose" : "recurring_template.create",
    targetType: "recurring_template",
    targetId: id,
    after: await templateView(tx, row),
  });
  return row;
}

/**
 * The next index once the schedule is `s`. Unchanged schedules keep their place; a changed one
 * restarts from the day after the last run, so dates already used are never created again.
 */
function indexAfterEdit(t: TemplateRow, s: Schedule) {
  const old = scheduleOf(t);
  const changed =
    old.unit !== s.unit ||
    old.interval !== s.interval ||
    (old.anchor_day ?? null) !== (s.anchor_day ?? null) ||
    old.start_date !== s.start_date ||
    (old.end_date ?? null) !== (s.end_date ?? null) ||
    (old.max_occurrences ?? null) !== (s.max_occurrences ?? null);
  if (!changed) return t.nextIndex;
  return t.lastRunDate ? firstIndexOnOrAfter(s, addDays(t.lastRunDate, 1)) : 0;
}

function assertLive(t: TemplateRow) {
  if (t.status === "archived") throw conflict("This template was deleted.", "invalid_state");
}

/** Replace a template. Edits change only future runs. */
export async function updateTemplateTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: TemplateInput,
) {
  const before = await mustGetTemplate(tx, id);
  assertLive(before);
  if (input.kind !== before.kind) throw unprocessable("A template's kind can't change.", "invalid_template");
  const { body } = await validateTemplateTx(tx, input);
  const s = input.schedule;
  const index = indexAfterEdit(before, s);
  const beforeView = await templateView(tx, before);
  await tx
    .update(org.recurringTemplates)
    .set({
      name: input.name.trim(),
      contactId: input.contact_id ?? null,
      runMode: input.run_mode,
      unit: s.unit,
      interval: s.interval,
      anchorDay: s.anchor_day ?? null,
      startDate: s.start_date,
      endDate: s.end_date ?? null,
      maxOccurrences: s.max_occurrences ?? null,
      templateJson: JSON.stringify(body),
      ...placement(s, index, before.status),
      updatedAt: nowIso(),
    })
    .where(eq(org.recurringTemplates.id, id));
  const after = await mustGetTemplate(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "recurring_template.update",
    targetType: "recurring_template",
    targetId: id,
    before: beforeView,
    after: await templateView(tx, after),
  });
  return after;
}

async function setStatusTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  t: TemplateRow,
  patch: Partial<typeof org.recurringTemplates.$inferInsert>,
  action: string,
) {
  await tx
    .update(org.recurringTemplates)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(org.recurringTemplates.id, t.id));
  const after = await mustGetTemplate(tx, t.id);
  await appendAudit(tx, orgId, a, {
    action,
    targetType: "recurring_template",
    targetId: t.id,
    before: { status: t.status, next_date: t.nextDate },
    after: { status: after.status, next_date: after.nextDate },
  });
  return after;
}

export async function pauseTemplateTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const t = await mustGetTemplate(tx, id);
  if (t.status !== "active")
    throw conflict(`This template is ${t.status}; only active ones can pause.`, "invalid_state");
  return setStatusTx(tx, orgId, a, t, { status: "paused" }, "recurring_template.pause");
}

/** Resume from today on. Dates that passed while paused are not created. */
export async function resumeTemplateTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string, asOf = today()) {
  const t = await mustGetTemplate(tx, id);
  if (t.status !== "paused") throw conflict(`This template is ${t.status}, not paused.`, "invalid_state");
  const s = scheduleOf(t);
  const index = Math.max(t.nextIndex, firstIndexOnOrAfter(s, asOf));
  return setStatusTx(tx, orgId, a, t, placement(s, index, "active"), "recurring_template.resume");
}

/** Delete a template: it is archived, so its run history and document links stay. */
export async function archiveTemplateTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const t = await mustGetTemplate(tx, id);
  assertLive(t);
  const pending = await pendingProposal(tx, id);
  if (pending)
    await tx
      .update(org.reviewItems)
      .set({ status: "rejected", decidedBy: a.userId, decidedAt: nowIso(), decisionNote: "Template deleted" })
      .where(eq(org.reviewItems.id, pending.id));
  return setStatusTx(tx, orgId, a, t, { status: "archived", nextDate: null }, "recurring_template.delete");
}

/** Move past the next date without creating anything. Also how a failing date is given up on. */
export async function skipNextTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const t = await mustGetTemplate(tx, id);
  if ((t.status !== "active" && t.status !== "paused") || !t.nextDate)
    throw conflict(`This template is ${t.status}; there is no next date to skip.`, "invalid_state");
  const existing = await runOn(tx, t.id, t.nextDate);
  if (!existing)
    await tx.insert(org.recurringRuns).values({
      id: newId(),
      templateId: t.id,
      occurrenceIndex: t.nextIndex,
      scheduledDate: t.nextDate,
      status: "skipped",
    });
  const after = await advanceTx(tx, t, t.nextDate);
  await appendAudit(tx, orgId, a, {
    action: "recurring_template.skip",
    targetType: "recurring_template",
    targetId: t.id,
    after: { skipped: t.nextDate, next_date: after.nextDate },
  });
  return after;
}

// ----------------------------------------------------------------------------- runs

async function runOn(db: Reader, templateId: string, date: string) {
  return db
    .select()
    .from(org.recurringRuns)
    .where(and(eq(org.recurringRuns.templateId, templateId), eq(org.recurringRuns.scheduledDate, date)))
    .get();
}

/** Step to the next occurrence after `date` was used, clearing any error. */
async function advanceTx(tx: OrgTx, t: TemplateRow, date: string) {
  await tx
    .update(org.recurringTemplates)
    .set({
      ...placement(scheduleOf(t), t.nextIndex + 1, t.status),
      lastRunDate: date,
      lastError: null,
      lastErrorAt: null,
      updatedAt: nowIso(),
    })
    .where(eq(org.recurringTemplates.id, t.id));
  return mustGetTemplate(tx, t.id);
}

/**
 * Create the template's next occurrence, if it is due by `asOf` (or with `early`, whenever it
 * falls; a future occurrence run early is dated `asOf`, #84). Returns null when nothing is due.
 * When a run already exists for that date, only the schedule advances: that is what makes reruns
 * and concurrent runs safe.
 */
export async function runOccurrenceTx(
  tx: OrgTx,
  orgId: string,
  id: string,
  asOf: string,
  opts: { early?: boolean } = {},
) {
  const t = await mustGetTemplate(tx, id);
  const date = t.nextDate;
  if (t.status !== "active" || !date) return null;
  if (!opts.early && date > asOf) return null;
  // An early run of a future occurrence is dated today; the schedule still keeps the scheduled date.
  const issueDate = opts.early && date > asOf ? asOf : date;
  const existing = await runOn(tx, t.id, date);
  if (existing) {
    await advanceTx(tx, t, date);
    return { run: existing, created: false };
  }
  const { body } = await validateTemplateTx(tx, inputOf(t), { run: true });
  const s = await settingsRow(tx);
  if (s.hardLockDate && issueDate <= s.hardLockDate)
    throw unprocessable(
      `The books are closed through ${s.hardLockDate} (hard lock), so the ${issueDate} run can't be created. Skip this date, or ask an owner to move the lock.`,
      "hard_locked",
    );
  // Period text follows the scheduled date: running December's rent early still says "December".
  const r = (v: string | null | undefined) => (v ? renderPeriodText(v, date) : v);
  const posts = t.runMode !== "draft";
  let docId: string;
  if (t.kind === "invoice") {
    const due = body.due_days != null ? addDays(issueDate, body.due_days) : null;
    const terms = r(body.terms) ?? null;
    // The due date wins over terms that disagree with it (templates saved before terms were checked).
    const keepTerms = due ? termsAgree(issueDate, terms, due) : parseTerms(terms) !== "on_due_date";
    const inv = await createInvoiceTx(
      tx,
      orgId,
      SYSTEM_ACTOR,
      {
        customer_id: t.contactId!,
        issue_date: issueDate,
        due_date: due,
        terms: keepTerms ? terms : null,
        memo: r(body.memo) ?? null,
        lines: body.lines.map((l) => ({ ...l, description: r(l.description) ?? "Item" })),
      },
      { recurringId: t.id },
    );
    if (posts) await finalizeInvoiceTx(tx, orgId, SYSTEM_ACTOR, inv.id);
    docId = inv.id;
  } else if (t.kind === "bill") {
    const { bill } = await createBillTx(
      tx,
      orgId,
      SYSTEM_ACTOR,
      {
        vendor_id: t.contactId!,
        bill_number: r(body.bill_number) ?? null,
        issue_date: issueDate,
        due_date: addDays(issueDate, body.due_days ?? 30),
        memo: r(body.memo) ?? null,
        lines: body.lines.map((l) => ({ ...l, description: r(l.description) ?? "Item" })),
        draft: !posts,
      },
      { recurringId: t.id },
    );
    docId = bill.id;
  } else {
    const entry = {
      date: issueDate,
      memo: r(body.memo) || t.name,
      lines: body.lines.map((l) => ({
        accountId: l.account_id,
        amount: l.amount ?? 0,
        description: r(l.description) ?? null,
        contactId: l.contact_id ?? t.contactId ?? null,
      })),
      rationale: `Created by the recurring template "${t.name}".`,
    };
    docId = posts
      ? (await submitEntryTx(tx, orgId, SYSTEM_ACTOR, entry)).entry.id
      : await createDraftTx(tx, orgId, SYSTEM_ACTOR, entry);
  }
  const runId = newId();
  await tx.insert(org.recurringRuns).values({
    id: runId,
    templateId: t.id,
    occurrenceIndex: t.nextIndex,
    scheduledDate: date,
    status: "created",
    docType: t.kind,
    docId,
    sendStatus: t.runMode === "post_and_send" ? "pending" : "not_needed",
  });
  await advanceTx(tx, t, date);
  await appendAudit(tx, orgId, SYSTEM_ACTOR, {
    action: "recurring_template.run",
    targetType: "recurring_template",
    targetId: t.id,
    after: {
      scheduled_date: date,
      issue_date: issueDate,
      doc_type: t.kind,
      doc_id: docId,
      early: Boolean(opts.early),
    },
  });
  const run = (await tx.select().from(org.recurringRuns).where(eq(org.recurringRuns.id, runId)).get())!;
  return { run, created: true };
}

/** A run's error as shown on the template: the API message, or a lock-date trigger's message. */
export function runErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const db = fromDbError(err);
  if (db) return db.message;
  return String((err as Error)?.message ?? err).slice(0, 1000);
}

export async function recordRunErrorTx(tx: OrgTx, id: string, message: string) {
  await tx
    .update(org.recurringTemplates)
    .set({ lastError: message, lastErrorAt: nowIso() })
    .where(eq(org.recurringTemplates.id, id));
}

/** Active templates with a date due by `asOf`. */
export async function dueTemplates(db: Reader, asOf: string) {
  return db
    .select({ id: org.recurringTemplates.id })
    .from(org.recurringTemplates)
    .where(and(eq(org.recurringTemplates.status, "active"), lte(org.recurringTemplates.nextDate, asOf)))
    .orderBy(asc(org.recurringTemplates.nextDate))
    .all();
}

/**
 * Run one template, one occurrence per transaction: everything due by `asOf` (up to
 * MAX_RUNS_PER_PASS), or with `early` just the next occurrence. Stops at the first failure, which
 * is recorded on the template in its own transaction.
 */
export async function runTemplate(
  h: OrgHandle,
  orgId: string,
  id: string,
  asOf: string,
  opts: { early?: boolean } = {},
) {
  let created = 0;
  const limit = opts.early ? 1 : MAX_RUNS_PER_PASS;
  for (let i = 0; i < limit; i++) {
    const before = await mustGetTemplate(h.db, id);
    try {
      const r = await h.write((tx) => runOccurrenceTx(tx, orgId, id, asOf, opts));
      if (!r) break;
      if (r.created) created++;
    } catch (err) {
      // Another process created this date first and the unique run key refused ours: not an error.
      if (before.nextDate && (await runOn(h.db, id, before.nextDate))) continue;
      const message = runErrorMessage(err);
      await h.write((tx) => recordRunErrorTx(tx, id, message));
      return { created, error: message };
    }
  }
  return { created, error: null as string | null };
}

/**
 * Email invoices from post_and_send runs. An invoice still waiting in the review queue stays
 * pending, so it goes out once approved (or is dropped after SEND_GIVE_UP_DAYS). A void or deleted
 * invoice needs no email. Each email and its "sent" mark are recorded together after sending, so a
 * crash in between re-sends rather than loses it.
 */
export async function drainOutbox(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  asOf = today(),
  templateId?: string,
) {
  const pending = await h.db
    .select()
    .from(org.recurringRuns)
    .where(
      and(
        eq(org.recurringRuns.sendStatus, "pending"),
        templateId ? eq(org.recurringRuns.templateId, templateId) : undefined,
      ),
    )
    .orderBy(asc(org.recurringRuns.scheduledDate))
    .all();
  if (!pending.length) return { sent: 0, waiting: 0 };
  const mailer = ctx.services.mailer as Mailer | undefined;
  const configured = mailer ? await mailer.isConfigured() : false;
  const giveUpBefore = `${addDays(asOf, -SEND_GIVE_UP_DAYS)}T`;
  let sent = 0;
  let waiting = 0;
  const setRun = (id: string, patch: Partial<RunRow>) =>
    h.write((tx) => tx.update(org.recurringRuns).set(patch).where(eq(org.recurringRuns.id, id)));
  for (const run of pending) {
    const inv = run.docId
      ? await h.db.select().from(org.invoices).where(eq(org.invoices.id, run.docId)).get()
      : undefined;
    if (!inv || inv.status === "void") {
      await setRun(run.id, { sendStatus: "not_needed" });
      continue;
    }
    if (inv.sentAt) {
      await setRun(run.id, { sendStatus: "sent", error: null });
      continue;
    }
    if (inv.status === "draft") {
      if (run.createdAt < giveUpBefore) await setRun(run.id, { sendStatus: "not_needed" });
      else waiting++;
      continue;
    }
    if (!configured) {
      const message = `Invoice ${inv.number} is waiting to be emailed, but email is not set up. Ask your instance admin to add SMTP settings; it is sent once they do.`;
      await h.write(async (tx) => {
        await tx.update(org.recurringRuns).set({ error: message }).where(eq(org.recurringRuns.id, run.id));
        await recordRunErrorTx(tx, run.templateId, message);
      });
      waiting++;
      continue;
    }
    try {
      const { to } = await emailInvoice(ctx, h.db, orgId, inv.id);
      await h.write(async (tx) => {
        await markInvoiceSentTx(tx, orgId, SYSTEM_ACTOR, inv.id, to);
        await tx
          .update(org.recurringRuns)
          .set({ sendStatus: "sent", error: null })
          .where(eq(org.recurringRuns.id, run.id));
        // Clear the template's error if it was about this invoice's email.
        await tx
          .update(org.recurringTemplates)
          .set({ lastError: null, lastErrorAt: null })
          .where(
            and(
              eq(org.recurringTemplates.id, run.templateId),
              like(org.recurringTemplates.lastError, `Invoice ${inv.number} %`),
            ),
          );
      });
      sent++;
    } catch (err) {
      // A problem with the invoice itself (no recipient) won't fix itself; a mail server error might.
      const permanent = err instanceof ApiError;
      const message = `Invoice ${inv.number} was not emailed: ${runErrorMessage(err)}`;
      await h.write(async (tx) => {
        await tx
          .update(org.recurringRuns)
          .set({ error: message, sendStatus: permanent ? "failed" : "pending" })
          .where(eq(org.recurringRuns.id, run.id));
        await recordRunErrorTx(tx, run.templateId, message);
      });
      ctx.logger.warn("recurring invoice email failed", { org_id: orgId, invoice_id: inv.id, err });
    }
  }
  return { sent, waiting };
}

// ----------------------------------------------------------------------------- proposals

/** AI assistants and propose-only tokens change templates only through the review queue. */
export function mustPropose(a: ActorInfo) {
  return a.actor === "mcp" || Boolean(a.proposeOnly);
}

export function assertCanChangeDirectly(a: ActorInfo, what: string) {
  if (mustPropose(a)) throw forbidden(`${what} needs a person or a full-access API token.`);
}

interface ProposalPayload {
  action: ProposalAction;
  template: TemplateView;
  before?: TemplateView;
  input?: TemplateInput;
}

/**
 * Propose creating, changing, pausing, or resuming a template. Returns the template and the review
 * item, or no review item when a review policy approved it. A template that emails customers is
 * always reviewed: no policy can approve that for an assistant or a propose-only token.
 */
export async function proposeTemplateTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  p: { action: ProposalAction; templateId?: string; input?: TemplateInput; rationale: string | null },
) {
  let t: TemplateRow;
  let before: TemplateView | undefined;
  let after: TemplateView;
  let input: TemplateInput | undefined;
  if (p.action === "create") {
    if (!p.input) throw unprocessable("Give the template to create.", "invalid_template");
    t = await createTemplateTx(tx, orgId, a, p.input, { proposed: true });
    after = await templateView(tx, t);
  } else {
    if (!p.templateId) throw unprocessable("Give the template_id to change.", "invalid_template");
    t = await mustGetTemplate(tx, p.templateId);
    assertLive(t);
    const waiting = await pendingProposal(tx, t.id);
    if (waiting)
      throw conflict(
        `A change to this template is already waiting for review (${waiting.id}).`,
        "already_pending",
      );
    before = await templateView(tx, t);
    if (p.action === "update") {
      if (!p.input) throw unprocessable("Give the changes to make.", "invalid_template");
      if (p.input.kind !== t.kind) throw unprocessable("A template's kind can't change.", "invalid_template");
      const { body } = await validateTemplateTx(tx, p.input);
      input = { ...p.input, name: p.input.name.trim(), template: body };
      // What the template would look like, for the reviewer; nothing changes until approval.
      after = await templateView(tx, {
        ...t,
        name: input.name,
        contactId: input.contact_id ?? null,
        runMode: input.run_mode,
        unit: input.schedule.unit,
        interval: input.schedule.interval,
        anchorDay: input.schedule.anchor_day ?? null,
        startDate: input.schedule.start_date,
        endDate: input.schedule.end_date ?? null,
        maxOccurrences: input.schedule.max_occurrences ?? null,
        templateJson: JSON.stringify(body),
        ...placement(input.schedule, indexAfterEdit(t, input.schedule), t.status),
      });
    } else if (p.action === "pause") {
      if (t.status !== "active")
        throw conflict(`This template is ${t.status}; only active ones can pause.`, "invalid_state");
      after = { ...before, status: "paused" };
    } else {
      if (t.status !== "paused") throw conflict(`This template is ${t.status}, not paused.`, "invalid_state");
      after = { ...before, status: "active" };
    }
  }
  const s = await settingsRow(tx);
  let decision = decide(
    { actor: a.actor, itemType: "recurring_template", amount: after.total, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (after.run_mode === "post_and_send" && p.action !== "pause" && mustPropose(a))
    decision = {
      action: "require_review",
      reason: "A template that emails invoices to customers automatically is always reviewed.",
      ruleId: null,
    };
  if (decision.action === "auto_approve") {
    const applied = await applyProposalTx(tx, orgId, a, p.action, t.id, input);
    return { template: applied, reviewItemId: null as string | null, proposed: null as TemplateView | null };
  }
  const reviewItemId = newId();
  const payload: ProposalPayload = { action: p.action, template: after, before, input };
  const json = JSON.stringify(payload);
  await tx.insert(org.reviewItems).values({
    id: reviewItemId,
    itemType: "recurring_template",
    itemId: t.id,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason: decision.reason,
    rationale: p.rationale,
    payloadJson: json,
    originalPayloadJson: json,
    amount: after.total,
  });
  if (p.action !== "create")
    await appendAudit(tx, orgId, a, {
      action: "recurring_template.propose",
      targetType: "recurring_template",
      targetId: t.id,
      after: {
        review_item_id: reviewItemId,
        action: p.action,
        reason: decision.reason,
        rationale: p.rationale,
      },
    });
  // `proposed` is the template as it would be once approved, for the proposer to show.
  return {
    template: await mustGetTemplate(tx, t.id),
    reviewItemId: reviewItemId as string | null,
    proposed: after as TemplateView | null,
  };
}

/** Carry out an approved proposal. The template is checked again against the books as they are now. */
async function applyProposalTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  action: ProposalAction,
  id: string,
  input?: TemplateInput,
) {
  switch (action) {
    case "create": {
      const t = await mustGetTemplate(tx, id);
      if (t.status !== "proposed") throw conflict(`This template is already ${t.status}.`, "invalid_state");
      await validateTemplateTx(tx, inputOf(t));
      return setStatusTx(
        tx,
        orgId,
        a,
        t,
        placement(scheduleOf(t), t.nextIndex, "active"),
        "recurring_template.activate",
      );
    }
    case "update":
      if (!input) throw unprocessable("The proposal has no changes.", "invalid_template");
      return updateTemplateTx(tx, orgId, a, id, input);
    case "pause":
      return pauseTemplateTx(tx, orgId, a, id);
    case "resume":
      return resumeTemplateTx(tx, orgId, a, id);
  }
}

registerReviewHandler("recurring_template", {
  async approve(tx, orgId, a, item, input) {
    const p = JSON.parse(item.payloadJson ?? "{}") as ProposalPayload;
    const t = await applyProposalTx(tx, orgId, a, p.action, item.itemId, p.input);
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return templateView(tx, t);
  },
  async reject(tx, orgId, a, item, note) {
    const p = JSON.parse(item.payloadJson ?? "{}") as ProposalPayload;
    // A proposed template that is turned down never existed; the review item keeps a snapshot.
    if (p.action === "create") {
      const t = await tx
        .select()
        .from(org.recurringTemplates)
        .where(eq(org.recurringTemplates.id, item.itemId))
        .get();
      if (t?.status === "proposed")
        await tx.delete(org.recurringTemplates).where(eq(org.recurringTemplates.id, t.id));
    }
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});
