/** Banking API: bank accounts, categorizing, rules, review queue, reconciliation. */

import { DATE_FORMATS } from "@cosimo/core";
import { org } from "@cosimo/db";
import { ACTORS } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import { asc, desc, eq } from "drizzle-orm";
import {
  bankTxnView,
  categorizeTx,
  countBankTxns,
  createBankAccountTx,
  excludeTx,
  listBankAccounts,
  listBankTxns,
  matchCandidates,
  matchTx,
  mustGetBankTxn,
  type TxnBucket,
  transferTx,
  uncategorizeTx,
  updateBankAccountTx,
} from "../../services/banking.ts";
import { commitImportTx, MAX_IMPORT_BYTES, previewImport } from "../../services/imports.ts";
import { withReceipts } from "../../services/receipts.ts";
import {
  completeReconTx,
  discardReconTx,
  listRecons,
  reconLines,
  startReconTx,
  toggleLinesTx,
  undoReconTx,
  unreconciled,
} from "../../services/reconcile.ts";
import {
  approveReviewTx,
  deletePolicyTx,
  listReview,
  mustGetReview,
  pendingCount,
  policyView,
  rejectReviewTx,
  reviewView,
  savePolicyTx,
} from "../../services/review.ts";
import { createRuleTx, deleteRuleTx, listRules, updateRuleTx } from "../../services/rules.ts";
import { ApiError, forbidden, fromDbError } from "../errors.ts";
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
import { EntrySchema, submitView } from "./ledger.ts";
import { SyncStatusFields } from "./plaid.ts";

const BankAccountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["checking", "savings", "credit_card", "other"]),
    mask: z.string().nullable(),
    currency: z.string(),
    is_active: z.boolean(),
    ledger_account_id: z.string(),
    connection_id: z.string().nullable(),
    balance: Cents,
    unreviewed: z.number().int().openapi({ description: "Not pending, and not already in review" }),
    pending: z.number().int(),
    pending_amount: Cents,
    last_transaction_date: z.string().nullable(),
    ...SyncStatusFields,
  })
  .openapi("BankAccount");

const BankTxnCountsSchema = z
  .object({
    all: z.number().int(),
    to_categorize: z.number().int(),
    pending: z.object({ count: z.number().int(), total: Cents }),
    categorized: z.number().int(),
    excluded: z.number().int(),
  })
  .openapi("BankTxnCounts");

const SuggestionSchema = z
  .object({
    source: z.enum(["rule", "history", "payout", "receipt"]),
    account_id: z.string().nullable().optional(),
    transfer_account_id: z.string().nullable().optional(),
    contact_id: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    rule_id: z.string().nullable().optional(),
    rule_name: z.string().nullable().optional(),
    payout_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        "A Stripe payout this deposit matches; accepting the transfer from the clearing account links it.",
      ),
    payout_arrival_date: z.string().nullable().optional(),
    receipt_id: z
      .string()
      .nullable()
      .optional()
      .describe("The receipt this suggestion comes from; categorizing the transaction confirms the match."),
  })
  .openapi("Suggestion");

export const BankTxnSchema = z
  .object({
    id: z.string(),
    bank_account_id: z.string(),
    date: z.string(),
    amount: Cents.openapi({ description: "Positive = money into the account" }),
    description: z.string(),
    payee: z.string().nullable(),
    is_pending: z.boolean(),
    status: z.enum(["new", "categorized", "matched", "excluded"]),
    entry_id: z.string().nullable(),
    entry_status: z.string().nullable(),
    review_item_id: z.string().nullable(),
    rule_id: z.string().nullable(),
    suggestion: SuggestionSchema.nullable(),
    batch_id: z.string().nullable(),
    provider_transaction_id: z.string().nullable(),
    receipt_id: z.string().nullable().openapi({ description: "The receipt matched to this transaction" }),
    suggested_receipt_ids: z
      .array(z.string())
      .openapi({ description: "Inbox receipts suggested for this transaction, not yet confirmed" }),
  })
  .openapi("BankTransaction");

const ActionResultSchema = z
  .object({
    transaction: BankTxnSchema,
    entry: EntrySchema.nullable(),
    status: z.string(),
    review: z.object({ review_item_id: z.string().nullable(), reason: z.string() }).nullable(),
  })
  .openapi("BankActionResult");

