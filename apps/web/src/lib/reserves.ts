import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Reserve = components["schemas"]["Reserve"];
export type ReservePart = components["schemas"]["ReservePart"];
export type ReserveDueDate = components["schemas"]["ReserveDueDate"];
export type ReserveView = components["schemas"]["ReserveView"];
export type ReservePayment = components["schemas"]["ReservePayment"];

export function useReserves(orgId: string) {
  return useQuery({
    queryKey: ["reserves", orgId, "list"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/reserves", { params: { path: { orgId } } })).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

/** Where a reserve stands for a tax year (the current one when `taxYear` is empty). */
export function useReserveView(orgId: string, id: string, taxYear?: number) {
  return useQuery({
    queryKey: ["reserves", orgId, "view", id, taxYear ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/reserves/{id}/view", {
          params: { path: { orgId, id }, query: taxYear ? { tax_year: taxYear } : {} },
        }),
      ),
    enabled: Boolean(orgId && id),
  });
}

export function useReservePayments(orgId: string, id: string, taxYear?: number) {
  return useQuery({
    queryKey: ["reserves", orgId, "payments", id, taxYear ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/reserves/{id}/payments", {
          params: { path: { orgId, id }, query: taxYear ? { tax_year: taxYear } : {} },
        }),
      ).then((r) => r.data),
    enabled: Boolean(orgId && id),
  });
}

/** Reserves feed the forecast, and true-ups and payments land in the review queue. */
export function useInvalidateReserves(orgId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["reserves", orgId] }),
      qc.invalidateQueries({ queryKey: ["forecast", orgId] }),
      qc.invalidateQueries({ queryKey: ["dashboard", orgId] }),
      qc.invalidateQueries({ queryKey: ["review", orgId] }),
    ]);
}

/** The web form's preset; the server knows nothing about US dates. */
export const US_QUARTERLY: ReserveDueDate[] = [
  { month: 4, day: 15, year_offset: 0 },
  { month: 6, day: 15, year_offset: 0 },
  { month: 9, day: 15, year_offset: 0 },
  { month: 1, day: 15, year_offset: 1 },
];

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Basis points as a percent: 2500 → "25", 1530 → "15.3". */
export const bpToPercent = (bp: number) => String(bp / 100);

/** A percent with up to 2 decimals, 0 to 100, as basis points; null when it isn't one. */
export function percentToBp(s: string): number | null {
  const t = s.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(Number(t) * 100);
  return bp <= 10_000 ? bp : null;
}

/** "Jan 15", with a two-digit year when it isn't this year: compact enough for a phone. */
export function shortDate(d: string, thisYear = new Date().getFullYear()) {
  const [y, m, day] = d.split("-").map(Number);
  const md = new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return y === thisYear ? md : `${md} ’${String(y).slice(-2)}`;
}

/** "Jan 15 (following year)" for a due date rule. */
export function dueDateText(d: ReserveDueDate) {
  return `${MONTHS[d.month - 1]!.slice(0, 3)} ${d.day}${d.year_offset ? " (following year)" : ""}`;
}
