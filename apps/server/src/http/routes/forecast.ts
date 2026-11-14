/**
 * Cash forecast API (#113): the forecast itself, scenarios, planned items, overrides, links to what
 * actually happened, saved windows, and owner-draw proposals. Scenarios and planned items aren't
 * ledger records, so changes apply at once (audited); an owner draw goes through the review policy.
 * Everyone in the org reads; writes need Owner or Bookkeeper, and an assistant's token may write
 * only to scenarios its own connection created.
 */
import { DEFAULT_ASSUMPTIONS, FIRMNESS, FORECAST_BUCKETS, MAX_FORECAST_PERIODS } from "@cosimo/core";
import { createRoute } from "@hono/zod-openapi";
import {
  archiveItemTx,
  archiveScenarioTx,
  confirmItemTx,
  createItemTx,
  createLinkTx,
  createScenarioTx,
  createWindowTx,
  deleteLinkTx,
  deleteOverrideTx,
  deleteWindowTx,
  duplicateScenarioTx,
  forecast,
  itemView,
  LINK_TARGETS,
  linkView,
  listItems,
  listOverrides,
  listScenarios,
  listWindows,
  mustGetScenario,
  OVERRIDE_TARGETS,
  overrideView,
  promoteScenarioTx,
  proposeOwnerDrawTx,
  scenarioView,
  setOverrideTx,
  updateItemTx,
  updateScenarioTx,
  windowView,
} from "../../services/forecast.ts";
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
  OkSchema,
  OrgParams,
  z,
} from "../openapi.ts";
import { EntrySchema, submitView } from "./ledger.ts";
import { ReservePaymentSchema, trueUpView } from "./reserves.ts";

const tags = ["Forecast"];

const Bucket = z.enum(FORECAST_BUCKETS);
const Periods = z.number().int().min(1).max(MAX_FORECAST_PERIODS);

const AssumptionsSchema = z
  .object({
    collection_lag_days: z.number().int(),
    late_share_pct: z.number().int(),
    late_days: z.number().int(),
    min_cash_buffer: Cents,
  })
  .openapi("ForecastAssumptions", {
    description: `Defaults: ${JSON.stringify(DEFAULT_ASSUMPTIONS)}`,
  });
const AssumptionsPatch = z
  .object({
    collection_lag_days: z.number().int().min(0).max(365).nullable().optional(),
    late_share_pct: z.number().int().min(0).max(100).nullable().optional(),
    late_days: z.number().int().min(0).max(365).nullable().optional(),
    min_cash_buffer: Cents.nullable().optional(),
  })
  .openapi("ForecastAssumptionsPatch", {
    description: "A value of null clears it (a scenario then uses the baseline's).",
  });

