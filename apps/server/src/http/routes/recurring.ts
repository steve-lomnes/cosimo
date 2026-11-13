/**
 * Recurring templates API (#24): invoices, bills, and journal entries created on a schedule.
 * AI assistants and propose-only tokens create, change, pause, and resume templates through the
 * review queue; deleting, skipping, and running need a person or a full-access token.
 */
import { RECURRENCE_UNITS, upcoming } from "@cosimo/core";
import { today } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import {
  archiveTemplateTx,
  assertCanChangeDirectly,
  createTemplateTx,
  drainOutbox,
  listRuns,
  listTemplates,
  mustGetTemplate,
  mustPropose,
  pauseTemplateTx,
  proposeTemplateTx,
  resumeTemplateTx,
  runTemplate,
  scheduleOf,
  skipNextTx,
  type TemplateInput,
  type TemplateStatus,
  templateView,
  updateTemplateTx,
} from "../../services/recurring.ts";
import { conflict } from "../errors.ts";
import { requireWriter } from "../middleware.ts";
import {
  bearerSecurity,
  Cents,
  errorResponses,
  Id,
  IsoDate,
  json,
  jsonBody,
  newRouter,
  OrgParams,
  z,
} from "../openapi.ts";
import type { OrgScope } from "../types.ts";

const KINDS = ["invoice", "bill", "entry"] as const;
const STATUSES = ["proposed", "active", "paused", "ended", "archived"] as const;
const TAGS = ["Recurring"];

const ScheduleSchema = z.object({
  unit: z.enum(RECURRENCE_UNITS),
  interval: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1)
    .openapi({ description: "Every N units; quarterly is 3 months" }),
  anchor_day: z.number().int().min(-1).max(31).nullable().optional().openapi({
    description:
      "Monthly and yearly only: the day of the month (1-31, clamped to short months) or -1 for the last day. Defaults to the start date's day.",
  }),
  start_date: IsoDate,
  end_date: IsoDate.nullable()
    .optional()
    .openapi({ description: "Inclusive. Give this or max_occurrences." }),
  max_occurrences: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .nullable()
    .optional()
    .openapi({ description: "Schedule slots in total, skipped ones included" }),
});

const Text = (max: number) =>
  z.string().max(max).nullable().optional().openapi({
    description: "May use {month}, {year}, {quarter}, {period}, {date}, and offsets like {month-1}",
  });
const DueDays = z.number().int().min(0).max(365).nullable().optional();

const InvoiceTemplate = z.object({
  memo: Text(2000),
  terms: z.string().max(100).nullable().optional(),
  due_days: DueDays.openapi({ description: "Days after the issue date; defaults to the terms" }),
  lines: z
    .array(
      z.object({
        description: Text(1000),
        quantity_milli: z.number().int().min(1).max(1_000_000_000).optional(),
        unit_price: Cents,
        account_id: Id,
      }),
    )
    .min(1)
    .max(200),
});
const BillTemplate = z.object({
  bill_number: Text(60),
  memo: Text(2000),
  due_days: DueDays.openapi({ description: "Days after the issue date; defaults to 30" }),
  lines: z
    .array(z.object({ description: Text(1000), amount: Cents, account_id: Id }))
    .min(1)
    .max(200),
});
const EntryTemplate = z.object({
  memo: Text(500),
  lines: z
    .array(
      z.object({
        account_id: Id,
        amount: Cents.openapi({ description: "Debit positive, credit negative" }),
        description: Text(1000),
        contact_id: Id.nullable().optional(),
      }),
    )
    .min(2)
    .max(200),
});

const Base = {
  name: z.string().trim().min(1).max(200),
  schedule: ScheduleSchema,
  rationale: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .openapi({ description: "Shown in the review queue when the change is a proposal" }),
};
const TemplateInputSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("invoice"),
      contact_id: Id,
      run_mode: z.enum(["draft", "post", "post_and_send"]),
      template: InvoiceTemplate,
      ...Base,
    }),
    z.object({
      kind: z.literal("bill"),
      contact_id: Id,
      run_mode: z.enum(["draft", "post"]),
      template: BillTemplate,
      ...Base,
    }),
    z.object({
      kind: z.literal("entry"),
      contact_id: Id.nullable().optional(),
      run_mode: z.enum(["draft", "post"]),
      template: EntryTemplate,
      ...Base,
    }),
  ])
  .openapi("RecurringTemplateInput");

