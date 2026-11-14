/** Ledger API: accounts, journal entries, lock dates, opening balances, reports, verification. */
import { org } from "@cosimo/db";
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, ENTRY_STATUSES } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import { desc } from "drizzle-orm";
import {
  accountView,
  createAccountTx,
  deleteAccountTx,
  getAccount,
  listAccounts,
  updateAccountTx,
} from "../../services/accounts.ts";
import { verifyAnchors } from "../../services/anchor-verify.ts";
import {
  anchorNow,
  anchorPreimageOf,
  anchorVerifyOptions,
  anchorView,
  getAnchor,
  listAnchors,
  proofFileName,
  upgradePending,
} from "../../services/anchors.ts";
import { checkpoint, ledgerHead, verifyOrg } from "../../services/chain.ts";
import {
  createDraftTx,
  deleteDraftTx,
  type EntryInput,
  listEntries,
  mustGetEntry,
  openingBalancesTx,
  replaceEntryTx,
  reverseEntryTx,
  type SubmitResult,
  setLockDatesTx,
  submitDraftTx,
  submitEntryTx,
  updateDraftTx,
} from "../../services/ledger.ts";
import { runForDoc } from "../../services/recurring.ts";
import { REPORT_KEYS, reportCsv, reportPdf, runReport } from "../../services/reports.ts";
import { conflict, notFound } from "../errors.ts";
import { requireOwner, requireWriter } from "../middleware.ts";
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

const AccountSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    subtype: z.string(),
    parent_id: z.string().nullable(),
    tax_line: z.string().nullable(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    is_system: z.boolean(),
    system_key: z.string().nullable(),
    currency: z.string(),
    balance: Cents.optional().openapi({ description: "Posted balance, debit positive (cents)" }),
  })
  .openapi("Account");

const AccountInputSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES).optional(),
  parent_id: Id.nullable().optional(),
  tax_line: z.string().max(40).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  is_active: z.boolean().optional(),
});

const LineSchema = z
  .object({
    id: z.string(),
    account_id: z.string(),
    amount: Cents.openapi({ description: "Debit positive, credit negative (cents)" }),
    currency: z.string(),
    description: z.string().nullable(),
    contact_id: z.string().nullable(),
    line_order: z.number().int(),
  })
  .openapi("JournalLine");

export const EntrySchema = z
  .object({
    id: z.string(),
    date: z.string(),
    memo: z.string().nullable(),
    status: z.enum(ENTRY_STATUSES),
    source_type: z.string(),
    source_id: z.string().nullable(),
    reverses_entry_id: z.string().nullable(),
    reversed_by_entry_id: z.string().nullable(),
    created_by: z.string().nullable(),
    created_by_actor: z.string(),
    created_at: z.string(),
    posted_at: z.string().nullable(),
    posted_by: z.string().nullable(),
    lock_override_note: z.string().nullable(),
    chain_seq: z.number().int().nullable(),
    entry_hash: z.string().nullable(),
    total: Cents.openapi({ description: "Sum of debits" }),
    recurring_template_id: z
      .string()
      .nullable()
      .openapi({ description: "Set only when fetching a single entry, not in list views" }),
    lines: z.array(LineSchema),
  })
  .openapi("JournalEntry");

const LineInputSchema = z.object({
  account_id: Id,
  amount: Cents.refine((n) => n !== 0, "Line amount cannot be zero").openapi({
    description: "Debit positive, credit negative (cents)",
  }),
  description: z.string().max(500).nullable().optional(),
  contact_id: Id.nullable().optional(),
});

const EntryInputSchema = z.object({
  date: IsoDate,
  memo: z.string().max(1000).nullable().optional(),
  lines: z.array(LineInputSchema).min(1).max(500),
  lock_override_note: z.string().max(1000).nullable().optional(),
  rationale: z.string().max(2000).nullable().optional(),
});

export const SubmitResultSchema = z
  .object({
    entry: EntrySchema,
    status: z.enum(ENTRY_STATUSES),
    review: z
      .object({ review_item_id: z.string().nullable(), reason: z.string() })
      .nullable()
      .openapi({ description: "Present when the entry is waiting in the review queue" }),
  })
  .openapi("SubmitResult");

const ReportSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    columns: z.array(
      z.object({
        label: z.string(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
        asOf: z.string().nullable().optional(),
      }),
    ),
    lines: z.array(
      z.object({
        kind: z.enum(["header", "account", "subtotal", "total", "check"]),
        label: z.string(),
        depth: z.number().int(),
        accountId: z.string().optional(),
        code: z.string().optional(),
        values: z.array(z.number().int()),
      }),
    ),
    checks: z.record(z.string(), z.number().int()),
    meta: z.object({
      org_name: z.string(),
      generated_at: z.string(),
      basis: z.enum(["accrual", "cash"]),
      chain_head: z.object({ seq: z.number().int(), hash: z.string() }),
      chain_intact: z.boolean(),
    }),
  })
  .openapi("Report");

const BreakSchema = z
  .object({ chain: z.string(), seq: z.number().int(), id: z.string().nullable(), reason: z.string() })
  .nullable();
const ChainResultSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  head_seq: z.number().int(),
  head_hash: z.string(),
  first_break: BreakSchema,
});
const AnchorCoverageSchema = z
  .object({
    anchored_through: z.object({ ledger_seq: z.number().int(), at: z.string() }).nullable(),
    earliest_anchor_at: z.string().nullable(),
    unanchored_links: z.number().int(),
    late_entries: z.number().int(),
  })
  .openapi("AnchorCoverage");
const AnchorCheckSchema = z
  .object({
    ok: z.boolean(),
    checked: z.number().int(),
    complete: z.number().int(),
    pending: z.number().int(),
    failed: z.number().int(),
    bitcoin: z.enum(["checked", "not checked", "unavailable", "none"]),
    tsa_trust: z.enum(["checked", "not checked", "none"]),
    problems: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["ots", "rfc3161"]),
        service: z.string(),
        ledger_seq: z.number().int(),
        audit_seq: z.number().int(),
        problem: z.string(),
      }),
    ),
    coverage: AnchorCoverageSchema,
  })
  .openapi("AnchorCheck");
const AnchorSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["ots", "rfc3161"]),
    service: z.string(),
    status: z.enum(["pending", "complete", "failed"]),
    ledger_seq: z.number().int(),
    ledger_hash: z.string(),
    audit_seq: z.number().int(),
    audit_hash: z.string(),
    digest: z.string(),
    attested_at: z.string().nullable(),
    block_height: z.number().int().nullable(),
    reason: z.string().nullable(),
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Anchor");
const AnchorNowSchema = z
  .object({
    status: z.enum(["anchored", "partial", "failed", "unchanged", "waiting", "broken", "disabled"]),
    message: z.string(),
    digest: z.string().nullable(),
    ledger_seq: z.number().int(),
    audit_seq: z.number().int(),
    created: z.number().int(),
    errors: z.array(z.string()),
  })
  .openapi("AnchorNowResult");

const VerifySchema = z
  .object({
    ok: z.boolean(),
    ledger: ChainResultSchema,
    audit: ChainResultSchema,
    checkpoints: z.object({
      ok: z.boolean(),
      mismatches: z.array(
        z.object({
          chain: z.string(),
          seq: z.number().int(),
          expected: z.string(),
          actual: z.string().nullable(),
        }),
      ),
    }),
    first_break: BreakSchema,
    anchors: AnchorCheckSchema,
  })
  .openapi("VerifyResult");

