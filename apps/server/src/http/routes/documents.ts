/** Receivables and payables API: contacts, invoices, bills, payments, attachments. */
import { createRoute } from "@hono/zod-openapi";
import {
  ATTACHMENT_TARGETS,
  attachmentView,
  dispositionFor,
  linkAttachmentTx,
  listAttachments,
  mustGetAttachment,
  recordAttachmentTx,
  storeBlob,
  unlinkAttachmentTx,
} from "../../services/attachments.ts";
import {
  contactView,
  createContactTx,
  listContacts,
  mustGetContact,
  updateContactTx,
} from "../../services/contacts.ts";
import {
  applyPaymentTx,
  type BillView,
  billView,
  createBillTx,
  createInvoiceTx,
  deleteBillDraftTx,
  deleteInvoiceDraftTx,
  finalizeBillTx,
  finalizeInvoiceTx,
  type InvoiceView,
  invoiceView,
  listBills,
  listInvoices,
  listPayments,
  markInvoiceSentTx,
  mustGetBill,
  mustGetInvoice,
  mustGetPayment,
  openDocuments,
  payFromBankTxnTx,
  paymentView,
  recordPaymentTx,
  unapplyPaymentTx,
  updateBillTx,
  updateInvoiceTx,
  voidBillTx,
  voidInvoiceTx,
  voidPaymentTx,
} from "../../services/documents.ts";
import { emailInvoice, invoicePdf } from "../../services/invoice-delivery.ts";
import { payLinker, storePayTokenHashesTx } from "../../services/online-payments.ts";
import type { BlobStore } from "../../services/storage.ts";
import { badRequest, notFound } from "../errors.ts";
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
import { EntrySchema } from "./ledger.ts";

const Address = z.record(z.string(), z.string().max(200)).nullable().optional();

const ContactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["customer", "vendor", "both"]),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.record(z.string(), z.string()).nullable(),
    tax_id_last4: z.string().nullable(),
    is_1099_vendor: z.boolean(),
    default_account_id: z.string().nullable(),
    default_terms: z.string().nullable(),
    notes: z.string().nullable(),
    created_at: z.string(),
    archived_at: z.string().nullable(),
  })
  .openapi("Contact");
const ContactInput = z.object({
  kind: z.enum(["customer", "vendor", "both"]),
  name: z.string().trim().min(1).max(200),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: Address,
  tax_id_last4: z.string().max(4).nullable().optional(),
  is_1099_vendor: z.boolean().optional(),
  default_account_id: Id.nullable().optional(),
  default_terms: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const DocLine = z.object({
  description: z.string().max(1000),
  quantity_milli: z
    .number()
    .int()
    .min(1)
    .max(1_000_000_000)
    .optional()
    .openapi({ description: "Quantity × 1000 (1 = 1000); must be positive" }),
  unit_price: Cents.optional(),
  amount: Cents.optional().openapi({ description: "Bills: the line amount" }),
  account_id: Id,
});

export const InvoiceSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    customer_id: z.string(),
    customer_name: z.string(),
    customer_email: z.string().nullable(),
    issue_date: z.string(),
    due_date: z.string(),
    status: z.enum(["draft", "sent", "partial", "paid", "void"]),
    entry_status: z.string().nullable(),
    currency: z.string(),
    subtotal: Cents,
    total: Cents,
    amount_paid: Cents,
    balance_due: Cents,
    overdue: z.boolean(),
    memo: z.string().nullable(),
    terms: z.string().nullable(),
    entry_id: z.string().nullable(),
    recurring_id: z.string().nullable(),
    created_by_actor: z.string(),
    created_at: z.string(),
    sent_at: z.string().nullable(),
    last_reminder_at: z.string().nullable(),
    voided_at: z.string().nullable(),
    online_payment_enabled: z.boolean().describe("Whether the invoice offers the online pay link."),
    pay_url: z
      .string()
      .nullable()
      .describe(
        "The customer's pay link (online payments through the org's Stripe account); null when there is none, including while the balance due is under Stripe's $0.50 minimum.",
      ),
    online_pay_status: z
      .enum(["processing"])
      .nullable()
      .describe("`processing` while a bank payment is on its way; null otherwise."),
    pay_link_opened_at: z.string().nullable().describe("When the customer first opened the pay link."),
    pay_error: z
      .string()
      .nullable()
      .describe(
        "Why the pay link last failed to open checkout (Stripe's reason), or a method Stripe rejected; null once it works.",
      ),
    pay_error_at: z.string().nullable(),
    manual_pay_url: z.string().nullable().describe("A payment page URL entered by hand (payment link mode)."),
    online_refunded: Cents.describe(
      "Refunded through Stripe, from posted refund entries. The invoice stays paid; the refund reduces revenue.",
    ),
    online_disputed: Cents.describe(
      "Taken back by Stripe for disputes (chargebacks), less funds returned, from posted dispute entries.",
    ),
    refund_pending_review: z
      .boolean()
      .describe("A Stripe refund or dispute entry for this invoice is waiting in the review queue."),
    refund_rejected: z
      .boolean()
      .describe(
        "A Stripe refund or dispute entry was rejected; Cosimo won't propose it again, so book it by hand.",
      ),
    lines: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        quantity_milli: z.number().int(),
        unit_price: Cents,
        amount: Cents,
        account_id: z.string(),
      }),
    ),
  })
  .openapi("Invoice");
