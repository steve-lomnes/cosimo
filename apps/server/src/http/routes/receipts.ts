/**
 * Receipt inbox API (#89): capture a receipt when paying, match it to the card charge when the bank
 * feed brings it, or book it on its own. Receipts aren't ledger records, so changes apply at once
 * (audited); categorizing the matched transaction goes through review as usual.
 */
import { createRoute } from "@hono/zod-openapi";
import { storeBlob } from "../../services/attachments.ts";
import { normalizeUpload } from "../../services/images.ts";
import {
  bookReceiptTx,
  createReceiptTx,
  dismissReceiptTx,
  listReceipts,
  matchReceiptTx,
  mustGetReceipt,
  RECEIPT_STATUSES,
  type ReceiptInput,
  receiptCandidates,
  receiptView,
  restoreReceiptTx,
  setReceiptFileTx,
  unmatchReceiptTx,
  updateReceiptTx,
} from "../../services/receipts.ts";
import type { BlobStore } from "../../services/storage.ts";
import { badRequest } from "../errors.ts";
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
import { EntrySchema, submitView } from "./ledger.ts";

const Status = z.enum(RECEIPT_STATUSES);
const NonNegCents = Cents.refine((n) => n >= 0, "Must be zero or more");

const TxnSummarySchema = z
  .object({
    id: z.string(),
    bank_account_id: z.string(),
    date: z.string(),
    amount: Cents,
    description: z.string(),
    payee: z.string().nullable(),
    status: z.enum(["new", "categorized", "matched", "excluded"]),
    entry_id: z.string().nullable(),
  })
  .openapi("ReceiptTransaction");

export const ReceiptSchema = z
  .object({
    id: z.string(),
    status: Status,
    merchant: z.string().nullable(),
    receipt_date: z.string(),
    receipt_time: z.string().nullable(),
    amount: Cents.nullable().openapi({ description: "What the card is charged, tip included" }),
    pre_tip_amount: Cents.nullable(),
    tax_amount: Cents.nullable(),
    tip_amount: Cents.nullable(),
    bank_account_id: z.string().nullable().openapi({ description: "Paid with" }),
    account_id: z.string().nullable(),
    contact_id: z.string().nullable(),
    memo: z.string().nullable(),
    business_purpose: z.string().nullable(),
    attendees: z.string().nullable(),
    location: z.string().nullable(),
    extraction_source: z.enum(["manual", "assistant"]),
    attachment: z
      .object({
        id: z.string(),
        filename: z.string(),
        mime_type: z.string(),
        size_bytes: z.number().int(),
        download_url: z.string(),
      })
      .nullable(),
    matched_bank_txn_id: z.string().nullable(),
    match_method: z.enum(["auto", "manual", "confirmed"]).nullable(),
    matched_at: z.string().nullable(),
    suggested_bank_txn_id: z.string().nullable(),
    transaction: TxnSummarySchema.nullable().openapi({
      description: "The matched transaction, else the suggested one",
    }),
    rejected_txn_ids: z.array(z.string()),
    booked_target_type: z.enum(["bill", "journal_entry"]).nullable(),
    booked_target_id: z.string().nullable(),
    dismissed_reason: z.string().nullable(),
    stale: z.boolean().openapi({ description: "In the inbox for more than 30 days" }),
    created_by_actor: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Receipt");

const ReceiptFields = z.object({
  merchant: z.string().max(200).nullable().optional(),
  receipt_date: IsoDate.nullable().optional().openapi({ description: "Defaults to today" }),
  receipt_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Expected HH:MM")
    .nullable()
    .optional(),
  amount: Cents.refine((n) => n > 0, "Must be positive")
    .nullable()
    .optional()
    .openapi({ description: "What the card is charged, tip included" }),
  pre_tip_amount: NonNegCents.nullable().optional(),
  tax_amount: NonNegCents.nullable().optional(),
  tip_amount: NonNegCents.nullable().optional(),
  bank_account_id: Id.nullable().optional(),
  account_id: Id.nullable().optional(),
  contact_id: Id.nullable().optional(),
  memo: z.string().max(1000).nullable().optional(),
  business_purpose: z.string().max(1000).nullable().optional(),
  attendees: z.string().max(1000).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
});

/** The same fields as multipart form strings (empty means null), with the file. */
const ReceiptForm = z.object({
  file: z.any().optional().openapi({ type: "string", format: "binary" }),
  ...Object.fromEntries(Object.keys(ReceiptFields.shape).map((k) => [k, z.string().optional()])),
});

const NUMERIC = new Set(["amount", "pre_tip_amount", "tax_amount", "tip_amount"]);

/** Turn multipart form fields into receipt input, validated like the JSON body. */
function formInput(body: Record<string, unknown>): ReceiptInput {
  const raw: Record<string, unknown> = {};
  for (const k of Object.keys(ReceiptFields.shape)) {
    const v = body[k];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) raw[k] = null;
    else if (NUMERIC.has(k)) raw[k] = /^-?\d+$/.test(s) ? Number(s) : s;
    else raw[k] = s;
  }
  const parsed = ReceiptFields.safeParse(raw);
  if (!parsed.success)
    throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), {
      issues: parsed.error.issues,
    });
  return parsed.data;
}

