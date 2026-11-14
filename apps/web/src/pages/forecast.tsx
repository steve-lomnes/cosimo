import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorText,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Textarea,
  td,
  th,
} from "../components/ui";
import { useBankAccounts } from "../lib/banking";
import {
  FIRMNESS_LABEL,
  type Forecast,
  type ForecastAttention,
  type ForecastFlow,
  type ForecastScenario,
  type PlannedItem,
  SOURCE_CHIP,
  useForecast,
  useInvalidateForecast,
  useOverrides,
  usePlannedItems,
  useScenarios,
  useWindows,
} from "../lib/forecast";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import { ContactPicker } from "./invoices";
import { ForecastTabs } from "./reserves";

export const validateForecastSearch = (s: Record<string, unknown>) => ({
  scenario: typeof s.scenario === "string" && s.scenario ? s.scenario : undefined,
  window: typeof s.window === "string" && s.window ? s.window : undefined,
});

type Dialog =
  | null
  | { kind: "scenario"; mode: "new" | "rename" | "duplicate" }
  | { kind: "promote" }
  | { kind: "custom" }
  | { kind: "assumptions" }
  | { kind: "item"; item?: PlannedItem }
  | { kind: "draw" }
  | { kind: "shift"; flow: ForecastFlow };

const CUSTOM = "custom";

export function ForecastPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { scenario?: string; window?: string };
  const scenarios = useScenarios(orgId);
  const windows = useWindows(orgId);
  const baseline = scenarios.data?.find((s) => s.is_baseline);
  const current = scenarios.data?.find((s) => s.id === search.scenario) ?? baseline;
  // The baseline is addressed by leaving the scenario out.
  const scenarioId = current && !current.is_baseline ? current.id : undefined;
  const forecast = useForecast(orgId, scenarioId, search.window);
  const items = usePlannedItems(orgId, scenarioId);
  const baseItems = usePlannedItems(orgId, undefined);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const go = (next: { scenario?: string; window?: string }) =>
    navigate({
      to: "/o/$orgId/forecast",
      params: { orgId },
      search: { scenario: search.scenario, window: search.window, ...next } as never,
    });

  const allItems = useMemo(
    () => [...(scenarioId ? (baseItems.data ?? []) : []), ...(items.data ?? [])],
    [scenarioId, baseItems.data, items.data],
  );
  const f = forecast.data;
  const windowValue = search.window?.startsWith("custom:") ? CUSTOM : (search.window ?? "w13");

  return (
    <>
      <PageHeader
        title="Cash forecast"
        subtitle="What cash the business will have over the coming weeks, and how much you can draw. Built from open invoices and bills, recurring templates, and the plans you add."
        actions={
          canWrite && (
            <Button onClick={() => setDialog({ kind: "draw" })} disabled={!f}>
              Plan a draw
            </Button>
          )
        }
      />
      <ForecastTabs value="forecast" />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Scenario" className="min-w-48">
            {(id) => (
              <Select
                id={id}
                value={current?.id ?? ""}
                onChange={(e) => {
                  const s = scenarios.data?.find((x) => x.id === e.target.value);
                  go({ scenario: s && !s.is_baseline ? s.id : undefined });
                }}
              >
                {(scenarios.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.is_baseline ? "Baseline" : s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {canWrite && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDialog({ kind: "scenario", mode: "new" })}
              >
                New
              </Button>
              {scenarioId && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDialog({ kind: "scenario", mode: "duplicate" })}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDialog({ kind: "scenario", mode: "rename" })}
                  >
                    Rename
                  </Button>
                  <ArchiveScenario id={scenarioId} onDone={() => go({ scenario: undefined })} />
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "promote" })}>
                    Promote to baseline…
                  </Button>
                </>
              )}
              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "assumptions" })}>
                Assumptions…
              </Button>
            </div>
          )}
          <Field label="Window" className="ml-auto min-w-40">
            {(id) => (
              <Select
                id={id}
                value={windowValue}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) setDialog({ kind: "custom" });
                  else go({ window: e.target.value === "w13" ? undefined : e.target.value });
                }}
              >
                <option value="w13">13 weeks</option>
                <option value="m12">12 months</option>
                {(windows.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
                <option value={CUSTOM}>Custom…</option>
              </Select>
            )}
          </Field>
        </div>
        {current && !current.is_baseline && current.description && (
          <p className="mt-2 text-sm text-zinc-500">{current.description}</p>
        )}
      </Card>

      <ErrorText error={forecast.error ?? scenarios.error} />
      {forecast.isLoading || !f ? (
        forecast.error ? null : (
          <Loading />
        )
      ) : (
        <div className="space-y-4">
          <Figures f={f} />
          <Card title="Projected cash">
            <BalanceChart f={f} />
          </Card>
          <BucketTable
            f={f}
            canWrite={canWrite}
            scenarioId={scenarioId}
            onShift={(flow) => setDialog({ kind: "shift", flow })}
          />
          <AttentionPanel
            f={f}
            items={allItems}
            canWrite={canWrite}
            onEdit={(item) => setDialog({ kind: "item", item })}
          />
          <ItemsPanel
            items={allItems}
            currency={f.currency}
            scenarioId={scenarioId}
            canWrite={canWrite}
            onAdd={() => setDialog({ kind: "item" })}
            onEdit={(item) => setDialog({ kind: "item", item })}
          />
        </div>
      )}

      {dialog?.kind === "scenario" && (
        <ScenarioDialog
          mode={dialog.mode}
          current={current}
          onClose={close}
          onDone={(id) => {
            close();
            if (id) go({ scenario: id });
          }}
        />
      )}
      {dialog?.kind === "promote" && scenarioId && current && (
        <PromoteDialog scenario={current} onClose={close} onDone={() => go({ scenario: undefined })} />
      )}
      {dialog?.kind === "custom" && (
        <CustomWindowDialog
          onClose={close}
          onPick={(w) => {
            close();
            go({ window: w });
          }}
        />
      )}
      {dialog?.kind === "assumptions" && current && <AssumptionsDialog scenario={current} onClose={close} />}
      {dialog?.kind === "item" && <ItemDialog item={dialog.item} scenarioId={scenarioId} onClose={close} />}
      {dialog?.kind === "draw" && f && <DrawDialog f={f} scenarioId={scenarioId} onClose={close} />}
      {dialog?.kind === "shift" && <ShiftDialog flow={dialog.flow} scenarioId={scenarioId} onClose={close} />}
    </>
  );
}

