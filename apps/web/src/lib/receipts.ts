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

const PAID_WITH_KEY = "cosimo.receipt.paidWith";

/** The bank account used for the last receipt. Storage can be blocked, so every access is guarded. */
export function readPaidWith(): string {
  try {
    return localStorage.getItem(PAID_WITH_KEY) ?? "";
  } catch {
    return "";
  }
}
export function writePaidWith(id: string) {
  try {
    if (id) localStorage.setItem(PAID_WITH_KEY, id);
    else localStorage.removeItem(PAID_WITH_KEY);
  } catch {}
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