const ScenarioSchema = z
  .object({
    id: z.string().openapi({ description: "`baseline` until the first write creates the baseline" }),
    name: z.string(),
    is_baseline: z.boolean(),
    description: z.string().nullable(),
    assumptions: AssumptionsSchema.partial().openapi({ description: "Only the values this scenario sets" }),
    exists: z.boolean(),
    created_by_actor: z.string(),
    created_by_client: z.string().nullable(),
    archived_at: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .openapi("ForecastScenario");

const ItemSchema = z
  .object({
    id: z.string(),
    scenario_id: z.string(),
    kind: z.enum(["planned", "draw"]),
    name: z.string(),
    direction: z.enum(["in", "out"]),
    amount: Cents,
    unit: z.enum(["day", "week", "month", "year"]).nullable(),
    interval: z.number().int(),
    anchor_day: z.number().int().nullable(),
    start_date: z.string(),
    end_date: z.string().nullable(),
    max_occurrences: z.number().int().nullable(),
    schedule_text: z.string(),
    next_date: z.string().nullable(),
    account_id: z.string().nullable(),
    contact_id: z.string().nullable(),
    bank_account_id: z.string().nullable(),
    notes: z.string().nullable(),
    source: z.enum(["person", "assistant"]),
    created_by_actor: z.string(),
    last_confirmed_at: z.string().nullable(),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PlannedItem");

const ItemFields = {
  kind: z.enum(["planned", "draw"]).optional(),
  name: z.string().trim().min(1).max(200),
  direction: z.enum(["in", "out"]),
  amount: Cents.refine((n) => n > 0, "Must be positive"),
  unit: z
    .enum(["day", "week", "month", "year"])
    .nullable()
    .optional()
    .openapi({ description: "Null or left out for a one-off on start_date" }),
  interval: z.number().int().min(1).max(1000).optional(),
  anchor_day: z.number().int().min(-1).max(31).nullable().optional(),
  start_date: IsoDate.openapi({ description: "The date of a one-off, or the first slot of a schedule" }),
  end_date: IsoDate.nullable().optional(),
  max_occurrences: z.number().int().min(1).max(10_000).nullable().optional(),
  account_id: Id.nullable().optional(),
  contact_id: Id.nullable().optional(),
  bank_account_id: Id.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
};
const ItemCreate = z
  .object({ scenario_id: Id.nullable().optional(), ...ItemFields })
  .openapi("PlannedItemInput");
const ItemPatch = z.object(ItemFields).partial().openapi("PlannedItemPatch");

const OverrideSchema = z
  .object({
    id: z.string(),
    scenario_id: z.string(),
    target_type: z.enum(OVERRIDE_TARGETS),
    target_id: z.string(),
    target_date: z.string().nullable(),
    action: z.enum(["exclude", "shift"]),
    shift_days: z.number().int().nullable(),
    created_by_actor: z.string(),
    created_at: z.string(),
  })
  .openapi("ForecastOverride");

const LinkSchema = z
  .object({
    id: z.string(),
    item_id: z.string(),
    occurrence_date: z.string(),
    status: z.enum(["linked", "rejected", "skipped"]),
    target_type: z.enum(LINK_TARGETS).nullable(),
    target_id: z.string().nullable(),
    created_by_actor: z.string(),
    created_at: z.string(),
  })
  .openapi("ForecastLink");

const WindowSchema = z
  .object({ id: z.string(), name: z.string(), bucket: Bucket, periods: Periods, created_at: z.string() })
  .openapi("ForecastWindow");

const FlowSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    amount: Cents.openapi({ description: "Signed: positive is money in" }),
    source: z.enum(["invoice", "bill", "recurring", "pending", "planned", "draw", "reserve"]),
    ref: z
      .string()
      .nullable()
      .openapi({ description: "The invoice, bill, template, entry, or planned item" }),
    label: z.string(),
    firmness: z.enum(FIRMNESS),
    target: z
      .object({ type: z.string(), id: z.string(), date: z.string().optional() })
      .optional()
      .openapi({ description: "What an override of this flow names" }),
    last_confirmed_at: z.string().nullable().optional(),
    days_overdue: z.number().int().nullable().optional(),
    tax_year: z
      .number()
      .int()
      .optional()
      .openapi({ description: "Reserve installments: the tax year it belongs to" }),
  })
  .openapi("ForecastFlow");

const AttentionSchema = z
  .object({
    kind: z.enum([
      "planned_past_due",
      "planned_unconfirmed",
      "invoice_overdue",
      "bank_feed_stale",
      "card_balance",
      "suggested_match",
      "template_overlap",
    ]),
    message: z.string(),
    ref: z.string().nullable(),
    item_id: z.string().optional(),
    occurrence_date: z.string().optional(),
    target_type: z.enum(LINK_TARGETS).optional(),
    target_id: z.string().optional(),
  })
  .openapi("ForecastAttention");

const SuggestionSchema = z
  .object({
    item_id: z.string(),
    item_name: z.string(),
    occurrence_date: z.string(),
    amount: Cents,
    target_type: z.enum(LINK_TARGETS),
    target_id: z.string(),
    target_label: z.string(),
    target_date: z.string(),
    target_amount: Cents,
  })
  .openapi("ForecastSuggestion");

const WindowInfo = z.object({
  key: z.string().openapi({ description: "w13, m12, a saved window's id, or custom" }),
  name: z.string(),
  bucket: Bucket,
  periods: Periods,
  start: z.string(),
  end: z.string(),
});

const CapacitySchema = z.object({
  amount: Cents.openapi({
    description: "max(0, low point balance - cash buffer - reserves not in the window)",
  }),
  breakdown: z.object({
    low_point: Cents,
    buffer: Cents,
    reserves_not_in_window: Cents.openapi({
      description:
        "What reserves owe now (target less paid, per part) that no reserve outflow in the window pays",
    }),
  }),
  binding: z
    .array(FlowSchema)
    .openapi({ description: "The largest outflows dated on or before the low point" }),
});
const LowPointSchema = z.object({ balance: Cents, date: z.string() });

const ForecastSchema = z
  .object({
    as_of: z.string(),
    currency: z.string(),
    scenario: z.object({ id: z.string(), name: z.string(), is_baseline: z.boolean() }),
    window: WindowInfo,
    start: z.string(),
    end: z.string(),
    opening_cash: Cents,
    assumptions: AssumptionsSchema,
    buckets: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        inflow: Cents,
        outflow: Cents.openapi({ description: "Money out, as a positive amount" }),
        net: Cents,
        ending: Cents,
        flows: z.array(FlowSchema),
      }),
    ),
    low_point: LowPointSchema,
    draw_capacity: CapacitySchema,
    drivers: z.array(FlowSchema),
    attention: z.array(AttentionSchema),
    suggestions: z.array(SuggestionSchema),
  })
  .openapi("CashForecast");

