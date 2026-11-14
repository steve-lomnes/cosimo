/**
 * Reserves API (#114): money earmarked as a rate of net income per tax year (tax set aside, for
 * example), its true-ups in book mode, and the payments made toward it. Cosimo never computes tax;
 * the rates and due dates are the person's. Configuration applies at once (audited); true-ups and
 * payments from a bank account are entries through the review policy. Everyone in the org reads;
 * writes need Owner or Bookkeeper.
 */
import { MAX_RATE_BP, RESERVE_BASES, RESERVE_MODES, TRUE_UP_SCHEDULES } from "@cosimo/core";
import { createRoute } from "@hono/zod-openapi";
import type { DrawTrueUp } from "../../services/forecast.ts";
import {
  archiveReserveTx,
  createReserveTx,
  deleteReservePaymentTx,
  getReserveConfig,
  listReservePayments,
  listReserves,
  proposeReserveTrueUpTx,
  recordReservePaymentTx,
  reserveView,
  updateReserveTx,
} from "../../services/reserves.ts";
import { unprocessable } from "../errors.ts";
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

const tags = ["Reserves"];

const DueDateSchema = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year_offset: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ description: "0: inside the tax year; 1: the year after (a January installment)" }),
  })
  .openapi("ReserveDueDate");

const PartSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    rate_bp: z.number().int().openapi({ description: "Basis points of the base: 2500 is 25%" }),
    due_dates: z.array(DueDateSchema),
    liability_account_id: z.string().nullable(),
    position: z.number().int(),
  })
  .openapi("ReservePart");

const ReserveSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mode: z.enum(RESERVE_MODES),
    base: z.enum(RESERVE_BASES),
    tax_year_start_month: z.number().int(),
    charge_account_id: z.string().nullable().openapi({ description: "Null: the Owner Draw account" }),
    true_up_schedule: z.enum(TRUE_UP_SCHEDULES),
    parts: z.array(PartSchema),
    created_at: z.string(),
    updated_at: z.string(),
    archived_at: z.string().nullable(),
  })
  .openapi("Reserve");

const PartInput = z.object({
  id: Id.nullable().optional().openapi({ description: "An existing part to keep; leave out for a new one" }),
  label: z.string().trim().min(1).max(100),
  rate_bp: z.number().int().min(0).max(MAX_RATE_BP),
  due_dates: z.array(DueDateSchema).min(1).max(24),
  liability_account_id: Id.nullable().optional(),
});
const ReserveFields = {
  name: z.string().trim().min(1).max(200),
  mode: z.enum(RESERVE_MODES).optional(),
  base: z.enum(RESERVE_BASES).optional(),
  tax_year_start_month: z.number().int().min(1).max(12).optional(),
  charge_account_id: Id.nullable().optional(),
  true_up_schedule: z.enum(TRUE_UP_SCHEDULES).optional(),
  parts: z.array(PartInput).min(1).max(20),
};
const ReserveCreate = z.object(ReserveFields).openapi("ReserveInput");
const ReservePatch = z.object(ReserveFields).partial().openapi("ReservePatch", {
  description: "`parts`, when given, is the whole list; parts left out are archived",
});

const NextDue = z.object({ date: z.string(), amount: Cents }).nullable();
const StatusFields = {
  target: Cents,
  paid: Cents,
  remaining: Cents.openapi({ description: "target - paid" }),
  projected_annual: Cents,
  booked: Cents.nullable().openapi({ description: "Book mode: true-ups posted or pending in the tax year" }),
  booked_pending: Cents.nullable(),
  true_up_due: Cents.nullable().openapi({ description: "target - booked" }),
  held: Cents.nullable().openapi({ description: "booked - paid" }),
  liability_balance: Cents.nullable(),
  next_due: NextDue,
};
const ReserveViewSchema = z
  .object({
    reserve: ReserveSchema,
    as_of: z.string(),
    tax_year: z.number().int(),
    tax_year_start: z.string(),
    tax_year_end: z.string(),
    basis: z.enum(["cash", "accrual"]),
    net_income: Cents,
    parts: z.array(
      z.object({ part_id: z.string(), label: z.string(), rate_bp: z.number().int(), ...StatusFields }),
    ),
    totals: z.object(StatusFields),
    true_up_pending: z.boolean(),
  })
  .openapi("ReserveView");

export const ReservePaymentSchema = z
  .object({
    id: z.string(),
    part_id: z.string(),
    reserve_id: z.string(),
    part_label: z.string(),
    tax_year: z.number().int(),
    date: z.string(),
    amount: Cents,
    entry_id: z.string().nullable(),
    entry_status: z.string().nullable(),
    entry_reversed: z.boolean(),
    note: z.string().nullable(),
    created_by_actor: z.string(),
    created_at: z.string(),
    can_delete: z.boolean(),
  })
  .openapi("ReservePayment");

const SubmitSchema = z.object({
  entry: EntrySchema,
  status: z.string(),
  review: z.object({ review_item_id: z.string().nullable(), reason: z.string() }).nullable(),
});

