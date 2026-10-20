import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Receipt = components["schemas"]["Receipt"];
export type ReceiptCandidate = components["schemas"]["ReceiptCandidate"];
export type ReceiptStatus = Receipt["status"];

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
