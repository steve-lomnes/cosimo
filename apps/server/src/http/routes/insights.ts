/** Dashboard (SPEC §9.2) and the year-end package (SPEC §9.1). */
import { createRoute } from "@hono/zod-openapi";
import { dashboard } from "../../services/dashboard.ts";
import { buildYearEndPackage } from "../../services/year-end.ts";
import { requireRole } from "../middleware.ts";
import { bearerSecurity, Cents, errorResponses, IsoDate, json, newRouter, OrgParams, z } from "../openapi.ts";
import { SyncStatusFields } from "./plaid.ts";

const DashboardAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  mask: z.string().nullable(),
  ledger_account_id: z.string(),
  balance: Cents.openapi({ description: "Normal sign: money in the account, or the amount owed on a card." }),
  unreviewed: z.number().int(),
  pending: z.number().int(),
  ...SyncStatusFields,
});

const PnlSummarySchema = z.object({
  from: IsoDate,
  to: IsoDate,
  income: Cents,
  expense: Cents.openapi({ description: "Expenses including cost of goods sold" }),
  net: Cents,
});

const CountTotal = z.object({ count: z.number().int(), total: Cents });

export const DashboardSchema = z
  .object({
    as_of: IsoDate,
    basis: z.enum(["cash", "accrual"]),
    currency: z.string(),
    cash: z.object({ total: Cents, accounts: z.array(DashboardAccountSchema) }),
    credit_cards: z.object({ total: Cents, accounts: z.array(DashboardAccountSchema) }),
    month: PnlSummarySchema,
    year_to_date: PnlSummarySchema,
    review_pending: z.number().int(),
    bank_needs_review: z.number().int(),
    bank_pending: CountTotal,
    stale_receipts: z.object({ count: z.number().int() }),
    receipts_to_book: z.object({ count: z.number().int() }),
    overdue_invoices: z.object({
      count: z.number().int(),
      total: Cents,
      top: z.array(
        z.object({
          id: z.string(),
          number: z.string(),
          customer_name: z.string(),
          due_date: IsoDate,
          days_overdue: z.number().int(),
          balance_due: Cents,
        }),
      ),
    }),
    bills: z.object({
      overdue: CountTotal,
      due_soon: CountTotal.extend({ days: z.number().int() }),
    }),
    bank_connections: z.array(
      z.object({
        id: z.string(),
        institution_name: z.string().nullable(),
        status: z.string(),
        error_code: z.string().nullable(),
        ...SyncStatusFields,
      }),
    ),
  })
  .openapi("Dashboard");

export function insightsRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/dashboard",
      tags: ["Reports"],
      summary: "Dashboard summary (viewer or higher)",
      description:
        "Cash across bank accounts (credit cards listed separately as liabilities), income and expense for the current month and fiscal year to date on the org's default basis, pending review items, bank transactions to categorize (not counting rows still pending at the bank or already waiting in the review queue, which are reported separately in bank_pending), receipts left in the inbox for more than 30 days (stale_receipts), inbox receipts with no bank account that wait to be booked (receipts_to_book), overdue invoices (top 5 by balance), bills overdue or due within 7 days, and bank connections that are not active. Amounts are integer cents.",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(DashboardSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireRole(c, "viewer");
      return c.json(await dashboard(o.handle.db, o.id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/year-end",
      tags: ["Reports"],
      summary: "Download the year-end package (accountant or higher)",
      description:
        "A ZIP named `<org>-<year>-year-end.zip` with PDF and CSV versions of the P&L, balance sheet, trial balance, general ledger, tax line summary, 1099 vendor summary, AR and AP aging, and reconciliation reports for the final month, plus README.txt, chain.json (ledger and audit chain heads), and anchors/ with public timestamps of those heads and the latest confirmed ones (see docs/chain-format.md). `year` is the fiscal year that ends in that calendar year; the 1099 summary covers calendar year `year`. Reports use the org's default basis. Generating a package records a chain checkpoint with reason `year_end` and, with anchoring on, timestamps the heads (best effort: a network failure doesn't stop the package).",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({ year: z.coerce.number().int().min(2000).max(2100).openapi({ example: 2026 }) }),
      },
      responses: {
        200: {
          content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
          description: "ZIP file",
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireRole(c, "accountant");
      const ctx = c.get("ctx");
      const reg = await ctx.orgs.get(o.id);
      const pkg = await buildYearEndPackage(o.handle, o.id, reg?.name ?? "", c.req.valid("query").year, {
        ctx,
      });
      return c.body(pkg.bytes as unknown as ArrayBuffer, 200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${pkg.filename}"`,
      });
    },
  );

  return r;
}