const CheckpointSchema = z
  .object({
    id: z.string(),
    chain: z.enum(["ledger", "audit"]),
    seq: z.number().int(),
    head_hash: z.string(),
    reason: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Checkpoint");

const AccountParams = OrgParams.extend({
  accountId: Id.openapi({ param: { name: "accountId", in: "path" } }),
});
const EntryParams = OrgParams.extend({ entryId: Id.openapi({ param: { name: "entryId", in: "path" } }) });

function toLines(lines: z.infer<typeof LineInputSchema>[]) {
  return lines.map((l) => ({
    accountId: l.account_id,
    amount: l.amount,
    description: l.description ?? null,
    contactId: l.contact_id ?? null,
  }));
}

function toEntryInput(b: z.infer<typeof EntryInputSchema>): EntryInput {
  return {
    date: b.date,
    memo: b.memo ?? null,
    lines: toLines(b.lines),
    lockOverrideNote: b.lock_override_note ?? null,
    rationale: b.rationale ?? null,
  };
}

export function submitView(r: SubmitResult) {
  return {
    entry: r.entry,
    status: r.entry.status,
    review: r.reviewItemId ? { review_item_id: r.reviewItemId, reason: r.decision?.reason ?? "" } : null,
  };
}

function chainView(v: Awaited<ReturnType<typeof verifyOrg>>["ledger"]) {
  return {
    ok: v.ok,
    checked: v.checked,
    head_seq: v.headSeq,
    head_hash: v.headHash,
    first_break: v.firstBreak,
  };
}

export function verifyView(v: Awaited<ReturnType<typeof verifyOrg>>) {
  return {
    ok: v.ok,
    ledger: chainView(v.ledger),
    audit: chainView(v.audit),
    checkpoints: v.checkpoints,
    first_break: v.firstBreak,
    anchors: v.anchors,
  };
}

export function ledgerRoutes() {
  const r = newRouter();
  const tags = ["Ledger"];

  // ------------------------------------------------------------------ accounts
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/accounts",
      tags: ["Accounts"],
      summary: "List the chart of accounts",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          include_balances: z.enum(["true", "false"]).optional(),
          as_of: IsoDate.optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(AccountSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const q = c.req.valid("query");
      const data = await listAccounts(o.handle.db, {
        withBalances: q.include_balances === "true",
        asOf: q.as_of,
      });
      return c.json({ data }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/accounts",
      tags: ["Accounts"],
      summary: "Create an account",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(AccountInputSchema) },
      responses: { 201: json(AccountSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const a = await o.handle.write((tx) => createAccountTx(tx, o.id, o.actor, b));
      return c.json(accountView(a), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/accounts/{accountId}",
      tags: ["Accounts"],
      summary: "Get an account",
      security: bearerSecurity,
      request: { params: AccountParams },
      responses: { 200: json(AccountSchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const a = await getAccount(o.handle.db, c.req.valid("param").accountId);
      const bal =
        (await listAccounts(o.handle.db, { withBalances: true })).find((x) => x.id === a.id)?.balance ?? 0;
      return c.json(accountView(a, bal), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/accounts/{accountId}",
      tags: ["Accounts"],
      summary: "Update an account. Type cannot change once the account has posted lines.",
      security: bearerSecurity,
      request: { params: AccountParams, body: jsonBody(AccountInputSchema.partial()) },
      responses: { 200: json(AccountSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").accountId;
      const a = await o.handle.write((tx) => updateAccountTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(accountView(a), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/accounts/{accountId}",
      tags: ["Accounts"],
      summary: "Delete an unused, non-system account",
      security: bearerSecurity,
      request: { params: AccountParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").accountId;
      await o.handle.write((tx) => deleteAccountTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ entries
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/entries",
      tags,
      summary: "List journal entries (newest first)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          status: z.string().optional().openapi({ description: "Comma-separated statuses" }),
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          account_id: Id.optional(),
          source_type: z.string().optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(EntrySchema), next_cursor: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const q = c.req.valid("query");
      const status = q.status
        ?.split(",")
        .map((s) => s.trim())
        .filter((s): s is (typeof ENTRY_STATUSES)[number] =>
          (ENTRY_STATUSES as readonly string[]).includes(s),
        );
      const out = await listEntries(o.handle.db, {
        status,
        from: q.from,
        to: q.to,
        accountId: q.account_id,
        sourceType: q.source_type,
        q: q.q,
        limit: q.limit,
        cursor: q.cursor,
      });
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/entries",
      tags,
      summary: "Create a journal entry",
      description:
        "With `draft: true` the entry is saved as a draft. Otherwise it goes through the review policy and is either posted or placed in the review queue (`status: pending_review`).",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(EntryInputSchema.extend({ draft: z.boolean().optional() })),
      },
      responses: { 201: json(SubmitResultSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const input = toEntryInput(b);
      const out = await o.handle.write(async (tx) => {
        if (b.draft) {
          const id = await createDraftTx(tx, o.id, o.actor, input);
          return { entry: await mustGetEntry(tx, id), decision: null, reviewItemId: null };
        }
        return submitEntryTx(tx, o.id, o.actor, input);
      });
      return c.json(submitView(out), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/entries/{entryId}",
      tags,
      summary: "Get a journal entry",
      security: bearerSecurity,
      request: { params: EntryParams },
      responses: { 200: json(EntrySchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const entry = await mustGetEntry(o.handle.db, c.req.valid("param").entryId);
      const run = await runForDoc(o.handle.db, "entry", entry.id);
      return c.json({ ...entry, recurring_template_id: run?.templateId ?? null }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/entries/{entryId}",
      tags,
      summary: "Update a draft entry",
      security: bearerSecurity,
      request: { params: EntryParams, body: jsonBody(EntryInputSchema.partial()) },
      responses: { 200: json(EntrySchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").entryId;
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        updateDraftTx(tx, o.id, o.actor, id, {
          date: b.date,
          memo: b.memo,
          lines: b.lines ? toLines(b.lines) : undefined,
          lockOverrideNote: b.lock_override_note,
        }),
      );
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/entries/{entryId}",
      tags,
      summary: "Delete a draft entry",
      security: bearerSecurity,
      request: { params: EntryParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").entryId;
      await o.handle.write((tx) => deleteDraftTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/entries/{entryId}/submit",
      tags,
      summary: "Submit a draft: post it or send it to review, per policy",
      security: bearerSecurity,
      request: {
        params: EntryParams,
        body: jsonBody(z.object({ rationale: z.string().max(2000).nullable().optional() })),
      },
      responses: { 200: json(SubmitResultSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").entryId;
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        submitDraftTx(tx, o.id, o.actor, id, { rationale: b.rationale ?? null }),
      );
      return c.json(submitView(out), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/entries/{entryId}/reverse",
      tags,
      summary: "Reverse a posted entry",
      description: "Creates a new entry with every line negated, linked through `reverses_entry_id`.",
      security: bearerSecurity,
      request: {
        params: EntryParams,
        body: jsonBody(
          z.object({
            date: IsoDate.optional(),
            memo: z.string().max(1000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
            rationale: z.string().max(2000).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(SubmitResultSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").entryId;
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        reverseEntryTx(tx, o.id, o.actor, id, {
          date: b.date,
          memo: b.memo,
          lockOverrideNote: b.lock_override_note,
          rationale: b.rationale,
        }),
      );
      return c.json(submitView(out), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/entries/{entryId}/replace",
      tags,
      summary: "Edit a posted entry by reversing it and posting a corrected replacement",
      security: bearerSecurity,
      request: { params: EntryParams, body: jsonBody(EntryInputSchema) },
      responses: {
        200: json(z.object({ reversal: SubmitResultSchema, replacement: SubmitResultSchema })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").entryId;
      const out = await o.handle.write((tx) =>
        replaceEntryTx(tx, o.id, o.actor, id, toEntryInput(c.req.valid("json"))),
      );
      return c.json({ reversal: submitView(out.reversal), replacement: submitView(out.replacement) }, 200);
    },
  );

  // ------------------------------------------------------------------ lock dates, opening balances
  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/lock-dates",
      tags,
      summary: "Set the soft and hard lock dates (owner)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            soft_lock_date: IsoDate.nullable().optional(),
            hard_lock_date: IsoDate.nullable().optional(),
          }),
        ),
      },
      responses: {
        200: json(z.object({ soft_lock_date: z.string().nullable(), hard_lock_date: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json");
      const s = await o.handle.write((tx) =>
        setLockDatesTx(tx, o.id, o.actor, { softLockDate: b.soft_lock_date, hardLockDate: b.hard_lock_date }),
      );
      return c.json({ soft_lock_date: s.softLockDate, hard_lock_date: s.hardLockDate }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/opening-balances",
      tags,
      summary: "Record opening balances as one entry against Opening Balance Equity",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            date: IsoDate,
            balances: z
              .array(z.object({ account_id: Id, amount: Cents.openapi({ description: "Debit positive" }) }))
              .min(1)
              .max(1000),
            memo: z.string().max(1000).nullable().optional(),
            lock_override_note: z.string().max(1000).nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(SubmitResultSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        openingBalancesTx(tx, o.id, o.actor, {
          date: b.date,
          balances: b.balances.map((x) => ({ accountId: x.account_id, amount: x.amount })),
          memo: b.memo,
          lockOverrideNote: b.lock_override_note,
        }),
      );
      return c.json(submitView(out), 201);
    },
  );

  // ------------------------------------------------------------------ reports
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reports/{report}",
      tags: ["Reports"],
      summary: "Run a report",
      description:
        "Amounts are integer cents. Every report includes the ledger chain head so a saved copy can be checked against the books later. `format=csv` or `format=pdf` returns a file. `basis` defaults to the org's default basis; the general ledger is always accrual. Aging reports use `as_of`; the 1099 summary uses the year of `to`.",
      security: bearerSecurity,
      request: {
        params: OrgParams.extend({
          report: z.enum(REPORT_KEYS).openapi({ param: { name: "report", in: "path" } }),
        }),
        query: z.object({
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          as_of: IsoDate.optional(),
          compare: z.enum(["none", "prior_period", "prior_year", "monthly"]).optional(),
          basis: z.enum(["accrual", "cash"]).optional(),
          account_id: z
            .string()
            .optional()
            .openapi({ description: "Comma-separated account ids (general ledger)" }),
          format: z.enum(["json", "csv", "pdf"]).optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: ReportSchema },
            "text/csv": { schema: z.string() },
            "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
          },
          description: "Report",
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const key = c.req.valid("param").report;
      const q = c.req.valid("query");
      const reg = await c.get("ctx").orgs.get(o.id);
      const report = await runReport(o.handle.db, o.id, reg?.name ?? "", key, {
        from: q.from,
        to: q.to,
        as_of: q.as_of,
        compare: q.compare,
        basis: q.basis,
        account_ids: q.account_id?.split(",").filter(Boolean),
      });
      if (q.format === "pdf") {
        const pdf = await reportPdf(report);
        return c.body(pdf as unknown as ArrayBuffer, 200, {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${key}.pdf"`,
        });
      }
      if (q.format === "csv") {
        return c.body(reportCsv(report), 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${key}.csv"`,
        });
      }
      const { gl: _gl, ...rest } = report;
      return c.json(rest, 200);
    },
  );

  // ------------------------------------------------------------------ chain
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/verify",
      tags: ["Integrity"],
      summary: "Recompute both hash chains and report the first broken link",
      description:
        "Also checks every public timestamp (anchor) against the chains and its own proof. With `network=true`, complete OpenTimestamps proofs are confirmed against the configured Bitcoin block explorer; if it can't be reached, `anchors.bitcoin` is `unavailable` and verification doesn't fail for that.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({ network: z.enum(["true", "false"]).optional() }),
      },
      responses: { 200: json(VerifySchema), ...errorResponses },
    }),
    async (c) => {
      const o = c.get("org");
      const anchors = anchorVerifyOptions(c.get("ctx"), { network: c.req.valid("query").network === "true" });
      return c.json(verifyView(await verifyOrg(o.handle.db, o.id, { anchors })), 200);
    },
  );

  const AnchorParams = OrgParams.extend({
    anchorId: Id.openapi({ param: { name: "anchorId", in: "path" } }),
  });

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/anchors",
      tags: ["Integrity"],
      summary: "List public timestamps of the chain heads (newest first) with coverage",
      description:
        "Up to 200 anchors without their proof bytes, whether timestamping is on (`anchoring.enabled`), and an offline check of every stored anchor: `check.coverage` says how far the ledger is timestamped.",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ enabled: z.boolean(), data: z.array(AnchorSchema), check: AnchorCheckSchema })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const ctx = c.get("ctx");
      const rows = await listAnchors(o.handle);
      const check = await verifyAnchors(o.handle.db, o.id, anchorVerifyOptions(ctx));
      return c.json({ enabled: ctx.config.anchoring.enabled, data: rows.map(anchorView), check }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/anchors/{anchorId}/proof",
      tags: ["Integrity"],
      summary: "Download an anchor's proof (.ots or .tsr) or the text it commits to",
      description:
        "`file=proof` (default) returns the OpenTimestamps file `anchor-<seq>.txt.ots` or the RFC 3161 response `anchor-<seq>.tsr`; `file=preimage` returns `anchor-<seq>.txt`. Save both side by side and check them with `ots verify` or `openssl ts -verify` (docs/chain-format.md).",
      security: bearerSecurity,
      request: {
        params: AnchorParams,
        query: z.object({ file: z.enum(["proof", "preimage"]).default("proof") }),
      },
      responses: {
        200: {
          content: {
            "text/plain": { schema: z.string() },
            "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          },
          description: "File",
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const row = await getAnchor(o.handle, c.req.valid("param").anchorId);
      if (!row) throw notFound("Anchor");
      if (c.req.valid("query").file === "preimage")
        return c.body(anchorPreimageOf(o.id, row), 200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="anchor-${row.ledgerSeq}.txt"`,
        });
      if (!row.proof) throw notFound("Proof");
      return c.body(Buffer.from(row.proof, "base64") as unknown as ArrayBuffer, 200, {
        "content-type": row.kind === "ots" ? "application/octet-stream" : "application/timestamp-reply",
        "content-disposition": `attachment; filename="${proofFileName(row)}"`,
      });
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/anchors",
      tags: ["Integrity"],
      summary: "Timestamp the chain heads now and check pending proofs (owner)",
      description:
        "Sends the digest of the current ledger and audit heads to each configured OpenTimestamps calendar and RFC 3161 authority that doesn't already hold them, then asks calendars about pending proofs. Refuses (status `broken`) when the chain doesn't verify. 409 when timestamping is off.",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            result: AnchorNowSchema,
            upgrade: z.object({
              checked: z.number().int(),
              completed: z.number().int(),
              failed: z.number().int(),
              pending: z.number().int(),
              errors: z.array(z.string()),
            }),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      const ctx = c.get("ctx");
      if (!ctx.config.anchoring.enabled)
        throw conflict("Timestamping is off (anchoring.enabled in the config).", "anchoring_disabled");
      const result = await anchorNow(ctx, o.handle, o.id, "manual");
      const upgrade = await upgradePending(ctx, o.handle, o.id);
      return c.json({ result, upgrade }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/checkpoints",
      tags: ["Integrity"],
      summary: "List chain checkpoints (newest first) and the current heads",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            data: z.array(CheckpointSchema),
            ledger_head: z.object({ seq: z.number().int(), hash: z.string() }),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      const rows = await o.handle.db
        .select()
        .from(org.chainCheckpoints)
        .orderBy(desc(org.chainCheckpoints.createdAt), desc(org.chainCheckpoints.id))
        .limit(200)
        .all();
      return c.json(
        {
          data: rows.map((r) => ({
            id: r.id,
            chain: r.chain,
            seq: r.seq,
            head_hash: r.headHash,
            reason: r.reason,
            created_at: r.createdAt,
          })),
          ledger_head: await ledgerHead(o.handle.db, o.id),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/checkpoints",
      tags: ["Integrity"],
      summary: "Record a checkpoint of both chain heads now (owner)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 201: json(z.object({ data: z.array(CheckpointSchema) }), "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const rows = await o.handle.write((tx) => checkpoint(tx, o.id, "manual"));
      const created = new Date().toISOString();
      return c.json(
        {
          data: rows.map((r) => ({
            id: r.id,
            chain: r.chain,
            seq: r.seq,
            head_hash: r.headHash,
            reason: r.reason,
            created_at: created,
          })),
        },
        201,
      );
    },
  );

  return r;
}