const InvoiceInput = z.object({
  customer_id: Id,
  number: z.string().max(40).nullable().optional(),
  issue_date: IsoDate,
  due_date: IsoDate.nullable().optional(),
  terms: z.string().max(100).nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  lines: z.array(DocLine).min(1).max(200),
  online_pay_enabled: z
    .boolean()
    .optional()
    .openapi({ description: "Offer the online pay link. Defaults to the organization's setting." }),
  manual_pay_url: z
    .string()
    .trim()
    .max(500)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Use an http or https URL")
    .nullable()
    .optional()
    .openapi({ description: "Payment link mode: a payment page URL shown on the PDF and email." }),
});

const BillSchema = z
  .object({
    id: z.string(),
    vendor_id: z.string(),
    vendor_name: z.string(),
    bill_number: z.string().nullable(),
    issue_date: z.string(),
    due_date: z.string(),
    status: z.enum(["draft", "open", "partial", "paid", "void"]),
    entry_status: z.string().nullable(),
    currency: z.string(),
    total: Cents,
    amount_paid: Cents,
    balance_due: Cents,
    overdue: z.boolean(),
    memo: z.string().nullable(),
    entry_id: z.string().nullable(),
    recurring_id: z.string().nullable(),
    created_at: z.string(),
    voided_at: z.string().nullable(),
    lines: z.array(
      z.object({ id: z.string(), description: z.string(), amount: Cents, account_id: z.string() }),
    ),
  })
  .openapi("Bill");
const BillInput = z.object({
  vendor_id: Id,
  bill_number: z.string().max(60).nullable().optional(),
  issue_date: IsoDate,
  due_date: IsoDate.nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  lines: z.array(DocLine).min(1).max(200),
  draft: z.boolean().optional(),
  lock_override_note: z.string().max(1000).nullable().optional(),
});

const PaymentSchema = z
  .object({
    id: z.string(),
    direction: z.enum(["received", "sent"]),
    contact_id: z.string(),
    contact_name: z.string(),
    date: z.string(),
    amount: Cents,
    account_id: z.string(),
    method: z.string().nullable(),
    reference: z.string().nullable(),
    memo: z.string().nullable(),
    entry_id: z.string().nullable(),
    entry_status: z.string().nullable(),
    voided_at: z.string().nullable(),
    applied: Cents,
    unapplied: Cents,
    applications: z.array(
      z.object({
        document_type: z.string(),
        document_id: z.string(),
        document_number: z.string(),
        amount: Cents,
        applied_date: z.string().nullable(),
      }),
    ),
    created_at: z.string(),
  })
  .openapi("Payment");