// ----------------------------------------------------------------------------- figures and chart

function Figures({ f }: { f: Forecast }) {
  const cur = f.currency;
  const cap = f.draw_capacity;
  return (
    <section aria-label="Forecast figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Figure label="Opening cash" hint="Cash accounts today; cards aren't included">
        <Amount cents={f.opening_cash} currency={cur} />
      </Figure>
      <Figure label="Low point" hint={f.low_point.date === f.as_of ? "Today" : fmtDate(f.low_point.date)}>
        <Amount cents={f.low_point.balance} currency={cur} />
      </Figure>
      <Figure label="Cash buffer" hint="Kept on hand; set under Assumptions">
        <Amount cents={cap.breakdown.buffer} currency={cur} />
      </Figure>
      <Figure
        label="Safe to draw"
        hint={
          cap.breakdown.reserves_not_in_window > 0
            ? `Low point less the buffer and ${money(cap.breakdown.reserves_not_in_window, cur)} of reserves due later`
            : "Low point less the buffer"
        }
        strong
      >
        <span data-testid="safe-to-draw">
          <Amount cents={cap.amount} currency={cur} />
        </span>
      </Figure>
    </section>
  );
}

function Figure({
  label,
  hint,
  strong,
  children,
}: {
  label: string;
  hint: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-lg bg-white p-3 ring-1 dark:bg-zinc-900",
        strong ? "ring-brand-500 dark:ring-gold-400" : "ring-zinc-200 dark:ring-zinc-800",
      )}
    >
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{children}</p>
      <p className="text-xs text-zinc-500">{hint}</p>
    </div>
  );
}

/** "Nov 30 – Dec 6": a week without its year, so the period column fits on a phone. */
const shortWeekLabel = (b: { start: string; end: string }) => {
  const md = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return b.start === b.end ? md(b.start) : `${md(b.start)} – ${md(b.end)}`;
};