const RuleConditionsSchema = z
  .object({
    description_contains: z.string().max(200).nullable().optional(),
    description_regex: z.string().max(200).nullable().optional(),
    amount_eq: Cents.nullable().optional(),
    amount_min: Cents.nullable().optional(),
    amount_max: Cents.nullable().optional(),
    direction: z.enum(["in", "out"]).nullable().optional(),
    bank_account_id: Id.nullable().optional(),
  })
  .openapi("RuleConditions");
const RuleActionsSchema = z
  .object({
    account_id: Id.nullable().optional(),
    contact_id: Id.nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
    transfer_account_id: Id.nullable().optional(),
    auto_post: z.boolean().optional(),
  })
  .openapi("RuleActions");
const RuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    priority: z.number().int(),
    is_active: z.boolean(),
    conditions: RuleConditionsSchema,
    actions: RuleActionsSchema,
    times_applied: z.number().int(),
    created_by_actor: z.string(),
    created_at: z.string(),
  })
  .openapi("Rule");
const RuleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  priority: z.number().int().min(0).max(100000).optional(),
  is_active: z.boolean().optional(),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
  rationale: z.string().max(2000).nullable().optional(),
});

const ReviewSchema = z
  .object({
    id: z.string(),
    item_type: z.enum([
      "journal_entry",
      "bank_categorization",
      "rule",
      "invoice_draft",
      "bill_draft",
      "entry_replacement",
      "payment_redate",
      "import_batch",
      "recurring_template",
    ]),
    item_id: z.string(),
    proposed_by_actor: z.string(),
    proposed_by_id: z.string().nullable(),
    reason: z.string(),
    rationale: z.string().nullable(),
    payload: z.unknown(),
    original_payload: z.unknown(),
    edited: z.boolean(),
    amount: z.number().int().nullable(),
    status: z.enum(["pending", "approved", "rejected", "expired"]),
    decided_by: z.string().nullable(),
    decided_at: z.string().nullable(),
    decision_note: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ReviewItem");

const PolicySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    actor: z.string(),
    condition: z.record(z.string(), z.unknown()),
    action: z.enum(["auto_approve", "require_review"]),
    priority: z.number().int(),
  })
  .openapi("ReviewPolicy");
const PolicyInputSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  actor: z.enum([...ACTORS, "*"]),
  condition: z
    .object({
      amount_lt: Cents.optional(),
      amount_gte: Cents.optional(),
      item_types: z
        .array(
          z.enum([
            "journal_entry",
            "bank_categorization",
            "rule",
            "invoice_draft",
            "bill_draft",
            "entry_replacement",
            "payment_redate",
            "recurring_template",
          ]),
        )
        .optional(),
      account_used_for_payee: z.boolean().optional(),
      rule_auto_post: z.boolean().optional(),
    })
    .strict(),
  action: z.enum(["auto_approve", "require_review"]),
  priority: z.number().int().min(0).max(100000).default(100),
});

const ReconSchema = z
  .object({
    id: z.string(),
    account_id: z.string(),
    statement_end_date: z.string(),
    statement_ending_balance: Cents,
    beginning_balance: Cents,
    cleared_balance: Cents,
    difference: Cents,
    status: z.enum(["in_progress", "completed", "undone"]),
    created_at: z.string(),
    completed_at: z.string().nullable(),
    undone_at: z.string().nullable(),
  })
  .openapi("Reconciliation");
const ReconLineSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  date: z.string(),
  memo: z.string().nullable(),
  description: z.string().nullable().optional(),
  amount: Cents.openapi({ description: "In the account's statement sign" }),
  cleared: z.boolean().optional(),
});

const BankParams = OrgParams.extend({
  bankAccountId: Id.openapi({ param: { name: "bankAccountId", in: "path" } }),
});
const TxnParams = OrgParams.extend({ txnId: Id.openapi({ param: { name: "txnId", in: "path" } }) });
const RuleParams = OrgParams.extend({ ruleId: Id.openapi({ param: { name: "ruleId", in: "path" } }) });
const ReviewParams = OrgParams.extend({ reviewId: Id.openapi({ param: { name: "reviewId", in: "path" } }) });
const PolicyParams = OrgParams.extend({ policyId: Id.openapi({ param: { name: "policyId", in: "path" } }) });
const ReconParams = OrgParams.extend({ reconId: Id.openapi({ param: { name: "reconId", in: "path" } }) });