const TemplateSchema = z
  .object({
    id: z.string(),
    kind: z.enum(KINDS),
    name: z.string(),
    contact_id: z.string().nullable(),
    contact_name: z.string().nullable(),
    run_mode: z.enum(["draft", "post", "post_and_send"]),
    status: z.enum(STATUSES),
    schedule: z.object({
      unit: z.enum(RECURRENCE_UNITS),
      interval: z.number().int(),
      anchor_day: z.number().int().nullable(),
      start_date: z.string(),
      end_date: z.string().nullable(),
      max_occurrences: z.number().int().nullable(),
    }),
    schedule_summary: z.string(),
    next_index: z.number().int(),
    next_date: z.string().nullable(),
    upcoming: z.array(z.string()),
    total: Cents,
    last_run_date: z.string().nullable(),
    last_error: z.string().nullable(),
    last_error_at: z.string().nullable(),
    generated_count: z.number().int(),
    pending_review: z.object({ review_item_id: z.string(), action: z.string() }).nullable(),
    template: z.object({
      memo: z.string().nullable(),
      terms: z.string().nullable(),
      due_days: z.number().int().nullable(),
      bill_number: z.string().nullable(),
      lines: z.array(
        z.object({
          description: z.string().nullable().optional(),
          quantity_milli: z.number().int().optional(),
          unit_price: Cents.optional(),
          amount: Cents.optional(),
          account_id: z.string(),
          contact_id: z.string().nullable().optional(),
        }),
      ),
    }),
    created_by_actor: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RecurringTemplate");

const RunSchema = z
  .object({
    id: z.string(),
    occurrence_index: z.number().int(),
    scheduled_date: z.string(),
    status: z.enum(["created", "skipped"]),
    doc_type: z.enum(KINDS).nullable(),
    doc_id: z.string().nullable(),
    doc_number: z.string().nullable(),
    doc_status: z.string().nullable(),
    send_status: z.enum(["pending", "sent", "failed", "not_needed"]),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("RecurringRun");

const TemplateParams = OrgParams.extend({
  templateId: Id.openapi({ param: { name: "templateId", in: "path" } }),
});
const RationaleBody = z.object({ rationale: z.string().max(2000).nullable().optional() });

function toInput(b: z.output<typeof TemplateInputSchema>): TemplateInput {
  const { rationale: _r, ...rest } = b;
  return rest;
}

async function view(o: OrgScope, id: string) {
  return templateView(o.handle.db, await mustGetTemplate(o.handle.db, id));
}

export function recurringRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/recurring-templates",
      tags: TAGS,
      summary: "List recurring templates",
      description: "Deleted (archived) templates are left out unless `status` asks for them.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          kind: z.enum(KINDS).optional(),
          status: z.string().optional().openapi({ description: "Comma-separated statuses" }),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(TemplateSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const status = q.status
        ?.split(",")
        .filter((s): s is TemplateStatus => (STATUSES as readonly string[]).includes(s));
      return c.json({ data: await listTemplates(c.get("org").handle.db, { kind: q.kind, status }) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/recurring-templates",
      tags: TAGS,
      summary: "Create a recurring template",
      description:
        "Documents are created each morning when due. From an AI assistant or a propose-only token, the template waits in the review queue as `proposed` until a person approves it.",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(TemplateInputSchema) },
      responses: { 201: json(TemplateSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const t = await o.handle.write(async (tx) =>
        mustPropose(o.actor)
          ? (
              await proposeTemplateTx(tx, o.id, o.actor, {
                action: "create",
                input: toInput(b),
                rationale: b.rationale ?? null,
              })
            ).template
          : createTemplateTx(tx, o.id, o.actor, toInput(b)),
      );
      return c.json(await templateView(o.handle.db, t), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/recurring-templates/{templateId}",
      tags: TAGS,
      summary: "Get a recurring template and its run history",
      security: bearerSecurity,
      request: { params: TemplateParams },
      responses: {
        200: json(z.object({ template: TemplateSchema, runs: z.array(RunSchema) })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const id = c.req.valid("param").templateId as string;
      return c.json({ template: await view(o, id), runs: await listRuns(o.handle.db, id) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/recurring-templates/{templateId}",
      tags: TAGS,
      summary: "Replace a recurring template",
      description:
        "Changes apply to future runs only. A schedule change continues from the day after the last run. From an AI assistant or a propose-only token, the change waits in the review queue.",
      security: bearerSecurity,
      request: { params: TemplateParams, body: jsonBody(TemplateInputSchema) },
      responses: { 200: json(TemplateSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").templateId as string;
      const b = c.req.valid("json");
      await o.handle.write(async (tx) => {
        if (mustPropose(o.actor))
          await proposeTemplateTx(tx, o.id, o.actor, {
            action: "update",
            templateId: id,
            input: toInput(b),
            rationale: b.rationale ?? null,
          });
        else await updateTemplateTx(tx, o.id, o.actor, id, toInput(b));
      });
      return c.json(await view(o, id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/recurring-templates/{templateId}",
      tags: TAGS,
      summary: "Delete a recurring template",
      description: "The template is archived: it stops running, and its run history and document links stay.",
      security: bearerSecurity,
      request: { params: TemplateParams },
      responses: { 200: json(TemplateSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      assertCanChangeDirectly(o.actor, "Deleting a template");
      const id = c.req.valid("param").templateId as string;
      await o.handle.write((tx) => archiveTemplateTx(tx, o.id, o.actor, id));
      return c.json(await view(o, id), 200);
    },
  );

  for (const action of ["pause", "resume"] as const)
    r.openapi(
      createRoute({
        method: "post",
        path: `/orgs/{orgId}/recurring-templates/{templateId}/${action}`,
        tags: TAGS,
        summary: action === "pause" ? "Pause a recurring template" : "Resume a paused recurring template",
        description:
          action === "pause"
            ? "Nothing is created while paused."
            : "Runs continue from today on; dates that passed while paused are not created.",
        security: bearerSecurity,
        request: { params: TemplateParams, body: jsonBody(RationaleBody) },
        responses: { 200: json(TemplateSchema), ...errorResponses },
      }),
      async (c) => {
        const o = requireWriter(c);
        const id = c.req.valid("param").templateId as string;
        const rationale = c.req.valid("json").rationale ?? null;
        await o.handle.write(async (tx) => {
          if (mustPropose(o.actor))
            await proposeTemplateTx(tx, o.id, o.actor, { action, templateId: id, rationale });
          else if (action === "pause") await pauseTemplateTx(tx, o.id, o.actor, id);
          else await resumeTemplateTx(tx, o.id, o.actor, id);
        });
        return c.json(await view(o, id), 200);
      },
    );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/recurring-templates/{templateId}/skip",
      tags: TAGS,
      summary: "Skip the next date",
      description:
        "Moves past the next date without creating anything, for example to give up on a failing run.",
      security: bearerSecurity,
      request: { params: TemplateParams },
      responses: { 200: json(TemplateSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      assertCanChangeDirectly(o.actor, "Skipping a date");
      const id = c.req.valid("param").templateId as string;
      await o.handle.write((tx) => skipNextTx(tx, o.id, o.actor, id));
      return c.json(await view(o, id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/recurring-templates/{templateId}/run",
      tags: TAGS,
      summary: "Run a recurring template now",
      description:
        "Without `early`, creates what is due by today (retrying after an error). With `early`, creates the next occurrence now, dated today when it is scheduled later (period text such as {month} still follows the scheduled date). Posting still follows review rules, and auto-send invoices are emailed afterwards.",
      security: bearerSecurity,
      request: { params: TemplateParams, body: jsonBody(z.object({ early: z.boolean().optional() })) },
      responses: {
        200: json(
          z.object({
            template: TemplateSchema,
            created: z.number().int(),
            error: z.string().nullable(),
            emailed: z.number().int(),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      assertCanChangeDirectly(o.actor, "Running a template");
      const id = c.req.valid("param").templateId as string;
      const t = await mustGetTemplate(o.handle.db, id);
      if (t.status !== "active")
        throw conflict(`This template is ${t.status}; only active ones run.`, "invalid_state");
      const asOf = today();
      const r = await runTemplate(o.handle, o.id, id, asOf, { early: c.req.valid("json").early });
      const mail = await drainOutbox(c.get("ctx"), o.handle, o.id, asOf, id);
      return c.json(
        { template: await view(o, id), created: r.created, error: r.error, emailed: mail.sent },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/recurring-templates/{templateId}/occurrences",
      tags: TAGS,
      summary: "Upcoming dates of a recurring template",
      security: bearerSecurity,
      request: {
        params: TemplateParams,
        query: z.object({ count: z.coerce.number().int().min(1).max(100).default(12).optional() }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({ index: z.number().int(), date: z.string() })) })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const t = await mustGetTemplate(c.get("org").handle.db, c.req.valid("param").templateId as string);
      const live = t.status === "active" || t.status === "paused" || t.status === "proposed";
      const data = live ? upcoming(scheduleOf(t), t.nextIndex, c.req.valid("query").count ?? 12) : [];
      return c.json({ data }, 200);
    },
  );

  return r;
}