const bucketLabel = (b: { start: string; end: string }, kind: string) =>
  kind === "month"
    ? new Date(`${b.start}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : `${fmtDate(b.start)} – ${fmtDate(b.end)}`;

function BalanceChart({ f }: { f: Forecast }) {
  const W = 640;
  const H = 200;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const n = f.buckets.length;
  const buffer = f.draw_capacity.breakdown.buffer;
  const ys = [f.opening_cash, ...f.buckets.map((b) => b.ending), f.low_point.balance];
  const lo = Math.min(0, buffer, ...ys);
  const hi = Math.max(buffer, ...ys, lo + 1);
  const x = (frac: number) => pad.l + frac * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  // A step line through the balance at the end of each day that moves cash, so a dip inside a
  // period (and the low point) sits on the line rather than between period ends.
  const days = (a: string, c: string) => (Date.parse(c) - Date.parse(a)) / 86_400_000;
  const dayEndX = (bi: number, date: string) => {
    const b = f.buckets[bi]!;
    return x((bi + (days(b.start, date) + 1) / (days(b.start, b.end) + 1)) / n);
  };
  const points: (readonly [number, number])[] = [[x(0), y(f.opening_cash)]];
  let running = f.opening_cash;
  f.buckets.forEach((b, bi) => {
    const byDate = new Map<string, number>();
    for (const fl of b.flows) byDate.set(fl.date, (byDate.get(fl.date) ?? 0) + fl.amount);
    for (const [date, delta] of [...byDate].sort(([a], [c]) => a.localeCompare(c))) {
      if (delta === 0) continue;
      const px = dayEndX(bi, date);
      points.push([px, y(running)], [px, y(running + delta)]);
      running += delta;
    }
  });
  points.push([x(1), y(running)]);
  // The low point is the opening balance when nothing takes cash below it.
  const bi = f.buckets.findIndex((b) => f.low_point.date >= b.start && f.low_point.date <= b.end);
  const atOpening = f.low_point.date === f.as_of && f.low_point.balance === f.opening_cash;
  const lowX = atOpening || bi < 0 ? x(0) : dayEndX(bi, f.low_point.date);
  const first = f.buckets[0]!;
  const last = f.buckets[n - 1]!;
  const label = `Projected cash balance from ${fmtDate(first.start)} to ${fmtDate(last.end)}: starts at ${money(f.opening_cash, f.currency)}, lowest ${money(f.low_point.balance, f.currency)} on ${fmtDate(f.low_point.date)}, ends at ${money(last.ending, f.currency)}. The table below has the same figures.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      {lo < 0 && (
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={y(0)}
          y2={y(0)}
          className="stroke-zinc-400 dark:stroke-zinc-600"
          strokeWidth={1}
        />
      )}
      {buffer > 0 && (
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={y(buffer)}
          y2={y(buffer)}
          className="stroke-amber-600 dark:stroke-amber-400"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
      )}
      <polyline
        points={points.map(([px, py]) => `${px},${py}`).join(" ")}
        fill="none"
        className="stroke-brand-600 dark:stroke-gold-400"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <circle cx={lowX} cy={y(f.low_point.balance)} r={5} className="fill-red-600 dark:fill-red-400" />
      <text x={W - pad.r} y={H - 6} textAnchor="end" className="fill-zinc-500 text-[10px]">
        {fmtDate(last.end)}
      </text>
      <text x={pad.l} y={H - 6} className="fill-zinc-500 text-[10px]">
        {fmtDate(first.start)}
      </text>
      {buffer > 0 && (
        <text x={pad.l} y={y(buffer) - 4} className="fill-amber-700 text-[10px] dark:fill-amber-400">
          Buffer {money(buffer, f.currency)}
        </text>
      )}
    </svg>
  );
}

// ----------------------------------------------------------------------------- table

const CHIP_TONE: Record<ForecastFlow["source"], "blue" | "amber" | "zinc" | "green" | "red"> = {
  invoice: "blue",
  bill: "amber",
  recurring: "zinc",
  pending: "amber",
  planned: "green",
  draw: "red",
  reserve: "red",
};

function SourceChip({ flow, orgId }: { flow: ForecastFlow; orgId: string }) {
  const chip = <Badge tone={CHIP_TONE[flow.source]}>{SOURCE_CHIP[flow.source]}</Badge>;
  if (flow.source === "invoice" && flow.ref)
    return (
      <Link to="/o/$orgId/sales/invoices/$invoiceId" params={{ orgId, invoiceId: flow.ref }}>
        {chip}
      </Link>
    );
  if (flow.source === "bill" && flow.ref)
    return (
      <Link to="/o/$orgId/expenses/bills/$billId" params={{ orgId, billId: flow.ref }}>
        {chip}
      </Link>
    );
  if (flow.source === "pending")
    return (
      <Link to="/o/$orgId/accounting/review" params={{ orgId }}>
        {chip}
      </Link>
    );
  if (flow.source === "reserve")
    return (
      <Link to="/o/$orgId/forecast/reserves" params={{ orgId }}>
        {chip}
      </Link>
    );
  return chip;
}

