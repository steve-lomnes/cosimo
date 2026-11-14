import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Forecast = components["schemas"]["CashForecast"];
export type ForecastFlow = components["schemas"]["ForecastFlow"];
export type ForecastScenario = components["schemas"]["ForecastScenario"];
export type PlannedItem = components["schemas"]["PlannedItem"];
export type ForecastOverride = components["schemas"]["ForecastOverride"];
export type ForecastAttention = components["schemas"]["ForecastAttention"];
export type ForecastWindow = components["schemas"]["ForecastWindow"];
export type ForecastAssumptions = components["schemas"]["ForecastAssumptions"];

/** The page's `window` search value: `w13`, `m12`, a saved window's id, or `custom:week:8`. */
export function windowQuery(w: string | undefined): {
  window?: string;
  bucket?: "week" | "month";
  periods?: number;
} {
  const m = /^custom:(week|month):(\d+)$/.exec(w ?? "");
  if (m) return { bucket: m[1] as "week" | "month", periods: Number(m[2]) };
  return w ? { window: w } : {};
}

export function useForecast(orgId: string, scenario: string | undefined, window: string | undefined) {
  return useQuery({
    queryKey: ["forecast", orgId, "result", scenario ?? "", window ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/forecast", {
          params: { path: { orgId }, query: { scenario_id: scenario || undefined, ...windowQuery(window) } },
        }),
      ),
    enabled: Boolean(orgId),
  });
}

export function useScenarios(orgId: string) {
  return useQuery({
    queryKey: ["forecast", orgId, "scenarios"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/forecast/scenarios", { params: { path: { orgId } } })).then(
        (r) => r.data,
      ),
    enabled: Boolean(orgId),
  });
}

export function useWindows(orgId: string) {
  return useQuery({
    queryKey: ["forecast", orgId, "windows"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/forecast/windows", { params: { path: { orgId } } })).then(
        (r) => r.data,
      ),
    enabled: Boolean(orgId),
  });
}

/** A scenario's own planned items (the baseline's when `scenario` is empty). */
export function usePlannedItems(orgId: string, scenario: string | undefined) {
  return useQuery({
    queryKey: ["forecast", orgId, "items", scenario ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/forecast/items", {
          params: { path: { orgId }, query: { scenario_id: scenario || undefined } },
        }),
      ).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

export function useOverrides(orgId: string, scenario: string | undefined) {
  return useQuery({
    queryKey: ["forecast", orgId, "overrides", scenario ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/forecast/overrides", {
          params: { path: { orgId }, query: { scenario_id: scenario || undefined } },
        }),
      ).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

/** Refetch everything forecast-shaped, plus the review queue and dashboard that a draw touches. */
export function useInvalidateForecast(orgId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["forecast", orgId] }),
      qc.invalidateQueries({ queryKey: ["dashboard", orgId] }),
      qc.invalidateQueries({ queryKey: ["review", orgId] }),
    ]);
}

export const FIRMNESS_LABEL: Record<ForecastFlow["firmness"], string> = {
  booked: "Booked",
  scheduled: "Scheduled",
  pending: "Pending",
  planned: "Planned",
  draw: "Draw",
  reserve: "Reserve",
};

export const SOURCE_CHIP: Record<ForecastFlow["source"], string> = {
  invoice: "Invoice",
  bill: "Bill",
  recurring: "Recurring",
  pending: "Pending",
  planned: "Planned",
  draw: "Draw",
  reserve: "Reserve",
};