const SnapshotSchema = z
  .object({
    computed_at: z.string(),
    scenario: z.object({ id: z.string(), name: z.string(), is_baseline: z.boolean() }),
    window: WindowInfo,
    opening_cash: Cents,
    low_point: LowPointSchema,
    draw_capacity: CapacitySchema,
    assumptions: AssumptionsSchema,
    drivers: z.array(FlowSchema),
    attention_count: z.number().int(),
    exceeds_capacity: z.boolean(),
  })
  .openapi("ForecastSnapshot");

const IdParams = OrgParams.extend({ id: Id.openapi({ param: { name: "id", in: "path" } }) });

export function forecastRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/forecast",
      tags,
      summary: "Cash forecast",
      description:
        "Opening cash, buckets of expected inflows and outflows from today, the low point, how much can be drawn (`draw_capacity`), the largest drivers, and what needs attention. `window` is `w13` (default), `m12`, or a saved window's id; or give `bucket` and `periods` for a custom window. Without `scenario_id` it is the baseline.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          scenario_id: Id.optional(),
          window: z.string().optional(),
          bucket: Bucket.optional(),
          periods: z.coerce.number().int().min(1).max(MAX_FORECAST_PERIODS).optional(),
        }),
      },
      responses: { 200: json(ForecastSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      return c.json(await forecast(o.handle.db, c.req.valid("query")), 200);
    },
  );

  // ------------------------------------------------------------------ scenarios

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/forecast/scenarios",
      tags,
      summary: "List forecast scenarios, the baseline first",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({ include_archived: z.enum(["true", "false"]).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(ScenarioSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      return c.json(
        { data: await listScenarios(o.handle.db, c.req.valid("query").include_archived === "true") },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/scenarios",
      tags,
      summary: "Create a scenario",
      description: "A scenario holds only its changes on top of the baseline. The creating client owns it.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            name: z.string().trim().min(1).max(200),
            description: z.string().max(2000).nullable().optional(),
            assumptions: AssumptionsPatch.optional(),
          }),
        ),
      },
      responses: { 201: json(ScenarioSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const row = await o.handle.write((tx) => createScenarioTx(tx, o.id, o.actor, b));
      return c.json(scenarioView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/forecast/scenarios/{id}",
      tags,
      summary: "Rename a scenario or change its assumptions",
      description: "`baseline` names the baseline, whose assumptions people can change.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(
          z.object({
            name: z.string().trim().min(1).max(200).optional(),
            description: z.string().max(2000).nullable().optional(),
            assumptions: AssumptionsPatch.optional(),
          }),
        ),
      },
      responses: { 200: json(ScenarioSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const row = await o.handle.write((tx) => updateScenarioTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(scenarioView(row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/forecast/scenarios/{id}",
      tags,
      summary: "Archive a scenario",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(ScenarioSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      await o.handle.write((tx) => archiveScenarioTx(tx, o.id, o.actor, id));
      return c.json(scenarioView(await mustGetScenario(o.handle.db, id)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/scenarios/{id}/duplicate",
      tags,
      summary: "Copy a scenario's items, overrides, and assumptions into a new scenario",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(z.object({ name: z.string().trim().min(1).max(200).optional() })),
      },
      responses: { 201: json(ScenarioSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const row = await o.handle.write((tx) =>
        duplicateScenarioTx(tx, o.id, o.actor, id, c.req.valid("json").name),
      );
      return c.json(scenarioView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/scenarios/{id}/promote",
      tags,
      summary: "Move chosen items, overrides, and assumptions of a scenario into the baseline",
      description:
        "Items and overrides are re-parented, not copied; `assumptions: true` moves the scenario's assumption values. People only: an assistant asks the person to promote its scenario.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(
          z.object({
            item_ids: z.array(Id).optional(),
            override_ids: z.array(Id).optional(),
            assumptions: z.boolean().optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            items: z.number().int(),
            overrides: z.number().int(),
            assumptions: z.array(z.string()),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      return c.json(
        await o.handle.write((tx) => promoteScenarioTx(tx, o.id, o.actor, id, c.req.valid("json"))),
        200,
      );
    },
  );

  // ------------------------------------------------------------------ planned items

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/forecast/items",
      tags,
      summary: "List a scenario's planned items",
      description: "Only the scenario's own items; the baseline's are listed with `scenario_id` left out.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          scenario_id: Id.optional(),
          include_archived: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(ItemSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const q = c.req.valid("query");
      return c.json(
        { data: await listItems(o.handle.db, q.scenario_id, q.include_archived === "true") },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/items",
      tags,
      summary: "Add a planned item to a scenario",
      description:
        "A one-off (`unit` null, dated `start_date`) or a schedule. `kind: draw` is a planned owner draw (always out). Without `scenario_id` it goes to the baseline.",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(ItemCreate) },
      responses: { 201: json(ItemSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const row = await o.handle.write((tx) => createItemTx(tx, o.id, o.actor, b));
      return c.json(itemView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/forecast/items/{id}",
      tags,
      summary: "Edit a planned item",
      security: bearerSecurity,
      request: { params: IdParams, body: jsonBody(ItemPatch) },
      responses: { 200: json(ItemSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const row = await o.handle.write((tx) => updateItemTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(itemView(row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/forecast/items/{id}",
      tags,
      summary: "Archive a planned item",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(ItemSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      return c.json(itemView(await o.handle.write((tx) => archiveItemTx(tx, o.id, o.actor, id))), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/items/{id}/confirm",
      tags,
      summary: "Confirm a planned item still holds",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(ItemSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      return c.json(itemView(await o.handle.write((tx) => confirmItemTx(tx, o.id, o.actor, id))), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/items/{id}/links",
      tags,
      summary: "Link, reject, or skip one occurrence of a planned item",
      description:
        "`linked` (with a target) says the occurrence became that invoice, bill, or bank transaction; `skipped` (no target) says it didn't happen; both stop it counting. `rejected` (with a target) only hides that suggestion.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(
          z.object({
            occurrence_date: IsoDate,
            status: z.enum(["linked", "rejected", "skipped"]),
            target_type: z.enum(LINK_TARGETS).nullable().optional(),
            target_id: Id.nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(LinkSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const row = await o.handle.write((tx) => createLinkTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(linkView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/forecast/links/{id}",
      tags,
      summary: "Remove a link",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      await o.handle.write((tx) => deleteLinkTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ overrides

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/forecast/overrides",
      tags,
      summary: "List a scenario's overrides",
      security: bearerSecurity,
      request: { params: OrgParams, query: z.object({ scenario_id: Id.optional() }) },
      responses: { 200: json(z.object({ data: z.array(OverrideSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      return c.json({ data: await listOverrides(o.handle.db, c.req.valid("query").scenario_id) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/overrides",
      tags,
      summary: "Exclude or shift an invoice, bill, recurring template, or planned item in a scenario",
      description:
        "The same target again replaces its earlier override. Without `scenario_id` it goes to the baseline.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            scenario_id: Id.nullable().optional(),
            target_type: z.enum(OVERRIDE_TARGETS),
            target_id: Id,
            target_date: IsoDate.nullable().optional(),
            action: z.enum(["exclude", "shift"]),
            shift_days: z.number().int().min(-366).max(366).nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(OverrideSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const row = await o.handle.write((tx) => setOverrideTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(overrideView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/forecast/overrides/{id}",
      tags,
      summary: "Remove an override",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      await o.handle.write((tx) => deleteOverrideTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ windows

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/forecast/windows",
      tags,
      summary: "List saved custom windows",
      description: "`w13` and `m12` are built in and always available.",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(WindowSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await listWindows(c.get("org").handle.db) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/windows",
      tags,
      summary: "Save a custom window",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({ name: z.string().trim().min(1).max(100), bucket: Bucket, periods: Periods }),
        ),
      },
      responses: { 201: json(WindowSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const row = await o.handle.write((tx) => createWindowTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(windowView(row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/forecast/windows/{id}",
      tags,
      summary: "Delete a saved window",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      await o.handle.write((tx) => deleteWindowTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ owner draws

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/forecast/draws",
      tags,
      summary: "Propose an owner draw",
      description:
        "One entry: debit Owner Draw, credit the bank account's ledger account, through the review policy. The review item carries the forecast as the server computed it. A draw over `draw_capacity` is never refused; `exceeds_capacity` says so. `pay_reserve` makes it a payment toward a reserve part instead (a `reserve_payment` entry). `include_true_ups` also proposes a true-up of every book-mode reserve whose booked amount differs from its target (separate entries, each with the snapshot); one already pending is skipped.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            date: IsoDate,
            amount: Cents.refine((n) => n > 0, "Must be positive"),
            bank_account_id: Id,
            memo: z.string().max(500).nullable().optional(),
            scenario_id: Id.nullable().optional(),
            window: z.string().optional(),
            rationale: z.string().max(2000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
            include_true_ups: z.boolean().optional(),
            pay_reserve: z
              .object({ part_id: Id, tax_year: z.number().int().min(1900).max(9999) })
              .nullable()
              .optional(),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({
            entry: EntrySchema,
            status: z.string(),
            review: z.object({ review_item_id: z.string().nullable(), reason: z.string() }).nullable(),
            forecast_snapshot: SnapshotSchema,
            exceeds_capacity: z.boolean(),
            payment: z.union([ReservePaymentSchema, z.null()]),
            true_ups: z.array(
              z.object({
                reserve_id: z.string(),
                entry_id: z.string().nullable(),
                status: z.string().nullable(),
                review_item_id: z.string().nullable(),
                skipped: z.string().nullable(),
              }),
            ),
          }),
          "Created",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        proposeOwnerDrawTx(tx, o.id, o.actor, { ...b, window: { window: b.window } }),
      );
      return c.json(
        {
          ...submitView(out.result),
          forecast_snapshot: out.forecast_snapshot,
          exceeds_capacity: out.exceeds_capacity,
          payment: out.payment,
          true_ups: out.true_ups.map(trueUpView),
        },
        201,
      );
    },
  );

  return r;
}