function BucketTable({
  f,
  canWrite,
  scenarioId,
  onShift,
}: {
  f: Forecast;
  canWrite: boolean;
  scenarioId: string | undefined;
  onShift: (flow: ForecastFlow) => void;
}) {
  const orgId = useOrgId();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const invalidate = useInvalidateForecast(orgId);
  const exclude = useMutation({
    mutationFn: (flow: ForecastFlow) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/overrides", {
          params: { path: { orgId } },
          body: {
            scenario_id: scenarioId ?? null,
            target_type: flow.target!.type as "invoice",
            target_id: flow.target!.id,
            target_date: flow.target!.date ?? null,
            action: "exclude",
          },
        }),
      ),
    onSuccess: invalidate,
  });
  const cur = f.currency;
  return (
    <Card title="By period">
      <ErrorText error={exclude.error} />
      <Table>
        <thead>
          <tr>
            <th className={th}>Period</th>
            <th className={cx(th, "text-right")}>In</th>
            <th className={cx(th, "text-right")}>Out</th>
            <th className={cx(th, "text-right")}>Net</th>
            <th className={cx(th, "text-right")}>Ending balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {f.buckets.map((b, i) => (
            <Fragment key={b.start}>
              <tr>
                <td className={td}>
                  <button
                    type="button"
                    aria-expanded={open.has(i)}
                    aria-label={`${bucketLabel(b, f.window.bucket)}, ${b.flows.length} items`}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (!next.delete(i)) next.add(i);
                        return next;
                      })
                    }
                    className="flex items-center gap-1.5 whitespace-nowrap text-left"
                  >
                    <span aria-hidden className="w-3 text-zinc-400">
                      {open.has(i) ? "▾" : "▸"}
                    </span>
                    {f.window.bucket === "week" ? (
                      <>
                        <span className="sm:hidden">{shortWeekLabel(b)}</span>
                        <span className="hidden sm:inline">{bucketLabel(b, f.window.bucket)}</span>
                      </>
                    ) : (
                      bucketLabel(b, f.window.bucket)
                    )}
                    {b.flows.length > 0 && <span className="text-xs text-zinc-500">({b.flows.length})</span>}
                  </button>
                </td>
                <td className={cx(td, "text-right")}>
                  <Amount cents={b.inflow} currency={cur} />
                </td>
                <td className={cx(td, "text-right")}>
                  <Amount cents={b.outflow} currency={cur} className="text-zinc-700 dark:text-zinc-300" />
                </td>
                <td className={cx(td, "text-right")}>
                  <Amount cents={b.net} currency={cur} />
                </td>
                <td className={cx(td, "text-right font-medium")}>
                  <Amount cents={b.ending} currency={cur} />
                </td>
              </tr>
              {open.has(i) &&
                b.flows.map((flow) => (
                  <tr key={flow.id} className="bg-zinc-50/60 dark:bg-zinc-800/30">
                    <td className={cx(td, "pl-9")} colSpan={2}>
                      <div className="flex flex-wrap items-center gap-2">
                        <SourceChip flow={flow} orgId={orgId} />
                        <span>{flow.label}</span>
                        <span className="text-xs text-zinc-500">
                          {fmtDate(flow.date)} · {FIRMNESS_LABEL[flow.firmness]}
                        </span>
                      </div>
                    </td>
                    <td className={cx(td, "text-right")} colSpan={2}>
                      <Amount cents={flow.amount} currency={cur} />
                    </td>
                    <td className={cx(td, "text-right")}>
                      {canWrite && flow.target && (
                        <span className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Exclude ${flow.label} in this scenario`}
                            onClick={() => exclude.mutate(flow)}
                          >
                            Exclude
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Shift ${flow.label}`}
                            onClick={() => onShift(flow)}
                          >
                            Shift…
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ----------------------------------------------------------------------------- needs attention

function AttentionPanel({
  f,
  items,
  canWrite,
  onEdit,
}: {
  f: Forecast;
  items: PlannedItem[];
  canWrite: boolean;
  onEdit: (item: PlannedItem) => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const link = useMutation({
    mutationFn: (a: {
      itemId: string;
      date: string;
      status: "linked" | "rejected" | "skipped";
      type?: "invoice" | "bill" | "bank_transaction";
      target?: string;
    }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/items/{id}/links", {
          params: { path: { orgId, id: a.itemId } },
          body: {
            occurrence_date: a.date,
            status: a.status,
            target_type: a.type ?? null,
            target_id: a.target ?? null,
          },
        }),
      ),
    onSuccess: invalidate,
  });
  const confirm = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/items/{id}/confirm", { params: { path: { orgId, id } } }),
      ),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/forecast/items/{id}", { params: { path: { orgId, id } } })),
    onSuccess: invalidate,
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const error = link.error ?? confirm.error ?? archive.error;

  const actions = (a: ForecastAttention) => {
    const item = a.item_id ? byId.get(a.item_id) : undefined;
    if (!canWrite || !a.item_id) return null;
    const edit = item && (
      <Button size="sm" variant="ghost" onClick={() => onEdit(item)}>
        Edit
      </Button>
    );
    const archiveBtn = (
      <Button size="sm" variant="ghost" onClick={() => archive.mutate(a.item_id!)}>
        Archive
      </Button>
    );
    switch (a.kind) {
      case "suggested_match":
        return (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                link.mutate({
                  itemId: a.item_id!,
                  date: a.occurrence_date!,
                  status: "linked",
                  type: a.target_type,
                  target: a.target_id,
                })
              }
            >
              Link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                link.mutate({
                  itemId: a.item_id!,
                  date: a.occurrence_date!,
                  status: "rejected",
                  type: a.target_type,
                  target: a.target_id,
                })
              }
            >
              Not this
            </Button>
          </>
        );
      case "planned_past_due":
        return (
          <>
            {a.occurrence_date && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  link.mutate({ itemId: a.item_id!, date: a.occurrence_date!, status: "skipped" })
                }
              >
                Didn't happen
              </Button>
            )}
            {edit}
            {archiveBtn}
          </>
        );
      case "planned_unconfirmed":
        return (
          <>
            <Button size="sm" variant="secondary" onClick={() => confirm.mutate(a.item_id!)}>
              Confirm
            </Button>
            {edit}
            {archiveBtn}
          </>
        );
      case "template_overlap":
        return archiveBtn;
      default:
        return null;
    }
  };

  return (
    <Card title={`Needs attention${f.attention.length ? ` (${f.attention.length})` : ""}`}>
      <ErrorText error={error} />
      {f.attention.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing to check. The forecast has no stale or conflicting information.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {f.attention.map((a, i) => (
            <li key={`${a.kind}-${a.ref}-${i}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Badge tone={a.kind === "invoice_overdue" || a.kind === "bank_feed_stale" ? "red" : "amber"}>
                {ATTENTION_LABEL[a.kind]}
              </Badge>
              <span className="min-w-0 flex-1">{a.message}</span>
              <span className="flex gap-1">{actions(a)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const ATTENTION_LABEL: Record<ForecastAttention["kind"], string> = {
  planned_past_due: "Past due",
  planned_unconfirmed: "Unconfirmed",
  invoice_overdue: "Overdue invoice",
  bank_feed_stale: "Bank feed",
  card_balance: "Card balance",
  suggested_match: "Possible match",
  template_overlap: "Possible duplicate",
};

// ----------------------------------------------------------------------------- planned items

function ItemsPanel({
  items,
  currency,
  scenarioId,
  canWrite,
  onAdd,
  onEdit,
}: {
  items: PlannedItem[];
  currency: string;
  scenarioId: string | undefined;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (item: PlannedItem) => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const confirm = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/items/{id}/confirm", { params: { path: { orgId, id } } }),
      ),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/forecast/items/{id}", { params: { path: { orgId, id } } })),
    onSuccess: invalidate,
  });
  return (
    <Card
      title="Planned items"
      actions={
        canWrite && (
          <Button size="sm" onClick={onAdd}>
            Add planned item
          </Button>
        )
      }
    >
      <ErrorText error={confirm.error ?? archive.error} />
      {items.length === 0 ? (
        <Empty title="No planned items.">
          Add money you expect or plan to spend that isn't in the books yet, such as a tax payment or a
          one-off purchase.
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Item</th>
              <th className={th}>When</th>
              <th className={cx(th, "text-right")}>Amount</th>
              <th className={cx(th, "hidden sm:table-cell")}>Confirmed</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((it) => (
              <tr key={it.id}>
                <td className={td}>
                  <span className="font-medium">{it.name}</span>
                  {it.kind === "draw" && (
                    <span className="ml-2">
                      <Badge tone="red">Draw</Badge>
                    </span>
                  )}
                  {scenarioId && it.scenario_id !== scenarioId && (
                    <span className="ml-2">
                      <Badge>Baseline</Badge>
                    </span>
                  )}
                  {it.source === "assistant" && (
                    <span className="ml-2">
                      <Badge tone="blue">Assistant</Badge>
                    </span>
                  )}
                </td>
                <td className={cx(td, "min-w-36")}>
                  {it.schedule_text}
                  {it.next_date && <div className="text-xs text-zinc-500">Next {fmtDate(it.next_date)}</div>}
                </td>
                <td className={cx(td, "text-right")}>
                  <Amount cents={it.direction === "in" ? it.amount : -it.amount} currency={currency} />
                </td>
                <td className={cx(td, "hidden sm:table-cell")}>
                  {it.last_confirmed_at ? fmtDate(it.last_confirmed_at) : "Never"}
                </td>
                <td className={cx(td, "text-right")}>
                  {canWrite && (
                    <span className="inline-flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(it)}
                        aria-label={`Edit ${it.name}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => confirm.mutate(it.id)}
                        aria-label={`Confirm ${it.name}`}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => archive.mutate(it.id)}
                        aria-label={`Archive ${it.name}`}
                      >
                        Archive
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------- dialogs

function ArchiveScenario({ id, onDone }: { id: string; onDone: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const m = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/forecast/scenarios/{id}", { params: { path: { orgId, id } } })),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={m.isPending}
      onClick={() => {
        if (window.confirm("Archive this scenario? Its planned items stop counting.")) m.mutate();
      }}
    >
      Archive
    </Button>
  );
}

function ScenarioDialog({
  mode,
  current,
  onClose,
  onDone,
}: {
  mode: "new" | "rename" | "duplicate";
  current: ForecastScenario | undefined;
  onClose: () => void;
  onDone: (id?: string) => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const [name, setName] = useState(mode === "rename" ? (current?.name ?? "") : "");
  const [description, setDescription] = useState(mode === "new" ? "" : (current?.description ?? ""));
  const save = useMutation({
    mutationFn: async () => {
      const path = { orgId };
      if (mode === "new")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/forecast/scenarios", {
            params: { path },
            body: { name, description: description || null },
          }),
        );
      const id = current!.id;
      if (mode === "rename")
        return unwrap(
          api.PATCH("/api/v1/orgs/{orgId}/forecast/scenarios/{id}", {
            params: { path: { orgId, id } },
            body: { name, description: description || null },
          }),
        );
      return unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/scenarios/{id}/duplicate", {
          params: { path: { orgId, id } },
          body: { name: name || undefined },
        }),
      );
    },
    onSuccess: async (s) => {
      await invalidate();
      onDone(s.id);
    },
  });
  const title = { new: "New scenario", rename: "Rename scenario", duplicate: "Duplicate scenario" }[mode];
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={mode !== "duplicate" && !name.trim()}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "duplicate" || name.trim()) save.mutate();
        }}
      >
        <ErrorText error={save.error} />
        <Field label="Name" hint={mode === "duplicate" ? "Leave empty for “Copy of …”." : undefined}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        {mode !== "duplicate" && (
          <Field label="Description" hint="Optional">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
        )}
        <p className="text-xs text-zinc-500">
          A scenario holds only its changes on top of the baseline: its own planned items, items it excludes
          or shifts, and assumptions it changes.
        </p>
      </form>
    </Modal>
  );
}