export function trueUpView(t: DrawTrueUp) {
  return {
    reserve_id: t.reserve_id,
    entry_id: t.result?.entry.id ?? null,
    status: t.result?.entry.status ?? null,
    review_item_id: t.result?.reviewItemId ?? null,
    skipped: t.skipped,
  };
}

const IdParams = OrgParams.extend({ id: Id.openapi({ param: { name: "id", in: "path" } }) });

export function reserveRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reserves",
      tags,
      summary: "List reserves",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({ include_archived: z.enum(["true", "false"]).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(ReserveSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json({ data: await listReserves(c.get("org").handle.db, q.include_archived === "true") }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/reserves",
      tags,
      summary: "Create a reserve",
      description:
        "Book mode needs a liability account for each part (its own); the charge account defaults to Owner Draw.",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(ReserveCreate) },
      responses: { 201: json(ReserveSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const v = await o.handle.write((tx) => createReserveTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(v, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reserves/{id}",
      tags,
      summary: "Get a reserve",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(ReserveSchema), ...errorResponses },
    }),
    async (c) => c.json(await getReserveConfig(c.get("org").handle.db, c.req.valid("param").id), 200),
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/reserves/{id}",
      tags,
      summary: "Change a reserve",
      security: bearerSecurity,
      request: { params: IdParams, body: jsonBody(ReservePatch) },
      responses: { 200: json(ReserveSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const v = await o.handle.write((tx) => updateReserveTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(v, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/reserves/{id}",
      tags,
      summary: "Archive a reserve",
      description: "It leaves the forecast; its payments and entries stay.",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(ReserveSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      return c.json(await o.handle.write((tx) => archiveReserveTx(tx, o.id, o.actor, id)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reserves/{id}/view",
      tags,
      summary: "A reserve's target, paid, and remaining for a tax year",
      description:
        "Net income from the tax year's start to `as_of` (default today), on the org's default basis, times each part's rate. Without `tax_year` it is the year `as_of` falls in.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        query: z.object({
          as_of: IsoDate.optional(),
          tax_year: z.coerce.number().int().min(1900).max(9999).optional(),
        }),
      },
      responses: { 200: json(ReserveViewSchema), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(await reserveView(c.get("org").handle.db, c.req.valid("param").id, q), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/reserves/{id}/true-up",
      tags,
      summary: "Propose a true-up (book mode)",
      description:
        "One entry, dated `as_of` (default today), with a pair of lines per part whose booked amount differs from its target: debit the charge account, credit the part's liability account (the other way when the target fell). 409 `true_up_pending` while one is waiting in review.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(
          z.object({
            as_of: IsoDate.optional(),
            rationale: z.string().max(2000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(SubmitSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const res = await o.handle.write((tx) =>
        proposeReserveTrueUpTx(tx, o.id, o.actor, id, c.req.valid("json")),
      );
      return c.json(submitView(res), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reserves/{id}/payments",
      tags,
      summary: "List a reserve's payments",
      security: bearerSecurity,
      request: {
        params: IdParams,
        query: z.object({ tax_year: z.coerce.number().int().min(1900).max(9999).optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(ReservePaymentSchema) })), ...errorResponses },
    }),
    async (c) => {
      const { tax_year } = c.req.valid("query");
      return c.json(
        { data: await listReservePayments(c.get("org").handle.db, c.req.valid("param").id, tax_year) },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/reserves/{id}/payments",
      tags,
      summary: "Record a payment toward a reserve part",
      description:
        "`tax_year` is the year the payment is for (a January payment can be for the year before). Without `from_bank_account_id` (paid personally) it is only the record, applied at once. With one, it also submits an entry through the review policy: debit the part's liability account (book mode) or the charge account (track mode), credit the bank account. Rejecting that entry removes the payment.",
      security: bearerSecurity,
      request: {
        params: IdParams,
        body: jsonBody(
          z.object({
            part_id: Id,
            tax_year: z.number().int().min(1900).max(9999),
            date: IsoDate,
            amount: Cents.refine((n) => n > 0, "Must be positive"),
            note: z.string().max(500).nullable().optional(),
            from_bank_account_id: Id.nullable().optional(),
            rationale: z.string().max(2000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
          }),
        ),
      },
      responses: {
        201: json(z.object({ payment: ReservePaymentSchema, entry: SubmitSchema.nullable() }), "Created"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const out = await o.handle.write(async (tx) => {
        const cfg = await getReserveConfig(tx, id);
        if (!cfg.parts.some((p) => p.id === b.part_id))
          throw unprocessable("That part isn't in this reserve.", "invalid_part");
        return recordReservePaymentTx(tx, o.id, o.actor, b);
      });
      return c.json({ payment: out.payment, entry: out.result ? submitView(out.result) : null }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/reserve-payments/{id}",
      tags,
      summary: "Delete a reserve payment",
      description:
        "Only a payment with no entry, or whose entry was rejected or reversed. A posted entry is in the books: reverse it first.",
      security: bearerSecurity,
      request: { params: IdParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { id } = c.req.valid("param");
      await o.handle.write((tx) => deleteReservePaymentTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