const Rationale = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .openapi({ description: "Why; shown in the review queue" });
const LockNote = z.string().max(1000).nullable().optional();

export function bankingRoutes() {
  const r = newRouter();
  const tags = ["Banking"];

  const txnOut = async (
    db: Parameters<typeof mustGetBankTxn>[0],
    txnId: string,
    res: Parameters<typeof submitView>[0] | null,
  ) => {
    const t = await mustGetBankTxn(db, txnId);
    const v = res ? submitView(res) : null;
    const [view] = await withReceipts(db, [bankTxnView(t, v?.entry.status ?? null)]);
    return {
      transaction: view!,
      entry: v?.entry ?? null,
      status: v?.status ?? t.status,
      review: v?.review ?? null,
    };
  };

  // ------------------------------------------------------------------ bank accounts
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-accounts",
      tags,
      summary: "List bank and credit card accounts with balances and unreviewed counts",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(BankAccountSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await listBankAccounts(c.get("org").handle.db) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-accounts",
      tags,
      summary: "Add a bank or credit card account (creates its ledger account unless one is given)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            name: z.string().trim().min(1).max(200),
            kind: z.enum(["checking", "savings", "credit_card", "other"]),
            mask: z.string().max(8).nullable().optional(),
            ledger_account_id: Id.nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(BankAccountSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = await o.handle.write((tx) => createBankAccountTx(tx, o.id, o.actor, c.req.valid("json")));
      const view = (await listBankAccounts(o.handle.db)).find((x) => x.id === b.id)!;
      return c.json(view, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/bank-accounts/{bankAccountId}",
      tags,
      summary: "Rename or deactivate a bank account",
      security: bearerSecurity,
      request: {
        params: BankParams,
        body: jsonBody(
          z.object({
            name: z.string().trim().min(1).max(200).optional(),
            mask: z.string().max(8).nullable().optional(),
            is_active: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(BankAccountSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").bankAccountId;
      await o.handle.write((tx) => updateBankAccountTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json((await listBankAccounts(o.handle.db)).find((x) => x.id === id)!, 200);
    },
  );

  // ------------------------------------------------------------------ transactions
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-transactions",
      tags,
      summary: "List bank transactions (newest first)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          bank_account_id: Id.optional(),
          status: z
            .string()
            .optional()
            .openapi({ description: "Comma-separated: new, categorized, matched, excluded" }),
          bucket: z
            .string()
            .optional()
            .openapi({ description: "Comma-separated: to_categorize, pending, categorized, excluded" }),
          q: z.string().max(200).optional(),
          has_receipt: z.enum(["true", "false"]).optional().openapi({
            description: "Only transactions with (true) or without (false) a matched or suggested receipt",
          }),
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(BankTxnSchema), next_cursor: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const status = q.status
        ?.split(",")
        .map((s) => s.trim())
        .filter((s): s is "new" | "categorized" | "matched" | "excluded" =>
          ["new", "categorized", "matched", "excluded"].includes(s),
        );
      const bucket = q.bucket
        ?.split(",")
        .map((s) => s.trim())
        .filter((s): s is TxnBucket => ["to_categorize", "pending", "categorized", "excluded"].includes(s));
      return c.json(
        await listBankTxns(c.get("org").handle.db, {
          bankAccountId: q.bank_account_id,
          status,
          bucket,
          has_receipt: q.has_receipt === undefined ? undefined : q.has_receipt === "true",
          q: q.q,
          from: q.from,
          to: q.to,
          limit: q.limit,
          cursor: q.cursor,
        }),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-transactions/counts",
      tags,
      summary: "Counts of bank transactions per bucket, for the Categorize page's filter pills",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({ bank_account_id: Id.optional(), q: z.string().max(200).optional() }),
      },
      responses: { 200: json(BankTxnCountsSchema), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await countBankTxns(c.get("org").handle.db, { bankAccountId: q.bank_account_id, q: q.q }),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-transactions/{txnId}",
      tags,
      summary: "Get a bank transaction",
      security: bearerSecurity,
      request: { params: TxnParams },
      responses: { 200: json(BankTxnSchema), ...errorResponses },
    }),
    async (c) => {
      const db = c.get("org").handle.db;
      const t = await mustGetBankTxn(db, c.req.valid("param").txnId);
      const [view] = await withReceipts(db, [bankTxnView(t)]);
      return c.json(view!, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/categorize",
      tags,
      summary: "Categorize or split a bank transaction",
      description:
        "Creates one entry: the bank account line for the transaction amount and one line per split. Split amounts are positive and must add up to the transaction amount. The review policy decides whether it posts or waits for review.",
      security: bearerSecurity,
      request: {
        params: TxnParams,
        body: jsonBody(
          z.object({
            splits: z
              .array(
                z.object({
                  account_id: Id,
                  amount: Cents.refine((n) => n > 0, "Must be positive"),
                  contact_id: Id.nullable().optional(),
                  description: z.string().max(500).nullable().optional(),
                }),
              )
              .min(1)
              .max(50),
            memo: z.string().max(1000).nullable().optional(),
            contact_id: Id.nullable().optional(),
            rationale: Rationale,
            lock_override_note: LockNote,
          }),
        ),
      },
      responses: { 200: json(ActionResultSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").txnId;
      const res = await o.handle.write(async (tx) =>
        txnOut(tx, id, await categorizeTx(tx, o.id, o.actor, id, c.req.valid("json"))),
      );
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/transfer",
      tags,
      summary: "Mark as a transfer to another of the org's accounts",
      description:
        "Creates one entry with two lines. If the other side was already imported as a bank transaction within 5 days, both transactions are linked to the same entry.",
      security: bearerSecurity,
      request: {
        params: TxnParams,
        body: jsonBody(
          z.object({
            account_id: Id,
            memo: z.string().max(1000).nullable().optional(),
            rationale: Rationale,
            lock_override_note: LockNote,
          }),
        ),
      },
      responses: {
        200: json(ActionResultSchema.extend({ counterpart_id: z.string().nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").txnId;
      const res = await o.handle.write(async (tx) => {
        const r2 = await transferTx(tx, o.id, o.actor, id, c.req.valid("json"));
        return { ...(await txnOut(tx, id, r2)), counterpart_id: r2.counterpartId };
      });
      return c.json(res, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/match-candidates",
      tags,
      summary: "Posted entries that could match this transaction",
      security: bearerSecurity,
      request: { params: TxnParams },
      responses: {
        200: json(
          z.object({
            data: z.array(
              z.object({ id: z.string(), date: z.string(), memo: z.string().nullable(), source: z.string() }),
            ),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({ data: await matchCandidates(c.get("org").handle.db, c.req.valid("param").txnId) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/match",
      tags,
      summary: "Match to an entry already recorded (for example an invoice payment)",
      security: bearerSecurity,
      request: { params: TxnParams, body: jsonBody(z.object({ entry_id: Id })) },
      responses: { 200: json(ActionResultSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").txnId;
      const res = await o.handle.write(async (tx) => {
        await matchTx(tx, o.id, o.actor, id, c.req.valid("json").entry_id);
        return txnOut(tx, id, null);
      });
      return c.json(res, 200);
    },
  );

  for (const [path, exclude, summary] of [
    ["exclude", true, "Exclude (ignore) a transaction, for example a duplicate from the bank"],
    ["restore", false, "Restore an excluded transaction to Categorize"],
  ] as const) {
    r.openapi(
      createRoute({
        method: "post",
        path: `/orgs/{orgId}/bank-transactions/{txnId}/${path}`,
        tags,
        summary,
        security: bearerSecurity,
        request: { params: TxnParams },
        responses: { 200: json(ActionResultSchema), ...errorResponses },
      }),
      async (c) => {
        const o = requireWriter(c);
        const id = c.req.valid("param").txnId;
        const res = await o.handle.write(async (tx) => {
          await excludeTx(tx, o.id, o.actor, id, exclude);
          return txnOut(tx, id, null);
        });
        return c.json(res, 200);
      },
    );
  }

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-transactions/{txnId}/undo",
      tags,
      summary: "Undo a categorization, match, or transfer and send the transaction back to Categorize",
      description: "Entries created from this transaction are reversed (never deleted).",
      security: bearerSecurity,
      request: { params: TxnParams, body: jsonBody(z.object({ lock_override_note: LockNote })) },
      responses: { 200: json(ActionResultSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").txnId;
      const res = await o.handle.write(async (tx) => {
        await uncategorizeTx(tx, o.id, o.actor, id, c.req.valid("json"));
        return txnOut(tx, id, null);
      });
      return c.json(res, 200);
    },
  );

  // ------------------------------------------------------------------ file import
  const ProfileSchema = z
    .object({
      hasHeader: z.boolean(),
      skipRows: z.number().int().min(0).max(100),
      delimiter: z.string().max(1).nullable().optional(),
      dateFormat: z.enum(DATE_FORMATS),
      amountMode: z.enum(["signed", "debit_credit", "amount_type"]),
      signConvention: z.enum(["positive_is_deposit", "positive_is_withdrawal"]),
      columns: z.object({
        date: z.number().int().min(0),
        description: z.number().int().min(0),
        amount: z.number().int().min(0).nullable().optional(),
        debit: z.number().int().min(0).nullable().optional(),
        credit: z.number().int().min(0).nullable().optional(),
        type: z.number().int().min(0).nullable().optional(),
        payee: z.number().int().min(0).nullable().optional(),
        memo: z.number().int().min(0).nullable().optional(),
      }),
      outflowTypes: z.array(z.string().max(40)).max(20).optional(),
    })
    .openapi("CsvProfile");
  const ImportBody = z.object({
    filename: z.string().min(1).max(255),
    content: z
      .string()
      .max(MAX_IMPORT_BYTES)
      .openapi({ description: "File contents as text (CSV, OFX, or QFX)" }),
    profile: ProfileSchema.nullable()
      .optional()
      .openapi({ description: "CSV column mapping; defaults to the saved one, else a guess" }),
  });
  const ImportParseError = z.object({ row: z.number().int(), message: z.string() });

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-accounts/{bankAccountId}/import/preview",
      tags,
      summary: "Parse a statement file and show what would be imported (nothing is saved)",
      security: bearerSecurity,
      request: { params: BankParams, body: jsonBody(ImportBody) },
      responses: {
        200: json(
          z
            .object({
              format: z.enum(["csv", "ofx", "qfx"]),
              profile: ProfileSchema.nullable(),
              profile_source: z.enum(["given", "saved", "guessed"]).nullable(),
              headers: z.array(z.string()),
              preview: z.array(z.array(z.string())),
              account: z.record(z.string(), z.unknown()).nullable(),
              summary: z.object({
                rows: z.number().int(),
                new: z.number().int(),
                duplicates: z.number().int(),
                errors: z.number().int(),
              }),
              errors: z.array(ImportParseError),
              sample: z.array(
                z.object({
                  date: z.string(),
                  amount: Cents,
                  description: z.string(),
                  payee: z.string().nullable(),
                  duplicate: z.boolean(),
                }),
              ),
            })
            .openapi("ImportPreview"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      requireWriter(c);
      const out = await previewImport(
        c.get("org").handle.db,
        c.req.valid("param").bankAccountId,
        c.req.valid("json"),
      );
      return c.json(out as never, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-accounts/{bankAccountId}/import",
      tags,
      summary: "Import a statement file. Re-importing the same rows creates nothing new.",
      security: bearerSecurity,
      request: {
        params: BankParams,
        body: jsonBody(ImportBody.extend({ save_profile: z.boolean().optional() })),
      },
      responses: {
        200: json(
          z
            .object({
              batch_id: z.string().nullable(),
              format: z.string(),
              rows: z.number().int(),
              imported: z.number().int(),
              duplicates: z.number().int(),
              errors: z.number().int(),
              error_rows: z.array(ImportParseError),
              transfers_paired: z.number().int(),
              rules_applied: z.number().int(),
              auto_posted: z.number().int(),
              proposed: z.number().int(),
              suggested: z.number().int(),
            })
            .openapi("ImportResult"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").bankAccountId;
      const out = await o.handle.write((tx) => commitImportTx(tx, o.id, o.actor, id, c.req.valid("json")));
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-accounts/{bankAccountId}/imports",
      tags,
      summary: "Import history for a bank account",
      security: bearerSecurity,
      request: { params: BankParams },
      responses: {
        200: json(
          z.object({
            data: z.array(
              z.object({
                id: z.string(),
                source: z.string(),
                filename: z.string().nullable(),
                row_count: z.number().int(),
                imported_count: z.number().int(),
                duplicate_count: z.number().int(),
                error_count: z.number().int(),
                created_at: z.string(),
              }),
            ),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const rows = await c
        .get("org")
        .handle.db.select()
        .from(org.importBatches)
        .where(eq(org.importBatches.bankAccountId, c.req.valid("param").bankAccountId))
        .orderBy(desc(org.importBatches.createdAt))
        .limit(200)
        .all();
      return c.json(
        {
          data: rows.map((b) => ({
            id: b.id,
            source: b.source,
            filename: b.filename,
            row_count: b.rowCount,
            imported_count: b.importedCount,
            duplicate_count: b.duplicateCount,
            error_count: b.errorCount,
            created_at: b.createdAt,
          })),
        },
        200,
      );
    },
  );

  // ------------------------------------------------------------------ rules
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/rules",
      tags: ["Rules"],
      summary: "List bank rules in priority order",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(RuleSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await listRules(c.get("org").handle.db) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/rules",
      tags: ["Rules"],
      summary: "Create a rule (AI assistants' rules wait in the review queue, inactive)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(RuleInputSchema) },
      responses: {
        201: json(z.object({ rule: RuleSchema, review_item_id: z.string().nullable() }), "Created"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const out = await o.handle.write((tx) => createRuleTx(tx, o.id, o.actor, c.req.valid("json")));
      return c.json(out, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/rules/{ruleId}",
      tags: ["Rules"],
      summary: "Update a rule",
      security: bearerSecurity,
      request: { params: RuleParams, body: jsonBody(RuleInputSchema.partial()) },
      responses: { 200: json(RuleSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      if (o.actor.actor === "mcp" || o.actor.proposeOnly) {
        throw forbidden("AI assistants can propose new rules but not change existing ones.");
      }
      const id = c.req.valid("param").ruleId;
      return c.json(
        await o.handle.write((tx) => updateRuleTx(tx, o.id, o.actor, id, c.req.valid("json"))),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/rules/{ruleId}",
      tags: ["Rules"],
      summary: "Delete a rule",
      security: bearerSecurity,
      request: { params: RuleParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      if (o.actor.actor === "mcp" || o.actor.proposeOnly) {
        throw forbidden("AI assistants cannot delete rules.");
      }
      const id = c.req.valid("param").ruleId;
      await o.handle.write((tx) => deleteRuleTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ review queue
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/review",
      tags: ["Review queue"],
      summary: "List review items (default: pending, oldest first)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          status: z
            .string()
            .optional()
            .openapi({ description: "Comma-separated: pending, approved, rejected, expired" }),
          item_type: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: json(
          z.object({
            data: z.array(ReviewSchema),
            next_cursor: z.string().nullable(),
            pending_count: z.number().int(),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const db = c.get("org").handle.db;
      const status = (q.status ?? "pending").split(",").filter(Boolean) as (
        | "pending"
        | "approved"
        | "rejected"
        | "expired"
      )[];
      const itemType = q.item_type?.split(",").filter(Boolean) as never;
      const out = await listReview(db, { status, itemType, limit: q.limit, cursor: q.cursor });
      return c.json({ ...out, pending_count: await pendingCount(db) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/review/{reviewId}",
      tags: ["Review queue"],
      summary: "Get a review item",
      security: bearerSecurity,
      request: { params: ReviewParams },
      responses: { 200: json(ReviewSchema), ...errorResponses },
    }),
    async (c) =>
      c.json(reviewView(await mustGetReview(c.get("org").handle.db, c.req.valid("param").reviewId)), 200),
  );

  const ApproveBody = z.object({
    note: z.string().max(2000).nullable().optional(),
    lock_override_note: LockNote,
    edit: z
      .object({
        date: IsoDate.optional(),
        memo: z.string().max(1000).nullable().optional(),
        lines: z
          .array(
            z.object({
              account_id: Id,
              amount: Cents.refine((n) => n !== 0, "Line amount cannot be zero"),
              description: z.string().max(500).nullable().optional(),
              contact_id: Id.nullable().optional(),
            }),
          )
          .min(2)
          .max(500)
          .optional(),
      })
      .nullable()
      .optional()
      .openapi({ description: "Edit and approve. Both the original proposal and the change are kept." }),
  });
  const toEdit = (e: z.infer<typeof ApproveBody>["edit"]) =>
    e
      ? {
          date: e.date,
          memo: e.memo,
          lines: e.lines?.map((l) => ({
            accountId: l.account_id,
            amount: l.amount,
            description: l.description ?? null,
            contactId: l.contact_id ?? null,
          })),
        }
      : null;

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/review/{reviewId}/approve",
      tags: ["Review queue"],
      summary: "Approve (optionally edit and approve) a review item",
      description: "AI assistants (MCP) and propose-only tokens cannot approve.",
      security: bearerSecurity,
      request: { params: ReviewParams, body: jsonBody(ApproveBody) },
      responses: { 200: json(z.object({ item: ReviewSchema })), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").reviewId;
      const b = c.req.valid("json");
      const out = await o.handle.write((tx) =>
        approveReviewTx(tx, o.id, o.actor, id, {
          note: b.note,
          lock_override_note: b.lock_override_note,
          edit: toEdit(b.edit),
        }),
      );
      return c.json({ item: out.item }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/review/{reviewId}/reject",
      tags: ["Review queue"],
      summary: "Reject a review item with a note. Rejected entries never post.",
      security: bearerSecurity,
      request: {
        params: ReviewParams,
        body: jsonBody(z.object({ note: z.string().max(2000).nullable().optional() })),
      },
      responses: { 200: json(z.object({ item: ReviewSchema })), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").reviewId;
      const item = await o.handle.write((tx) =>
        rejectReviewTx(tx, o.id, o.actor, id, c.req.valid("json").note ?? null),
      );
      return c.json({ item }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/review/bulk-approve",
      tags: ["Review queue"],
      summary: "Approve several items. Each is approved independently; failures are reported per item.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({ ids: z.array(Id).min(1).max(200), note: z.string().max(2000).nullable().optional() }),
        ),
      },
      responses: {
        200: json(
          z.object({
            results: z.array(
              z.object({
                id: z.string(),
                ok: z.boolean(),
                error: z.object({ code: z.string(), message: z.string() }).nullable(),
              }),
            ),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      const b = c.req.valid("json");
      const results = [];
      for (const id of b.ids) {
        try {
          await o.handle.write((tx) => approveReviewTx(tx, o.id, o.actor, id, { note: b.note }));
          results.push({ id, ok: true, error: null });
        } catch (e) {
          const err = e instanceof ApiError ? e : fromDbError(e);
          if (!err) throw e;
          if (err.status === 403) throw err;
          results.push({ id, ok: false, error: { code: err.code, message: err.message } });
        }
      }
      return c.json({ results }, 200);
    },
  );

  // ------------------------------------------------------------------ review policies
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/review-policies",
      tags: ["Review queue"],
      summary: "List review policies (owner-defined; built-in defaults apply after them)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(PolicySchema) })), ...errorResponses },
    }),
    async (c) => {
      const rows = await c
        .get("org")
        .handle.db.select()
        .from(org.reviewPolicy)
        .orderBy(asc(org.reviewPolicy.priority))
        .all();
      return c.json({ data: rows.map(policyView) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/review-policies",
      tags: ["Review queue"],
      summary: "Create a review policy (owner)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(PolicyInputSchema) },
      responses: { 201: json(PolicySchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json");
      return c.json(await o.handle.write((tx) => savePolicyTx(tx, o.id, o.actor, b)), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/review-policies/{policyId}",
      tags: ["Review queue"],
      summary: "Replace a review policy (owner)",
      security: bearerSecurity,
      request: { params: PolicyParams, body: jsonBody(PolicyInputSchema) },
      responses: { 200: json(PolicySchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const id = c.req.valid("param").policyId;
      return c.json(
        await o.handle.write((tx) => savePolicyTx(tx, o.id, o.actor, { ...c.req.valid("json"), id })),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/review-policies/{policyId}",
      tags: ["Review queue"],
      summary: "Delete a review policy (owner)",
      security: bearerSecurity,
      request: { params: PolicyParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const id = c.req.valid("param").policyId;
      await o.handle.write((tx) => deletePolicyTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------ reconciliation
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reconciliations",
      tags: ["Reconciliation"],
      summary: "List reconciliations",
      security: bearerSecurity,
      request: { params: OrgParams, query: z.object({ account_id: Id.optional() }) },
      responses: { 200: json(z.object({ data: z.array(ReconSchema) })), ...errorResponses },
    }),
    async (c) =>
      c.json({ data: await listRecons(c.get("org").handle.db, c.req.valid("query").account_id) }, 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/reconciliations",
      tags: ["Reconciliation"],
      summary: "Start reconciling an account against a statement",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({ account_id: Id, statement_end_date: IsoDate, statement_ending_balance: Cents }),
        ),
      },
      responses: { 201: json(ReconSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      return c.json(await o.handle.write((tx) => startReconTx(tx, o.id, o.actor, c.req.valid("json"))), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reconciliations/{reconId}",
      tags: ["Reconciliation"],
      summary: "A reconciliation with its candidate and cleared lines (the reconciliation report)",
      security: bearerSecurity,
      request: { params: ReconParams },
      responses: {
        200: json(z.object({ reconciliation: ReconSchema, lines: z.array(ReconLineSchema) })),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await reconLines(c.get("org").handle.db, c.req.valid("param").reconId), 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/reconciliations/{reconId}/lines",
      tags: ["Reconciliation"],
      summary: "Mark lines cleared or uncleared",
      security: bearerSecurity,
      request: {
        params: ReconParams,
        body: jsonBody(z.object({ line_ids: z.array(Id).max(5000), cleared: z.boolean() })),
      },
      responses: { 200: json(ReconSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").reconId;
      const b = c.req.valid("json");
      return c.json(await o.handle.write((tx) => toggleLinesTx(tx, id, b.line_ids, b.cleared)), 200);
    },
  );

  for (const [action, summary] of [
    ["complete", "Complete (lock) a balanced reconciliation"],
    ["undo", "Undo the latest completed reconciliation (owner)"],
  ] as const) {
    r.openapi(
      createRoute({
        method: "post",
        path: `/orgs/{orgId}/reconciliations/{reconId}/${action}`,
        tags: ["Reconciliation"],
        summary,
        security: bearerSecurity,
        request: { params: ReconParams },
        responses: { 200: json(ReconSchema), ...errorResponses },
      }),
      async (c) => {
        const o = requireWriter(c);
        const id = c.req.valid("param").reconId;
        const fn = action === "complete" ? completeReconTx : undoReconTx;
        return c.json(await o.handle.write((tx) => fn(tx, o.id, o.actor, id)), 200);
      },
    );
  }

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/reconciliations/{reconId}",
      tags: ["Reconciliation"],
      summary: "Discard a reconciliation in progress",
      security: bearerSecurity,
      request: { params: ReconParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const id = c.req.valid("param").reconId;
      await o.handle.write((tx) => discardReconTx(tx, o.id, o.actor, id));
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/accounts/{accountId}/unreconciled",
      tags: ["Reconciliation"],
      summary: "Unreconciled posted lines of an account",
      security: bearerSecurity,
      request: {
        params: OrgParams.extend({ accountId: Id.openapi({ param: { name: "accountId", in: "path" } }) }),
        query: z.object({ as_of: IsoDate.optional() }),
      },
      responses: { 200: json(z.object({ data: z.array(ReconLineSchema) })), ...errorResponses },
    }),
    async (c) =>
      c.json(
        {
          data: await unreconciled(
            c.get("org").handle.db,
            c.req.valid("param").accountId,
            c.req.valid("query").as_of,
          ),
        },
        200,
      ),
  );

  return r;
}