const ReceiptParams = OrgParams.extend({
  receiptId: Id.openapi({ param: { name: "receiptId", in: "path" } }),
});

const CandidateSchema = z
  .object({
    transaction: TxnSummarySchema,
    fit: z.enum(["exact", "tip"]),
    merchant_match: z.boolean(),
    days_apart: z.number().int(),
    rejected: z.boolean().openapi({ description: "Marked as not this receipt before" }),
    suggested: z.boolean(),
  })
  .openapi("ReceiptCandidate");

/** Store an uploaded file (HEIC converted to JPEG) before the write transaction. */
async function uploaded(store: BlobStore, orgId: string, file: File) {
  return storeBlob(
    store,
    orgId,
    await normalizeUpload({
      filename: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }),
  );
}

export function receiptRoutes() {
  const r = newRouter();
  const tags = ["Receipts"];

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/receipts",
      tags,
      summary: "List receipts, newest first",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          status: z
            .string()
            .optional()
            .openapi({ description: "Comma-separated: inbox, matched, booked, dismissed" }),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(ReceiptSchema), next_cursor: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const q = c.req.valid("query");
      const status = q.status
        ?.split(",")
        .map((s) => s.trim())
        .filter((s): s is (typeof RECEIPT_STATUSES)[number] =>
          (RECEIPT_STATUSES as readonly string[]).includes(s),
        );
      return c.json(await listReceipts(o.handle.db, o.id, { status, limit: q.limit, cursor: q.cursor }), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts",
      tags,
      summary: "Capture a receipt (photo, details, or both)",
      description:
        "JSON with the receipt's fields, or multipart/form-data with an optional `file` (max 20 MB; a HEIC photo is converted to JPEG) and the same fields as strings. A file or an amount is required. The receipt is matched to its bank transaction now if that is already here, else when the feed brings it.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: {
          content: {
            "application/json": { schema: ReceiptFields },
            "multipart/form-data": { schema: ReceiptForm },
          },
          required: true,
        },
      },
      responses: { 201: json(ReceiptSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const multipart = (c.req.header("content-type") ?? "").startsWith("multipart/form-data");
      let input: ReceiptInput;
      let blob: Awaited<ReturnType<typeof uploaded>> | null = null;
      if (multipart) {
        const body = await c.req.parseBody();
        input = formInput(body);
        if (body.file instanceof File && body.file.size > 0)
          blob = await uploaded(c.get("ctx").services.storage as BlobStore, o.id, body.file);
      } else {
        input = c.req.valid("json") as ReceiptInput;
      }
      const row = await o.handle.write((tx) => createReceiptTx(tx, o.id, o.actor, input, blob));
      return c.json(await receiptView(o.handle.db, o.id, row), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/receipts/{receiptId}",
      tags,
      summary: "Get a receipt",
      security: bearerSecurity,
      request: { params: ReceiptParams },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const row = await mustGetReceipt(o.handle.db, c.req.valid("param").receiptId);
      return c.json(await receiptView(o.handle.db, o.id, row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/receipts/{receiptId}",
      tags,
      summary: "Edit a receipt's details",
      description:
        "Changing the amount, pre-tip amount, date, merchant, or bank account of a receipt in the inbox matches it again.",
      security: bearerSecurity,
      request: { params: ReceiptParams, body: jsonBody(ReceiptFields) },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const row = await o.handle.write((tx) => updateReceiptTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(await receiptView(o.handle.db, o.id, row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/receipts/{receiptId}/file",
      tags,
      summary: "Attach or replace the receipt's photo or PDF",
      description:
        "multipart/form-data with `file` (max 20 MB; a HEIC photo is converted to JPEG). Every link the old file had moves to the new one.",
      security: bearerSecurity,
      request: {
        params: ReceiptParams,
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({ file: z.any().openapi({ type: "string", format: "binary" }) }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      await mustGetReceipt(o.handle.db, id);
      const body = await c.req.parseBody();
      if (!(body.file instanceof File)) throw badRequest("Attach a file in the `file` field.");
      const blob = await uploaded(c.get("ctx").services.storage as BlobStore, o.id, body.file);
      const row = await o.handle.write((tx) => setReceiptFileTx(tx, o.id, o.actor, id, blob));
      return c.json(await receiptView(o.handle.db, o.id, row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/receipts/{receiptId}/candidates",
      tags,
      summary: "Bank transactions that could be this receipt, best first",
      description:
        "Posted outflows from a day before the receipt's date to a week after, for the amount charged, or for the pre-tip amount plus up to 35% when the merchant matches. Transactions marked as not this receipt are included and flagged.",
      security: bearerSecurity,
      request: { params: ReceiptParams },
      responses: { 200: json(z.object({ data: z.array(CandidateSchema) })), ...errorResponses },
    }),
    async (c) =>
      c.json({ data: await receiptCandidates(c.get("org").handle.db, c.req.valid("param").receiptId) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts/{receiptId}/match",
      tags,
      summary: "Match a receipt to a bank transaction",
      description:
        "Links the receipt's file to the transaction (and its entry, if it has one). Picking the suggested transaction confirms the suggestion.",
      security: bearerSecurity,
      request: { params: ReceiptParams, body: jsonBody(z.object({ bank_transaction_id: Id })) },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const txnId = c.req.valid("json").bank_transaction_id;
      const row = await o.handle.write((tx) => matchReceiptTx(tx, o.id, o.actor, id, txnId));
      return c.json(await receiptView(o.handle.db, o.id, row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts/{receiptId}/unmatch",
      tags,
      summary: "Not this receipt: undo a match or turn down a suggestion",
      description:
        "The transaction is remembered as not this receipt and isn't matched or suggested again. The receipt goes back to the inbox.",
      security: bearerSecurity,
      request: { params: ReceiptParams },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const row = await o.handle.write((tx) => unmatchReceiptTx(tx, o.id, o.actor, id));
      return c.json(await receiptView(o.handle.db, o.id, row!), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts/{receiptId}/dismiss",
      tags,
      summary: "Dismiss a receipt from the inbox (for example a personal purchase)",
      security: bearerSecurity,
      request: {
        params: ReceiptParams,
        body: jsonBody(z.object({ reason: z.string().max(500).nullable().optional() })),
      },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const reason = c.req.valid("json").reason ?? null;
      const row = await o.handle.write((tx) => dismissReceiptTx(tx, o.id, o.actor, id, reason));
      return c.json(await receiptView(o.handle.db, o.id, row), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts/{receiptId}/restore",
      tags,
      summary: "Bring a dismissed receipt back to the inbox",
      security: bearerSecurity,
      request: { params: ReceiptParams },
      responses: { 200: json(ReceiptSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const row = await o.handle.write((tx) => restoreReceiptTx(tx, o.id, o.actor, id));
      return c.json(await receiptView(o.handle.db, o.id, row!), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/receipts/{receiptId}/book",
      tags,
      summary: "Book a receipt with no bank transaction, as a draft bill or an entry",
      description:
        "`as: bill` creates a draft bill (vendor from `vendor_id`, else the receipt's contact) with one line on the receipt's account, to finalize on the bill page. `as: entry` debits the receipt's account and credits `credit_account_id` (for example owner's equity for a personal card), through the review policy. Both need the receipt's amount and account.",
      security: bearerSecurity,
      request: {
        params: ReceiptParams,
        body: jsonBody(
          z.discriminatedUnion("as", [
            z.object({ as: z.literal("bill"), vendor_id: Id.nullable().optional() }),
            z.object({
              as: z.literal("entry"),
              credit_account_id: Id,
              rationale: z.string().max(2000).nullable().optional(),
              lock_override_note: z.string().max(1000).nullable().optional(),
            }),
          ]),
        ),
      },
      responses: {
        200: json(
          z.object({
            receipt: ReceiptSchema,
            target: z.object({ type: z.enum(["bill", "journal_entry"]), id: z.string() }),
            entry: EntrySchema.nullable(),
            status: z.string().nullable(),
            review: z.object({ review_item_id: z.string().nullable(), reason: z.string() }).nullable(),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").receiptId;
      const out = await o.handle.write((tx) => bookReceiptTx(tx, o.id, o.actor, id, c.req.valid("json")));
      const v = out.result ? submitView(out.result) : null;
      return c.json(
        {
          receipt: await receiptView(o.handle.db, o.id, out.receipt),
          target: out.target,
          entry: v?.entry ?? null,
          status: v?.status ?? null,
          review: v?.review ?? null,
        },
        200,
      );
    },
  );

  return r;
}
