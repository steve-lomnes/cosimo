import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Account = components["schemas"]["Account"];
export type Entry = components["schemas"]["JournalEntry"];
export type SubmitResult = components["schemas"]["SubmitResult"];
export type Report = components["schemas"]["Report"];

export const TYPE_LABELS: Record<Account["type"], string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
export const TYPE_ORDER: Account["type"][] = ["asset", "liability", "equity", "income", "expense"];

export function useAccounts(orgId: string, opts: { balances?: boolean } = {}) {
  return useQuery({
    queryKey: ["accounts", orgId, Boolean(opts.balances)],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/accounts", {
          params: { path: { orgId }, query: opts.balances ? { include_balances: "true" } : {} },
        }),
      ).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

/** Balance with the account's normal sign (assets/expenses debit-positive, others credit-positive). */
export function displayBalance(a: Pick<Account, "type">, raw: number) {
  return a.type === "asset" || a.type === "expense" ? raw : -raw;
}

export const STATUS_TONE = {
  draft: "zinc",
  pending_review: "amber",
  posted: "green",
  rejected: "red",
} as const;

export const STATUS_LABEL = {
  draft: "Draft",
  pending_review: "Pending review",
  posted: "Posted",
  rejected: "Rejected",
} as const;

export const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  bank_transaction: "Bank",
  invoice: "Invoice",
  invoice_payment: "Payment received",
  payment_fee: "Payment fee",
  payment_refund: "Payment refund",
  payment_dispute: "Payment dispute",
  bill: "Bill",
  bill_payment: "Bill payment",
  transfer: "Transfer",
  opening_balance: "Opening balance",
  import: "Import",
  reversal: "Reversal",
  owner_draw: "Owner draw",
};

export const DOCUMENT_SOURCES = ["invoice", "invoice_payment", "bill", "bill_payment"];