const Application = z.object({ document_id: Id, amount: Cents.refine((n) => n > 0, "Must be positive") });

const AttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    sha256: z.string(),
    uploaded_by: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Attachment");

const SubmitInfo = z.object({
  status: z.string(),
  review: z.object({ review_item_id: z.string().nullable(), reason: z.string() }).nullable(),
});

const P = (name: string) => OrgParams.extend({ [name]: Id.openapi({ param: { name, in: "path" } }) });
const ContactParams = P("contactId");
const InvoiceParams = P("invoiceId");
const BillParams = P("billId");
const PaymentParams = P("paymentId");
const AttachmentParams = P("attachmentId");

function submitInfo(
  r: { entry: { status: string }; reviewItemId: string | null; decision: { reason: string } | null } | null,
) {
  if (!r) return { status: "draft", review: null };
  return {
    status: r.entry.status,
    review: r.reviewItemId ? { review_item_id: r.reviewItemId, reason: r.decision?.reason ?? "" } : null,
  };
}

export function documentRoutes() {
  const r = newRouter();

  // ------------------------------------------------------------------ contacts
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/contacts",
      tags: ["Contacts"],
      summary: "List customers and vendors",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          kind: z.enum(["customer", "vendor"]).optional(),
          q: z.string().max(200).optional(),
          include_archived: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(ContactSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        {
          data: await listContacts(c.get("org").handle.db, {
            kind: q.kind,
            q: q.q,
            includeArchived: q.include_archived === "true",
          }),
        },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/contacts",
      tags: ["Contacts"],
      summary: "Create a contact",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(ContactInput) },
      responses: { 201: json(ContactSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      return c.json(
        contactView(await o.handle.write((tx) => createContactTx(tx, o.id, o.actor, c.req.valid("json")))),
        201,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/contacts/{contactId}",
      tags: ["Contacts"],
      summary: "Get a contact",
      security: bearerSecurity,
      request: { params: ContactParams },
      responses: { 200: json(ContactSchema), ...errorResponses },
    }),
    async (c) =>
      c.json(
        contactView(await mustGetContact(c.get("org").handle.db, c.req.valid("param").contactId as string)),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/contacts/{contactId}",
      tags: ["Contacts"],
      summary: "Update or archive a contact",
      security: bearerSecurity,
      request: {
        params: ContactParams,
        body: jsonBody(ContactInput.partial().extend({ archived: z.boolean().optional() })),
      },
      responses: { 200: json(ContactSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").contactId as string;
      return c.json(
        contactView(
          await o.handle.write((tx) => updateContactTx(tx, o.id, o.actor, id, c.req.valid("json"))),
        ),
        200,
      );
    },
  );

  // ------------------------------------------------------------------ invoices
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/invoices",
      tags: ["Invoices"],
      summary: "List invoices",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          status: z.string().optional(),
          customer_id: Id.optional(),
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          overdue: z.enum(["true", "false"]).optional(),
          open: z.enum(["true", "false"]).optional().openapi({ description: "Only sent or partially paid" }),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(InvoiceSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const o = c.get("org");
      const db = o.handle.db;
      const link = await payLinker(c.get("ctx"), db, o.id);
      const data =
        q.open === "true"
          ? ((await openDocuments(db, "invoice", q.customer_id, link)) as InvoiceView[])
          : await listInvoices(
              db,
              {
                status: q.status?.split(",").filter(Boolean),
                customerId: q.customer_id,
                from: q.from,
                to: q.to,
                overdue: q.overdue === "true",
              },
              link,
            );
      return c.json({ data: data }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices",
      tags: ["Invoices"],
      summary: "Create a draft invoice (numbered from the org's prefix and next number unless given)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(InvoiceInput) },
      responses: { 201: json(InvoiceSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const inv = await o.handle.write((tx) => createInvoiceTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(
        await invoiceView(o.handle.db, inv, await payLinker(c.get("ctx"), o.handle.db, o.id)),
        201,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/invoices/{invoiceId}",
      tags: ["Invoices"],
      summary: "Get an invoice",
      security: bearerSecurity,
      request: { params: InvoiceParams },
      responses: { 200: json(InvoiceSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const db = o.handle.db;
      return c.json(
        await invoiceView(
          db,
          await mustGetInvoice(db, c.req.valid("param").invoiceId as string),
          await payLinker(c.get("ctx"), db, o.id),
        ),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/invoices/{invoiceId}",
      tags: ["Invoices"],
      summary: "Edit a draft invoice",
      security: bearerSecurity,
      request: { params: InvoiceParams, body: jsonBody(InvoiceInput.partial()) },
      responses: { 200: json(InvoiceSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").invoiceId as string;
      const inv = await o.handle.write((tx) => updateInvoiceTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(
        await invoiceView(o.handle.db, inv, await payLinker(c.get("ctx"), o.handle.db, o.id)),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/invoices/{invoiceId}",
      tags: ["Invoices"],
      summary: "Delete a draft invoice",
      security: bearerSecurity,
      request: { params: InvoiceParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").invoiceId as string;
      await o.handle.write((tx) => deleteInvoiceDraftTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices/{invoiceId}/finalize",
      tags: ["Invoices"],
      summary: "Post a draft invoice to the books without emailing it",
      description:
        "Posts accounts receivable against income. Large invoices may wait in the review queue first.",
      security: bearerSecurity,
      request: {
        params: InvoiceParams,
        body: jsonBody(z.object({ lock_override_note: z.string().max(1000).nullable().optional() })),
      },
      responses: { 200: json(z.object({ invoice: InvoiceSchema }).merge(SubmitInfo)), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").invoiceId as string;
      const ctx = c.get("ctx");
      const res = await o.handle.write(async (tx) => {
        const r = await finalizeInvoiceTx(tx, o.id, o.actor, id, {
          lockOverrideNote: c.req.valid("json").lock_override_note,
        });
        await storePayTokenHashesTx(ctx, tx, o.id);
        return r;
      });
      const inv = await invoiceView(
        o.handle.db,
        await mustGetInvoice(o.handle.db, id),
        await payLinker(ctx, o.handle.db, o.id),
      );
      return c.json({ invoice: inv, ...submitInfo(res) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices/{invoiceId}/send",
      tags: ["Invoices"],
      summary: "Email the invoice PDF to the customer (posting it first if it is a draft)",
      description: "Needs SMTP. If the invoice waits in the review queue, it is not emailed until approved.",
      security: bearerSecurity,
      request: {
        params: InvoiceParams,
        body: jsonBody(
          z.object({
            to: z.string().email().nullable().optional(),
            message: z.string().max(5000).nullable().optional(),
          }),
        ),
      },
      responses: {
        200: json(z.object({ invoice: InvoiceSchema, emailed_to: z.string().nullable() }).merge(SubmitInfo)),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const ctx = c.get("ctx");
      const id = c.req.valid("param").invoiceId as string;
      const b = c.req.valid("json");
      let res = null;
      const current = await mustGetInvoice(o.handle.db, id);
      const waiting = (await invoiceView(o.handle.db, current)).entry_status === "pending_review";
      if (current.status === "draft" && !waiting)
        res = await o.handle.write(async (tx) => {
          const r = await finalizeInvoiceTx(tx, o.id, o.actor, id);
          await storePayTokenHashesTx(ctx, tx, o.id);
          return r;
        });
      let to: string | null = null;
      const after = await mustGetInvoice(o.handle.db, id);
      if (after.status !== "draft") {
        to = (await emailInvoice(ctx, o.handle.db, o.id, id, { to: b.to, message: b.message })).to;
        await o.handle.write((tx) => markInvoiceSentTx(tx, o.id, o.actor, id, to));
      }
      const inv = await invoiceView(
        o.handle.db,
        await mustGetInvoice(o.handle.db, id),
        await payLinker(ctx, o.handle.db, o.id),
      );
      return c.json(
        {
          invoice: inv,
          emailed_to: to,
          ...submitInfo(
            res ?? { entry: { status: inv.entry_status ?? "posted" }, reviewItemId: null, decision: null },
          ),
        },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices/{invoiceId}/void",
      tags: ["Invoices"],
      summary: "Void an invoice (reverses its entry; payments must be removed first)",
      security: bearerSecurity,
      request: { params: InvoiceParams, body: jsonBody(z.object({ date: IsoDate.nullable().optional() })) },
      responses: { 200: json(InvoiceSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").invoiceId as string;
      await o.handle.write((tx) => voidInvoiceTx(tx, o.id, o.actor, id, c.req.valid("json").date));
      return c.json(
        await invoiceView(
          o.handle.db,
          await mustGetInvoice(o.handle.db, id),
          await payLinker(c.get("ctx"), o.handle.db, o.id),
        ),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/invoices/{invoiceId}/pdf",
      tags: ["Invoices"],
      summary: "Download the invoice PDF",
      security: bearerSecurity,
      request: { params: InvoiceParams },
      responses: {
        200: {
          content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
          description: "PDF",
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const pdf = await invoicePdf(c.get("ctx"), o.handle.db, o.id, c.req.valid("param").invoiceId as string);
      return c.body(pdf.bytes as unknown as ArrayBuffer, 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.filename}"`,
      });
    },
  );

  // ------------------------------------------------------------------ bills
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bills",
      tags: ["Bills"],
      summary: "List bills",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          status: z.string().optional(),
          vendor_id: Id.optional(),
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          open: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(BillSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const db = c.get("org").handle.db;
      const data =
        q.open === "true"
          ? ((await openDocuments(db, "bill", q.vendor_id)) as BillView[])
          : await listBills(db, {
              status: q.status?.split(",").filter(Boolean),
              vendorId: q.vendor_id,
              from: q.from,
              to: q.to,
            });
      return c.json({ data: data }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bills",
      tags: ["Bills"],
      summary: "Enter a bill (posted unless draft: true)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(BillInput) },
      responses: {
        201: json(z.object({ bill: BillSchema }).merge(SubmitInfo), "Created"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const out = await o.handle.write((tx) => createBillTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(
        {
          bill: await billView(o.handle.db, await mustGetBill(o.handle.db, out.bill.id)),
          ...submitInfo(out.result),
        },
        201,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bills/{billId}",
      tags: ["Bills"],
      summary: "Get a bill",
      security: bearerSecurity,
      request: { params: BillParams },
      responses: { 200: json(BillSchema), ...errorResponses },
    }),
    async (c) => {
      const db = c.get("org").handle.db;
      return c.json(await billView(db, await mustGetBill(db, c.req.valid("param").billId as string)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/bills/{billId}",
      tags: ["Bills"],
      summary: "Edit a draft bill",
      security: bearerSecurity,
      request: { params: BillParams, body: jsonBody(BillInput.partial()) },
      responses: { 200: json(BillSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").billId as string;
      const b = await o.handle.write((tx) => updateBillTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(await billView(o.handle.db, b), 200);
    },
  );
  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/bills/{billId}",
      tags: ["Bills"],
      summary: "Delete a draft bill",
      security: bearerSecurity,
      request: { params: BillParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").billId as string;
      await o.handle.write((tx) => deleteBillDraftTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bills/{billId}/finalize",
      tags: ["Bills"],
      summary: "Post a draft bill",
      security: bearerSecurity,
      request: {
        params: BillParams,
        body: jsonBody(z.object({ lock_override_note: z.string().max(1000).nullable().optional() })),
      },
      responses: { 200: json(z.object({ bill: BillSchema }).merge(SubmitInfo)), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").billId as string;
      const res = await o.handle.write((tx) =>
        finalizeBillTx(tx, o.id, o.actor, id, { lockOverrideNote: c.req.valid("json").lock_override_note }),
      );
      return c.json(
        { bill: await billView(o.handle.db, await mustGetBill(o.handle.db, id)), ...submitInfo(res) },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bills/{billId}/void",
      tags: ["Bills"],
      summary: "Void a bill (reverses its entry; payments must be removed first)",
      security: bearerSecurity,
      request: { params: BillParams, body: jsonBody(z.object({ date: IsoDate.nullable().optional() })) },
      responses: { 200: json(BillSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").billId as string;
      await o.handle.write((tx) => voidBillTx(tx, o.id, o.actor, id, c.req.valid("json").date));
      return c.json(await billView(o.handle.db, await mustGetBill(o.handle.db, id)), 200);
    },
  );

  // ------------------------------------------------------------------ payments
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/payments",
      tags: ["Payments"],
      summary: "List payments (with_credit: only payments with unapplied credit)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          direction: z.enum(["received", "sent"]).optional(),
          contact_id: Id.optional(),
          with_credit: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(PaymentSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        {
          data: await listPayments(c.get("org").handle.db, {
            direction: q.direction,
            contactId: q.contact_id,
            withCredit: q.with_credit === "true",
          }),
        },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/payments",
      tags: ["Payments"],
      summary: "Record a payment received (applied to invoices) or sent (applied to bills)",
      description: "Any amount not applied stays as a credit for the contact and can be applied later.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            direction: z.enum(["received", "sent"]),
            contact_id: Id,
            date: IsoDate,
            amount: Cents.refine((n) => n > 0, "Must be positive"),
            account_id: Id.openapi({
              description:
                "Bank, other current asset, credit card, other current liability, or owner's equity account",
            }),
            method: z.string().max(40).nullable().optional(),
            reference: z.string().max(100).nullable().optional(),
            memo: z.string().max(1000).nullable().optional(),
            applications: z.array(Application).max(200).default([]),
            lock_override_note: z.string().max(1000).nullable().optional(),
          }),
        ),
      },
      responses: {
        201: json(z.object({ payment: PaymentSchema }).merge(SubmitInfo), "Created"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const out = await o.handle.write((tx) => recordPaymentTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(
        {
          payment: await paymentView(o.handle.db, await mustGetPayment(o.handle.db, out.payment.id)),
          ...submitInfo(out.result),
        },
        201,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/payments/{paymentId}",
      tags: ["Payments"],
      summary: "Get a payment",
      security: bearerSecurity,
      request: { params: PaymentParams },
      responses: { 200: json(PaymentSchema), ...errorResponses },
    }),
    async (c) => {
      const db = c.get("org").handle.db;
      return c.json(
        await paymentView(db, await mustGetPayment(db, c.req.valid("param").paymentId as string)),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/payments/{paymentId}/apply",
      tags: ["Payments"],
      summary: "Apply a payment's unapplied credit to invoices (bills)",
      security: bearerSecurity,
      request: {
        params: PaymentParams,
        body: jsonBody(
          z.object({ applications: z.array(Application).min(1).max(200), date: IsoDate.optional() }),
        ),
      },
      responses: { 200: json(PaymentSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").paymentId as string;
      const b = c.req.valid("json");
      const p = await o.handle.write((tx) => applyPaymentTx(tx, o.id, o.actor, id, b.applications, b.date));
      return c.json(await paymentView(o.handle.db, p), 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/payments/{paymentId}/unapply",
      tags: ["Payments"],
      summary: "Remove a payment's application to one document (the amount returns to credit)",
      security: bearerSecurity,
      request: { params: PaymentParams, body: jsonBody(z.object({ document_id: Id })) },
      responses: { 200: json(PaymentSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").paymentId as string;
      await o.handle.write((tx) => unapplyPaymentTx(tx, o.id, o.actor, id, c.req.valid("json").document_id));
      return c.json(await paymentView(o.handle.db, await mustGetPayment(o.handle.db, id)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/payments/{paymentId}/void",
      tags: ["Payments"],
      summary: "Void a payment (reverses its entry and reopens its documents)",
      security: bearerSecurity,
      request: { params: PaymentParams, body: jsonBody(z.object({ date: IsoDate.nullable().optional() })) },
      responses: { 200: json(PaymentSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").paymentId as string;
      await o.handle.write((tx) => voidPaymentTx(tx, o.id, o.actor, id, c.req.valid("json").date));
      return c.json(await paymentView(o.handle.db, await mustGetPayment(o.handle.db, id)), 200);
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/record-payment",
      tags: ["Banking", "Payments"],
      summary: "Record a customer or vendor payment from a bank transaction and link them",
      security: bearerSecurity,
      request: {
        params: P("txnId"),
        body: jsonBody(
          z.object({
            contact_id: Id,
            applications: z.array(Application).max(200).default([]),
            memo: z.string().max(1000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
          }),
        ),
      },
      responses: {
        200: json(z.object({ payment: PaymentSchema, entry: EntrySchema }).merge(SubmitInfo)),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").txnId as string;
      const out = await o.handle.write((tx) => payFromBankTxnTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(
        {
          payment: await paymentView(o.handle.db, await mustGetPayment(o.handle.db, out.payment.id)),
          entry: out.result.entry,
          ...submitInfo(out.result),
        },
        200,
      );
    },
  );

  // ------------------------------------------------------------------ attachments
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/attachments",
      tags: ["Attachments"],
      summary: "Upload a file (receipt, bill, logo), optionally linked to a record",
      description: "multipart/form-data with `file`, and optional `target_type` and `target_id`. Max 20 MB.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.any().openapi({ type: "string", format: "binary" }),
                target_type: z.enum(ATTACHMENT_TARGETS).optional(),
                target_id: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: json(AttachmentSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw badRequest("Attach a file in the `file` field.");
      const tt = typeof body.target_type === "string" ? body.target_type : null;
      const tid = typeof body.target_id === "string" ? body.target_id : null;
      if ((tt && !tid) || (!tt && tid)) throw badRequest("Give both target_type and target_id, or neither.");
      if (tt && !(ATTACHMENT_TARGETS as readonly string[]).includes(tt))
        throw badRequest("Unknown target_type.");
      const store = c.get("ctx").services.storage as BlobStore;
      const blob = await storeBlob(store, o.id, {
        filename: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      const row = await o.handle.write((tx) =>
        recordAttachmentTx(
          tx,
          o.id,
          o.actor,
          blob,
          tt && tid ? { type: tt as (typeof ATTACHMENT_TARGETS)[number], id: tid } : null,
        ),
      );
      return c.json(attachmentView(row), 201);
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/attachments",
      tags: ["Attachments"],
      summary: "List attachments linked to a record",
      security: bearerSecurity,
      request: { params: OrgParams, query: z.object({ target_type: z.string(), target_id: z.string() }) },
      responses: { 200: json(z.object({ data: z.array(AttachmentSchema) })), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        { data: await listAttachments(c.get("org").handle.db, { type: q.target_type, id: q.target_id }) },
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/attachments/{attachmentId}",
      tags: ["Attachments"],
      summary: "Download an attachment",
      security: bearerSecurity,
      request: { params: AttachmentParams },
      responses: {
        200: {
          content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } },
          description: "File",
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const a = await mustGetAttachment(o.handle.db, c.req.valid("param").attachmentId as string);
      const bytes = await (c.get("ctx").services.storage as BlobStore).get(a.storageKey);
      if (!bytes) throw notFound("File");
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "content-type": a.mimeType,
        "content-disposition": dispositionFor(a.mimeType, a.filename),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      });
    },
  );
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/attachments/{attachmentId}/links",
      tags: ["Attachments"],
      summary: "Link or unlink an attachment to a record",
      security: bearerSecurity,
      request: {
        params: AttachmentParams,
        body: jsonBody(
          z.object({
            target_type: z.enum(ATTACHMENT_TARGETS),
            target_id: Id,
            unlink: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").attachmentId as string;
      const b = c.req.valid("json");
      await o.handle.write((tx) =>
        b.unlink
          ? unlinkAttachmentTx(tx, o.id, o.actor, id, { type: b.target_type, id: b.target_id })
          : linkAttachmentTx(tx, o.id, o.actor, id, { type: b.target_type, id: b.target_id }),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
