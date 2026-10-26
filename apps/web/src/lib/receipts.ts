import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Receipt = components["schemas"]["Receipt"];
export type ReceiptCandidate = components["schemas"]["ReceiptCandidate"];
export type ReceiptStatus = Receipt["status"];
export type ReceiptFile = components["schemas"]["ReceiptFile"];

/**
 * The account to credit by default when booking a receipt paid personally: the one active
 * liability named "Due to …" (what the business owes the owner). The server's rule
 * (`dueToAccountId`); null when there is none or more than one.
 */
export function dueToAccountId(accounts: { id: string; name: string; type: string; is_active: boolean }[]) {
  const due = accounts.filter(
    (a) => a.type === "liability" && a.is_active && a.name.toLowerCase().startsWith("due to"),
  );
  return due.length === 1 ? due[0]!.id : null;
}

/** The file picked on the "Snap receipt" button, waiting for the capture form to take it. */
let pendingFile: File | null = null;
export function setPendingReceiptFile(f: File | null) {
  pendingFile = f;
}
export function takePendingReceiptFile(): File | null {
  const f = pendingFile;
  pendingFile = null;
  return f;
}

/**
 * The bank account the most recent receipt was paid with, for the capture form's default. Taken from
 * the server rather than browser storage, so it follows the person across devices.
 */
export function useLastPaidWith(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["receipts", orgId, "last-paid-with"],
    enabled,
    queryFn: async () => {
      const r = await unwrap(
        api.GET("/api/v1/orgs/{orgId}/receipts", {
          params: { path: { orgId }, query: { status: "inbox,matched,booked,dismissed", limit: 20 } },
        }),
      );
      return r.data.find((x) => x.bank_account_id)?.bank_account_id ?? "";
    },
  });
}

export function useReceipt(orgId: string, id: string | null | undefined) {
  return useQuery({
    queryKey: ["receipts", orgId, "one", id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/receipts/{receiptId}", {
          params: { path: { orgId, receiptId: id as string } },
        }),
      ),
    enabled: Boolean(orgId && id),
  });
}

/** Refetch everything that shows receipts, or the transactions and dashboard counts they touch. */
export function useInvalidateReceipts() {
  const qc = useQueryClient();
  return async (orgId: string) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["receipts", orgId] }),
      qc.invalidateQueries({ queryKey: ["bank-txns", orgId] }),
      qc.invalidateQueries({ queryKey: ["dashboard", orgId] }),
    ]);
  };
}