function PromoteDialog({
  scenario,
  onClose,
  onDone,
}: {
  scenario: ForecastScenario;
  onClose: () => void;
  onDone: () => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const items = usePlannedItems(orgId, scenario.id);
  const overrides = useOverrides(orgId, scenario.id);
  const [itemIds, setItemIds] = useState<Set<string>>(new Set());
  const [overrideIds, setOverrideIds] = useState<Set<string>>(new Set());
  const [assumptions, setAssumptions] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const assumed = Object.entries(scenario.assumptions);
  // Start with everything selected; the person unticks what stays in the scenario.
  useEffect(() => {
    if (seeded || !items.data || !overrides.data) return;
    setItemIds(new Set(items.data.map((i) => i.id)));
    setOverrideIds(new Set(overrides.data.map((o) => o.id)));
    setAssumptions(assumed.length > 0);
    setSeeded(true);
  }, [seeded, items.data, overrides.data, assumed.length]);
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    fn(next);
  };
  const promote = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/scenarios/{id}/promote", {
          params: { path: { orgId, id: scenario.id } },
          body: { item_ids: [...itemIds], override_ids: [...overrideIds], assumptions },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const nothing = itemIds.size + overrideIds.size === 0 && !assumptions;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Promote “${scenario.name}” to the baseline`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={promote.isPending} disabled={nothing} onClick={() => promote.mutate()}>
            Promote selected
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <ErrorText error={promote.error} />
        <p className="text-zinc-500">
          Selected items, overrides, and assumptions move into the baseline, so every scenario sees them.
        </p>
        {!items.data || !overrides.data ? (
          <Loading />
        ) : (
          <>
            <fieldset>
              <legend className="mb-1 font-medium">Planned items</legend>
              {items.data.length === 0 && <p className="text-zinc-500">None.</p>}
              {items.data.map((i) => (
                <label key={i.id} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={itemIds.has(i.id)}
                    onChange={() => toggle(itemIds, i.id, setItemIds)}
                  />
                  {i.name} · {i.schedule_text} · {money(i.amount)}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="mb-1 font-medium">Overrides</legend>
              {overrides.data.length === 0 && <p className="text-zinc-500">None.</p>}
              {overrides.data.map((o) => (
                <label key={o.id} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={overrideIds.has(o.id)}
                    onChange={() => toggle(overrideIds, o.id, setOverrideIds)}
                  />
                  {o.action === "exclude" ? "Exclude" : `Shift ${o.shift_days} days:`}{" "}
                  {o.target_type.replace("_", " ")} {o.target_id.slice(-6)}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="mb-1 font-medium">Assumptions</legend>
              {assumed.length === 0 ? (
                <p className="text-zinc-500">This scenario doesn't change any.</p>
              ) : (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={assumptions}
                    onChange={(e) => setAssumptions(e.target.checked)}
                  />
                  {assumed.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ")}
                </label>
              )}
            </fieldset>
          </>
        )}
      </div>
    </Modal>
  );
}

function CustomWindowDialog({ onClose, onPick }: { onClose: () => void; onPick: (window: string) => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [periods, setPeriods] = useState("8");
  const [name, setName] = useState("");
  const n = Number(periods);
  const valid = Number.isInteger(n) && n >= 1 && n <= 104;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/windows", {
          params: { path: { orgId } },
          body: { name, bucket, periods: n },
        }),
      ),
    onSuccess: async (w) => {
      await invalidate();
      onPick(w.id);
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Custom window"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onPick(`custom:${bucket}:${n}`)}>
            Show
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorText error={save.error} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Buckets">
            {(id) => (
              <Select id={id} value={bucket} onChange={(e) => setBucket(e.target.value as "week" | "month")}>
                <option value="week">Weeks (Monday to Sunday)</option>
                <option value="month">Calendar months</option>
              </Select>
            )}
          </Field>
          <Field label="How many" hint="1 to 104" error={valid ? null : "Enter 1 to 104."}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={104}
                value={periods}
                onChange={(e) => setPeriods(e.target.value)}
              />
            )}
          </Field>
        </div>
        <p className="text-xs text-zinc-500">The first bucket starts today.</p>
        <div className="flex items-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <Field label="Save as" className="flex-1">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Next 6 months"
              />
            )}
          </Field>
          <Button
            variant="secondary"
            loading={save.isPending}
            disabled={!valid || !name.trim()}
            onClick={() => save.mutate()}
          >
            Save as…
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AssumptionsDialog({ scenario, onClose }: { scenario: ForecastScenario; onClose: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const a = scenario.assumptions;
  const [lag, setLag] = useState(a.collection_lag_days?.toString() ?? "");
  const [share, setShare] = useState(a.late_share_pct?.toString() ?? "");
  const [lateDays, setLateDays] = useState(a.late_days?.toString() ?? "");
  const [buffer, setBuffer] = useState(a.min_cash_buffer != null ? centsToDecimal(a.min_cash_buffer) : "");
  const int = (s: string) => (s.trim() === "" ? null : Number(s));
  const bufferCents = buffer.trim() === "" ? null : tryParseCents(buffer);
  const bad =
    [lag, share, lateDays].some((s) => s.trim() !== "" && !Number.isInteger(Number(s))) ||
    (buffer.trim() !== "" && bufferCents == null);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/forecast/scenarios/{id}", {
          params: { path: { orgId, id: scenario.id } },
          body: {
            assumptions: {
              collection_lag_days: int(lag),
              late_share_pct: int(share),
              late_days: int(lateDays),
              min_cash_buffer: bufferCents,
            },
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const blank = scenario.is_baseline ? "Default" : "Same as the baseline";
  return (
    <Modal
      open
      onClose={onClose}
      title={scenario.is_baseline ? "Baseline assumptions" : `Assumptions for “${scenario.name}”`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={bad} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorText error={save.error} />
        <p className="text-sm text-zinc-500">Leave a field empty to use: {blank.toLowerCase()}.</p>
        <Field label="Customers pay this many days after the due date" hint="Default 0">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={lag}
              onChange={(e) => setLag(e.target.value)}
              placeholder={blank}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Percent of each invoice that pays late" hint="Default 0">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={share}
                onChange={(e) => setShare(e.target.value)}
                placeholder={blank}
              />
            )}
          </Field>
          <Field label="…this many days later still" hint="Default 30">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={lateDays}
                onChange={(e) => setLateDays(e.target.value)}
                placeholder={blank}
              />
            )}
          </Field>
        </div>
        <Field label="Cash buffer to keep on hand" hint="Safe to draw is the low point less this. Default 0.">
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              placeholder={blank}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function ItemDialog({
  item,
  scenarioId,
  onClose,
}: {
  item?: PlannedItem;
  scenarioId: string | undefined;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const accounts = useAccounts(orgId);
  const banks = useBankAccounts(orgId);
  const [name, setName] = useState(item?.name ?? "");
  const [direction, setDirection] = useState<"in" | "out">(item?.direction ?? "out");
  const [draw, setDraw] = useState(item?.kind === "draw");
  const [amount, setAmount] = useState(item ? centsToDecimal(item.amount) : "");
  const [date, setDate] = useState(item?.start_date ?? todayIso());
  const [repeat, setRepeat] = useState(Boolean(item?.unit));
  const [unit, setUnit] = useState<"day" | "week" | "month" | "year">(item?.unit ?? "month");
  const [interval, setInterval] = useState(String(item?.interval ?? 1));
  const [endDate, setEndDate] = useState(item?.end_date ?? "");
  const [maxOcc, setMaxOcc] = useState(item?.max_occurrences?.toString() ?? "");
  const [accountId, setAccountId] = useState(item?.account_id ?? "");
  const [contactId, setContactId] = useState(item?.contact_id ?? "");
  const [bankId, setBankId] = useState(item?.bank_account_id ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const cents = tryParseCents(amount);
  const valid = name.trim() !== "" && cents != null && cents > 0 && date !== "";
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        kind: draw ? ("draw" as const) : ("planned" as const),
        name: name.trim(),
        direction: draw ? ("out" as const) : direction,
        amount: cents!,
        start_date: date,
        unit: repeat ? unit : null,
        interval: repeat ? Math.max(1, Number(interval) || 1) : 1,
        end_date: repeat && endDate ? endDate : null,
        max_occurrences: repeat && maxOcc ? Number(maxOcc) : null,
        account_id: accountId || null,
        contact_id: contactId || null,
        bank_account_id: bankId || null,
        notes: notes.trim() || null,
      };
      return item
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/forecast/items/{id}", {
              params: { path: { orgId, id: item.id } },
              body: fields,
            }),
          )
        : unwrap(
            api.POST("/api/v1/orgs/{orgId}/forecast/items", {
              params: { path: { orgId } },
              body: { ...fields, scenario_id: scenarioId ?? null },
            }),
          );
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={item ? "Edit planned item" : "Add planned item"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {item ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <ErrorText error={save.error} />
        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Money">
            {(id) => (
              <Select
                id={id}
                value={draw ? "out" : direction}
                disabled={draw}
                onChange={(e) => setDirection(e.target.value as "in" | "out")}
              >
                <option value="out">Out</option>
                <option value="in">In</option>
              </Select>
            )}
          </Field>
          <Field label="Amount" error={amount && cents == null ? "Enter an amount." : null}>
            {(id) => (
              <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            )}
          </Field>
          <Field label={repeat ? "Starting" : "Date"}>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draw} onChange={(e) => setDraw(e.target.checked)} />
          This is an owner draw
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          Repeat
        </label>
        {repeat && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Every">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                />
              )}
            </Field>
            <Field label="Unit">
              {(id) => (
                <Select id={id} value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
                  <option value="day">Days</option>
                  <option value="week">Weeks</option>
                  <option value="month">Months</option>
                  <option value="year">Years</option>
                </Select>
              )}
            </Field>
            <Field label="Until">
              {(id) => (
                <Input id={id} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              )}
            </Field>
            <Field label="Or this many times">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={maxOcc}
                  onChange={(e) => setMaxOcc(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        <Field label="Account" hint="Optional: where it would be booked">
          {(id) => (
            <AccountSelect
              id={id}
              accounts={accounts.data ?? []}
              value={accountId}
              onChange={setAccountId}
              placeholder="No account"
              types={direction === "in" && !draw ? ["income", "asset", "liability", "equity"] : undefined}
            />
          )}
        </Field>
        {!draw && (
          <div>
            <p className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {direction === "in" ? "Customer" : "Vendor"} (optional)
            </p>
            <ContactPicker
              key={direction}
              kind={direction === "in" ? "customer" : "vendor"}
              value={contactId}
              onChange={setContactId}
            />
          </div>
        )}
        <Field label="Bank account" hint="Optional. Naming a card keeps its balance note out of the way.">
          {(id) => (
            <Select id={id} value={bankId} onChange={(e) => setBankId(e.target.value)}>
              <option value="">None</option>
              {(banks.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

function ShiftDialog({
  flow,
  scenarioId,
  onClose,
}: {
  flow: ForecastFlow;
  scenarioId: string | undefined;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const [days, setDays] = useState("7");
  const n = Number(days);
  const valid = Number.isInteger(n) && n !== 0 && Math.abs(n) <= 366;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/overrides", {
          params: { path: { orgId } },
          body: {
            scenario_id: scenarioId ?? null,
            target_type: flow.target!.type as "invoice",
            target_id: flow.target!.id,
            target_date: flow.target!.date ?? null,
            action: "shift",
            shift_days: n,
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Shift"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            Shift
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorText error={save.error} />
        <p className="text-sm">
          {flow.label} · {fmtDate(flow.date)}
        </p>
        <Field
          label="Move by this many days"
          hint="Positive is later, negative is earlier."
          error={valid ? null : "Enter a whole number, not 0."}
        >
          {(id) => (
            <Input id={id} type="number" value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
          )}
        </Field>
        <p className="text-xs text-zinc-500">
          Applies only in this scenario (or the baseline, when it is selected).
        </p>
      </div>
    </Modal>
  );
}

function DrawDialog({
  f,
  scenarioId,
  onClose,
}: {
  f: Forecast;
  scenarioId: string | undefined;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const banks = useBankAccounts(orgId);
  const cash = (banks.data ?? []).filter((b) => b.is_active && b.kind !== "credit_card");
  const [bankId, setBankId] = useState("");
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState(centsToDecimal(f.draw_capacity.amount));
  const [memo, setMemo] = useState("");
  const bank = bankId || cash[0]?.id || "";
  const cents = tryParseCents(amount);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/draws", {
          params: { path: { orgId } },
          body: {
            date,
            amount: cents!,
            bank_account_id: bank,
            memo: memo.trim() || null,
            scenario_id: scenarioId ?? null,
          },
        }),
      ),
    onSuccess: invalidate,
  });
  const done = save.data;
  const over = cents != null && cents > f.draw_capacity.amount;
  return (
    <Modal
      open
      onClose={onClose}
      title="Plan a draw"
      footer={
        done ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={save.isPending}
              disabled={!cents || cents <= 0 || !bank}
              onClick={() => save.mutate()}
            >
              Propose draw
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <ErrorText error={save.error} />
        {done ? (
          <div className="space-y-2 text-sm">
            <Alert kind={done.forecast_snapshot.exceeds_capacity ? "warn" : "success"}>
              {done.review
                ? "Proposed. It waits in the review queue until someone approves it."
                : "Recorded: a review policy approved it."}
              {done.exceeds_capacity &&
                ` It is more than the ${money(done.forecast_snapshot.draw_capacity.amount, f.currency)} the forecast says is safe to draw.`}
            </Alert>
            {done.review && (
              <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
                Open the review queue
              </Link>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-zinc-500">
              Safe to draw now: <strong>{money(f.draw_capacity.amount, f.currency)}</strong>. A draw over that
              is still proposed; the reviewer sees the forecast.
            </p>
            <Field label="From bank account">
              {(id) => (
                <Select id={id} value={bank} onChange={(e) => setBankId(e.target.value)}>
                  {cash.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">
                {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
              <Field label="Amount" error={amount && cents == null ? "Enter an amount." : null}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {over && <Alert kind="warn">That is more than the forecast says is safe to draw.</Alert>}
            <Field label="Memo" hint="Optional">
              {(id) => (
                <Input
                  id={id}
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Owner draw"
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
