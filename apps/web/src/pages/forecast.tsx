import { DEFAULT_ASSUMPTIONS } from "@cosimo/core";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
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
  dueNote,
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
import { balanceSteps, compactMoney, dateTicks, daysBetween, niceTicks } from "../lib/forecast-chart";
import { flowMatches, parseQuery } from "../lib/forecast-search";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import { useInvalidateReserves, useReserves, useReserveViews } from "../lib/reserves";
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
  | { kind: "draw" };

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
          <TransactionList
            f={f}
            items={allItems}
            canWrite={canWrite}
            scenarioId={scenarioId}
            onEditItem={(item) => setDialog({ kind: "item", item })}
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
      {dialog?.kind === "assumptions" && current && (
        <AssumptionsDialog
          scenario={current}
          baseline={baseline}
          currency={forecast.data?.currency ?? "USD"}
          onClose={close}
        />
      )}
      {dialog?.kind === "item" && <ItemDialog item={dialog.item} scenarioId={scenarioId} onClose={close} />}
      {dialog?.kind === "draw" && f && <DrawDialog f={f} scenarioId={scenarioId} onClose={close} />}
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

/** Width of the element, tracked so the chart draws at real pixels (text stays legible on phones). */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setW(Math.max(280, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const md = (d: string, withYear = false) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: withYear ? undefined : "numeric",
    year: withYear ? "2-digit" : undefined,
    timeZone: "UTC",
  });

function BalanceChart({ f }: { f: Forecast }) {
  const [wrap, W] = useWidth(640);
  const [active, setActive] = useState<number | null>(null);
  const cur = f.currency;
  const first = f.buckets[0]!;
  const last = f.buckets[f.buckets.length - 1]!;
  const start = f.as_of < first.start ? f.as_of : first.start;
  const steps = useMemo(
    () =>
      balanceSteps(
        f.opening_cash,
        start,
        f.buckets.flatMap((b) => b.flows),
      ),
    [f, start],
  );
  const buffer = f.draw_capacity.breakdown.buffer;
  const H = W < 480 ? 210 : 250;
  const balances = steps.map((s) => s.balance);
  const ticks = niceTicks(Math.min(0, buffer, ...balances), Math.max(buffer, ...balances), W < 480 ? 3 : 4);
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const yLabels = ticks.map((t) => compactMoney(t, cur));
  const pad = { l: Math.max(...yLabels.map((l) => l.length)) * 7 + 12, r: 12, t: 10, b: 26 };
  const plotW = W - pad.l - pad.r;
  const total = daysBetween(start, last.end) + 1;
  // A day's flows land at the end of that day; the opening balance sits at the start of the first.
  const xStart = (d: string) => pad.l + (daysBetween(start, d) / total) * plotW;
  const xEnd = (d: string) => pad.l + ((daysBetween(start, d) + 1) / total) * plotW;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const stepX = (i: number) => (i === 0 ? pad.l : xEnd(steps[i]!.date));

  const points: string[] = [`${pad.l},${y(f.opening_cash)}`];
  steps.forEach((s, i) => {
    if (i === 0) return;
    points.push(`${stepX(i)},${y(steps[i - 1]!.balance)}`, `${stepX(i)},${y(s.balance)}`);
  });
  points.push(`${pad.l + plotW},${y(steps[steps.length - 1]!.balance)}`);

  const atOpening = f.low_point.date === f.as_of && f.low_point.balance === f.opening_cash;
  const lowX = atOpening ? pad.l : xEnd(f.low_point.date);
  const isMonth = f.window.bucket === "month";
  // A partial first period can start a day or two before the next: keep labels apart.
  const xTicks = dateTicks(
    f.buckets.map((b) => b.start),
    Math.max(2, Math.floor(plotW / (isMonth ? 56 : 64))),
  ).filter((d, i, all) => i === all.length - 1 || xStart(all[i + 1]!) - xStart(d) >= 48);

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < steps.length; i++) if (Math.abs(stepX(i) - px) < Math.abs(stepX(best) - px)) best = i;
    return best;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(nearest(e.clientX - r.left));
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const n = steps.length - 1;
    const i = active ?? 0;
    const next =
      e.key === "ArrowRight"
        ? Math.min(n, i + 1)
        : e.key === "ArrowLeft"
          ? Math.max(0, i - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n
              : null;
    if (e.key === "Escape") setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  const a = active === null ? null : steps[active];
  const tipW = 220;
  const tipLeft = a ? Math.min(Math.max(0, stepX(active!) + 12), W - tipW) : 0;
  const flipLeft = a && stepX(active!) + 12 + tipW > W;
  const label = `Projected cash balance from ${fmtDate(start)} to ${fmtDate(last.end)}: starts at ${money(f.opening_cash, cur)}, lowest ${money(f.low_point.balance, cur)} on ${fmtDate(f.low_point.date)}, ends at ${money(last.ending, cur)}. Use the arrow keys to step through the days cash moves; the transaction list below has the same figures.`;

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <li className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden="true">
            <line
              x1="0"
              x2="18"
              y1="4"
              y2="4"
              strokeWidth="2.5"
              className="stroke-brand-600 dark:stroke-gold-400"
            />
          </svg>
          Projected balance
        </li>
        {buffer > 0 && (
          <li className="flex items-center gap-1.5">
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                x2="18"
                y1="4"
                y2="4"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                className="stroke-amber-600 dark:stroke-amber-400"
              />
            </svg>
            Cash buffer {money(buffer, cur)}
          </li>
        )}
        <li className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" className="fill-red-600 dark:fill-red-400" />
          </svg>
          Low point {money(f.low_point.balance, cur)}, {fmtDate(f.low_point.date)}
        </li>
      </ul>
      <div ref={wrap} className="relative">
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is keyboard-explorable (arrow keys step through days, with a live readout)
          tabIndex={0}
          className="block touch-pan-y rounded outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setActive(null);
          }}
          onKeyDown={onKey}
          onFocus={() => setActive((v) => v ?? 0)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((t, i) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={pad.l + plotW}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                className={
                  t === 0 && lo < 0
                    ? "stroke-zinc-400 dark:stroke-zinc-500"
                    : "stroke-zinc-200 dark:stroke-zinc-800"
                }
              />
              <text
                x={pad.l - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-zinc-500 text-[11px] tabular-nums"
              >
                {yLabels[i]}
              </text>
            </g>
          ))}
          {xTicks.map((d) => {
            const px = xStart(d);
            const anchor = px - pad.l < 20 ? "start" : pad.l + plotW - px < 20 ? "end" : "middle";
            return (
              <g key={d}>
                <line
                  x1={px}
                  x2={px}
                  y1={H - pad.b}
                  y2={H - pad.b + 4}
                  className="stroke-zinc-300 dark:stroke-zinc-700"
                />
                <text x={px} y={H - 8} textAnchor={anchor} className="fill-zinc-500 text-[11px]">
                  {isMonth ? md(d, true) : md(d)}
                </text>
              </g>
            );
          })}
          {buffer > 0 && (
            <line
              x1={pad.l}
              x2={pad.l + plotW}
              y1={y(buffer)}
              y2={y(buffer)}
              className="stroke-amber-600 dark:stroke-amber-400"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
          )}
          <polyline
            points={points.join(" ")}
            fill="none"
            className="stroke-brand-600 dark:stroke-gold-400"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <circle
            cx={lowX}
            cy={y(f.low_point.balance)}
            r={5}
            strokeWidth={2}
            className="fill-red-600 stroke-white dark:fill-red-400 dark:stroke-zinc-900"
          />
          {a && (
            <g pointerEvents="none">
              <line
                x1={stepX(active!)}
                x2={stepX(active!)}
                y1={pad.t}
                y2={H - pad.b}
                strokeWidth={1}
                className="stroke-zinc-400 dark:stroke-zinc-500"
              />
              <circle
                cx={stepX(active!)}
                cy={y(a.balance)}
                r={4.5}
                strokeWidth={2}
                className="fill-brand-600 stroke-white dark:fill-gold-400 dark:stroke-zinc-900"
              />
            </g>
          )}
        </svg>
        {a && (
          <div
            role="status"
            className="pointer-events-none absolute top-1 rounded-md bg-white p-2.5 text-xs shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700"
            style={{ width: tipW, left: flipLeft ? Math.max(0, stepX(active!) - 12 - tipW) : tipLeft }}
          >
            <p className="text-sm font-semibold tabular-nums">{money(a.balance, cur)}</p>
            <p className="text-zinc-500">
              {active === 0 ? `Opening cash, ${fmtDate(a.date)}` : `End of ${fmtDate(a.date)}`}
              {a.balance < buffer && (
                <span className="text-red-600 dark:text-red-400"> · below the buffer</span>
              )}
            </p>
            {a.flows.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
                {a.flows.slice(0, 4).map((fl) => (
                  <li key={fl.id} className="flex justify-between gap-2">
                    <span className="truncate text-zinc-600 dark:text-zinc-400">{fl.label}</span>
                    <span className="whitespace-nowrap tabular-nums">{money(fl.amount, cur)}</span>
                  </li>
                ))}
                {a.flows.length > 4 && <li className="text-zinc-500">and {a.flows.length - 4} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
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

// ----------------------------------------------------------------------------- needs attention

// ----------------------------------------------------------------------------- transactions

const SOURCE_FILTERS: ForecastFlow["source"][] = [
  "invoice",
  "bill",
  "recurring",
  "pending",
  "planned",
  "draw",
  "reserve",
];
/** A planned flow's id is `item:<id>:<occurrence date>`; the shown date may be clamped to today. */
const occurrenceOf = (flow: ForecastFlow) =>
  flow.id.startsWith("item:") ? flow.id.split(":")[2]! : flow.date;

function TransactionList({
  f,
  items,
  canWrite,
  scenarioId,
  onEditItem,
}: {
  f: Forecast;
  items: PlannedItem[];
  canWrite: boolean;
  scenarioId: string | undefined;
  onEditItem: (item: PlannedItem) => void;
}) {
  const orgId = useOrgId();
  const [query, setQuery] = useState("");
  const [dir, setDir] = useState<"all" | "in" | "out">("all");
  const [sources, setSources] = useState<Set<ForecastFlow["source"]>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  // The open row closes when you click anywhere outside it (or press Esc), so reading the list
  // never leaves a stale editor open. Dialogs opened from the editor don't count as outside.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.isConnected || t.closest("[data-open-flow], [role='dialog']")) return;
      setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as Element).closest("#forecast-search, [role='dialog']")) return;
      setOpenId(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  // "/" jumps to the search box, as in the pickers' keyboard-first pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      (document.getElementById("forecast-search") as HTMLInputElement | null)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Every flow with the balance after it, over the whole forecast: filtering hides rows but never
  // changes what the balance would be.
  const rows = useMemo(() => {
    let bal = f.opening_cash;
    return f.buckets.map((b) => ({
      bucket: b,
      flows: b.flows.map((flow) => {
        bal += flow.amount;
        return { flow, balance: bal };
      }),
    }));
  }, [f]);
  const present = useMemo(() => new Set(f.buckets.flatMap((b) => b.flows.map((x) => x.source))), [f]);

  const parsed = parseQuery(query);
  const keep = (flow: ForecastFlow) =>
    (dir === "all" || (dir === "in" ? flow.amount >= 0 : flow.amount < 0)) &&
    (sources.size === 0 || sources.has(flow.source)) &&
    flowMatches(flow, parsed);
  const filtering = Boolean(query.trim()) || dir !== "all" || sources.size > 0;
  const shown = rows.map((g) => ({ ...g, flows: g.flows.filter((r) => keep(r.flow)) }));
  const all = rows.flatMap((g) => g.flows);
  const hits = shown.flatMap((g) => g.flows);
  const inTotal = hits.reduce((t, r) => t + Math.max(0, r.flow.amount), 0);
  const outTotal = hits.reduce((t, r) => t + Math.max(0, -r.flow.amount), 0);
  const cur = f.currency;
  const chipBtn = (on: boolean) =>
    cx(
      "rounded-full px-2.5 py-0.5 text-xs ring-1",
      on
        ? "bg-brand-600 text-white ring-brand-600 dark:bg-gold-400 dark:text-zinc-900 dark:ring-gold-400"
        : "text-zinc-600 ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800",
    );

  return (
    <Card title="Transactions">
      <div className="mb-3 space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="forecast-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            title="A name, customer, amount, date, or type, such as “rent”, “dec”, “due nov”, or “>1000”. Press / to search, Esc to clear."
            aria-label="Search forecast transactions"
            className="sm:min-w-40 sm:flex-1"
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
            {(["all", "in", "out"] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={dir === d}
                className={chipBtn(dir === d)}
                onClick={() => setDir(d)}
              >
                {d === "all" ? "All" : d === "in" ? "Money in" : "Money out"}
              </button>
            ))}
            <span aria-hidden className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            {SOURCE_FILTERS.filter((s) => present.has(s)).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sources.has(s)}
                className={chipBtn(sources.has(s))}
                onClick={() =>
                  setSources((cur) => {
                    const next = new Set(cur);
                    if (!next.delete(s)) next.add(s);
                    return next;
                  })
                }
              >
                {SOURCE_CHIP[s]}
              </button>
            ))}
            {filtering && (
              <button
                type="button"
                className="ml-1 text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
                onClick={() => {
                  setQuery("");
                  setDir("all");
                  setSources(new Set());
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <p
          className="text-xs text-zinc-500"
          aria-live="polite"
          title={filtering ? "Balances are for the whole forecast." : undefined}
        >
          {filtering ? `${hits.length} of ${all.length}` : `${all.length} transactions`} · in{" "}
          {money(inTotal, cur)} · out {money(outTotal, cur)}
        </p>
      </div>
      {hits.length === 0 ? (
        <Empty title={filtering ? "Nothing matches." : "Nothing expected in this window."}>
          {filtering ? "Try fewer words, or clear the filters." : "Add a planned item, or a longer window."}
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={cx(th, "w-16 sm:w-28")}>Date</th>
              <th className={th}>Item</th>
              <th className={cx(th, "text-right")}>Amount</th>
              <th className={cx(th, "hidden text-right sm:table-cell")}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ bucket, flows }) =>
              flows.length === 0 ? null : (
                <Fragment key={bucket.start}>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/40">
                    <td colSpan={4} className="px-3 py-1.5 text-xs text-zinc-500">
                      <div className="flex justify-between gap-3">
                        <span className="font-medium whitespace-nowrap">
                          {f.window.bucket === "week" ? shortWeekLabel(bucket) : bucketLabel(bucket, "month")}
                        </span>
                        <span className="whitespace-nowrap">ends {money(bucket.ending, cur)}</span>
                      </div>
                    </td>
                  </tr>
                  {flows.map(({ flow, balance }) => {
                    const open = openId === flow.id;
                    return (
                      <Fragment key={flow.id}>
                        <tr
                          data-open-flow={open || undefined}
                          className={cx(
                            "border-t border-zinc-100 dark:border-zinc-800",
                            open && "bg-brand-50/50 dark:bg-zinc-800/50",
                          )}
                        >
                          <td className={cx(td, "whitespace-nowrap text-zinc-600 dark:text-zinc-400")}>
                            <span className="sm:hidden">
                              {shortWeekLabel({ start: flow.date, end: flow.date })}
                            </span>
                            <span className="hidden sm:inline">{fmtDate(flow.date)}</span>
                          </td>
                          <td className={td}>
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setOpenId(open ? null : flow.id)}
                              className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left"
                            >
                              <SourceChipLabel flow={flow} />
                              <span className="font-medium">{flow.label}</span>
                              {/* The chip already says Planned or Draw; say how firm only when it adds something. */}
                              {(FIRMNESS_LABEL[flow.firmness] !== SOURCE_CHIP[flow.source] ||
                                flow.days_overdue) && (
                                <span className="text-xs text-zinc-500">
                                  {FIRMNESS_LABEL[flow.firmness] !== SOURCE_CHIP[flow.source] &&
                                    FIRMNESS_LABEL[flow.firmness]}
                                  {flow.days_overdue ? ` · ${flow.days_overdue} days overdue` : ""}
                                </span>
                              )}
                              {flow.due_date && (
                                <span className="basis-full text-xs text-zinc-500">{dueNote(flow)}</span>
                              )}
                            </button>
                          </td>
                          <td className={cx(td, "text-right whitespace-nowrap")}>
                            <Amount cents={flow.amount} currency={cur} />
                            <div className="text-xs text-zinc-500 sm:hidden">{money(balance, cur)}</div>
                          </td>
                          <td
                            className={cx(
                              td,
                              "hidden text-right whitespace-nowrap sm:table-cell",
                              balance < f.draw_capacity.breakdown.buffer && "text-red-600 dark:text-red-400",
                            )}
                          >
                            {money(balance, cur)}
                          </td>
                        </tr>
                        {open && (
                          <tr data-open-flow className="bg-brand-50/50 dark:bg-zinc-800/50">
                            <td colSpan={4} className="px-3 pb-3">
                              <RowEditor
                                flow={flow}
                                item={items.find((i) => i.id === flow.ref)}
                                orgId={orgId}
                                canWrite={canWrite}
                                scenarioId={scenarioId}
                                onEditItem={onEditItem}
                                onDone={() => setOpenId(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ),
            )}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** The chip without its link, since the whole row label is a button. */
function SourceChipLabel({ flow }: { flow: ForecastFlow }) {
  return <Badge tone={CHIP_TONE[flow.source]}>{SOURCE_CHIP[flow.source]}</Badge>;
}

/**
 * Change one transaction in the open scenario. Planned items are edited directly when they belong to
 * the scenario; a baseline item seen from a scenario is replaced there by a scenario copy, so the
 * baseline stays as it is. A booked amount comes from its document: the scenario can move it,
 * exclude it, or (one-off documents) swap it for a planned amount.
 */
function RowEditor({
  flow,
  item,
  orgId,
  canWrite,
  scenarioId,
  onEditItem,
  onDone,
}: {
  flow: ForecastFlow;
  item: PlannedItem | undefined;
  orgId: string;
  canWrite: boolean;
  scenarioId: string | undefined;
  onEditItem: (item: PlannedItem) => void;
  onDone: () => void;
}) {
  const invalidate = useInvalidateForecast(orgId);
  const [date, setDate] = useState(flow.date);
  const [amount, setAmount] = useState(centsToDecimal(Math.abs(flow.amount)));
  const cents = tryParseCents(amount);
  const amountChanged = cents !== null && cents !== Math.abs(flow.amount);
  const dateChanged = Boolean(date) && date !== flow.date;
  const isItem = flow.target?.type === "forecast_item" && item;
  const repeating = Boolean(item?.unit);
  const ownItem = isItem && (scenarioId ? item!.scenario_id === scenarioId : true);
  const oneOffDoc = flow.target?.type === "invoice" || flow.target?.type === "bill";

  const override = (action: "exclude" | "shift", shift_days?: number) =>
    unwrap(
      api.POST("/api/v1/orgs/{orgId}/forecast/overrides", {
        params: { path: { orgId } },
        body: {
          scenario_id: scenarioId ?? null,
          target_type: flow.target!.type as "invoice",
          target_id: flow.target!.id,
          target_date: flow.target!.date ?? null,
          action,
          shift_days: shift_days ?? null,
        },
      }),
    );
  const addPlanned = (body: Record<string, unknown>) =>
    unwrap(
      api.POST("/api/v1/orgs/{orgId}/forecast/items", {
        params: { path: { orgId } },
        body: { scenario_id: scenarioId ?? null, ...body } as never,
      }),
    );

  const save = useMutation({
    mutationFn: async () => {
      const amt = cents ?? Math.abs(flow.amount);
      if (isItem && ownItem) {
        await unwrap(
          api.PATCH("/api/v1/orgs/{orgId}/forecast/items/{id}", {
            params: { path: { orgId, id: item!.id } },
            body: { amount: amt, ...(repeating || !dateChanged ? {} : { start_date: date }) },
          }),
        );
      } else if (isItem) {
        // A baseline item, seen from a scenario: hide it here and put the changed copy in the scenario.
        const it = item!;
        await override("exclude");
        await addPlanned({
          kind: it.kind,
          name: it.name,
          direction: it.direction,
          amount: amt,
          unit: it.unit,
          interval: it.interval,
          anchor_day: it.anchor_day,
          start_date: repeating ? it.start_date : date,
          end_date: it.end_date,
          max_occurrences: it.max_occurrences,
          account_id: it.account_id,
          contact_id: it.contact_id,
          bank_account_id: it.bank_account_id,
          notes: it.notes,
        });
      } else if (amountChanged && oneOffDoc) {
        // A different amount for a document: the scenario sets the document aside and plans the amount.
        await override("exclude");
        await addPlanned({
          name: `${flow.label} (adjusted)`,
          direction: flow.amount >= 0 ? "in" : "out",
          amount: amt,
          start_date: date,
          notes: `Replaces ${flow.label} in this scenario.`,
        });
      } else if (dateChanged) {
        await override("shift", daysBetween(flow.date, date));
      }
    },
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const exclude = useMutation({
    mutationFn: () => override("exclude"),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const skip = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/forecast/items/{id}/links", {
          params: { path: { orgId, id: item!.id } },
          body: { occurrence_date: occurrenceOf(flow), status: "skipped" },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });

  if (flow.source === "pending")
    return (
      <p className="pt-2 text-sm text-zinc-600 dark:text-zinc-400">
        This is waiting in the review queue; approving or rejecting it there changes the forecast.{" "}
        <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
          Open the review queue
        </Link>
      </p>
    );
  if (!canWrite || !flow.target)
    return <p className="pt-2 text-sm text-zinc-500">You can view this transaction but not change it.</p>;

  const where = scenarioId ? "this scenario" : "the baseline";
  const canDate = isItem ? !repeating : true;
  const canAmount = Boolean(isItem) || oneOffDoc;
  const hint = isItem
    ? repeating
      ? `The amount applies to every occurrence${ownItem ? "" : ` in ${where}`}. To change one date, skip it and add a one-off item.`
      : ownItem
        ? `Changes this planned item in ${where}.`
        : "This item is in the baseline. Saving puts a changed copy in this scenario and leaves the baseline alone."
    : flow.source === "reserve"
      ? `Moving the date moves this installment in ${where}. The amount comes from the reserve's rate and net income; change the rate on the Reserves tab.`
      : flow.source === "recurring"
        ? `Moving the date moves every occurrence of this template in ${where}. Amounts come from the template.`
        : `A new date moves the document's expected payment in ${where}. A new amount sets the document aside in ${where} and plans the amount you enter.`;

  return (
    <div className="space-y-2 pt-2">
      <ErrorText error={save.error ?? exclude.error ?? skip.error} />
      {flow.due_date && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {dueNote(flow)}. Moving the expected date never changes the due date.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {canDate && (
          <Field label={flow.due_date ? "Expected date" : "Date"} className="w-40">
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        )}
        {canAmount && (
          <Field label="Amount" className="w-36" error={cents === null ? "Enter an amount" : null}>
            {(id) => (
              <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            )}
          </Field>
        )}
        <div className="flex flex-wrap gap-1.5 pb-0.5">
          <Button
            size="sm"
            loading={save.isPending}
            disabled={cents === null || !(amountChanged || dateChanged)}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
          {isItem && repeating && (
            <Button size="sm" variant="secondary" loading={skip.isPending} onClick={() => skip.mutate()}>
              Skip this one
            </Button>
          )}
          {!(isItem && ownItem) && (
            <Button
              size="sm"
              variant="secondary"
              loading={exclude.isPending}
              onClick={() => exclude.mutate()}
            >
              Exclude in {scenarioId ? "scenario" : "baseline"}
            </Button>
          )}
          {isItem && ownItem && (
            <Button size="sm" variant="ghost" onClick={() => onEditItem(item!)}>
              More…
            </Button>
          )}
          {flow.source === "invoice" && flow.ref && (
            <Link
              to="/o/$orgId/sales/invoices/$invoiceId"
              params={{ orgId, invoiceId: flow.ref }}
              className="self-center text-xs underline"
            >
              Open invoice
            </Link>
          )}
          {flow.source === "reserve" && (
            <Link
              to="/o/$orgId/forecast/reserves"
              params={{ orgId }}
              className="self-center text-xs underline"
            >
              Open reserves
            </Link>
          )}
          {flow.source === "bill" && flow.ref && (
            <Link
              to="/o/$orgId/expenses/bills/$billId"
              params={{ orgId, billId: flow.ref }}
              className="self-center text-xs underline"
            >
              Open bill
            </Link>
          )}
        </div>
      </div>
      <p className="text-xs text-zinc-500">{hint}</p>
    </div>
  );
}

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
      <Button
        size="sm"
        variant="ghost"
        onClick={() => confirmRemove(item?.name ?? "this item") && archive.mutate(a.item_id!)}
      >
        Remove
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
              Mark checked
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
  planned_unconfirmed: "Not checked lately",
  invoice_overdue: "Overdue invoice",
  bank_feed_stale: "Bank feed",
  card_balance: "Card balance",
  suggested_match: "Possible match",
  template_overlap: "Possible duplicate",
};

// ----------------------------------------------------------------------------- planned items

/** Removing a planned item archives it: it stops counting, and links to past occurrences stay. */
const confirmRemove = (name: string) =>
  window.confirm(`Remove “${name}” from the forecast? It stops counting; links to past occurrences stay.`);

/** What planned items are, and what marking one checked does. */
const PLANNED_HINT =
  "Money you expect that isn't in the books yet. Mark an item checked when you've confirmed it still holds; items unchecked for 60 days appear under Needs attention.";

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
        <>
          <p className="mb-3 text-xs text-zinc-500">{PLANNED_HINT}</p>
          <Table>
            <thead>
              <tr>
                <th className={th}>Item</th>
                <th className={th}>When</th>
                <th className={cx(th, "text-right")}>Amount</th>
                <th className={cx(th, "hidden sm:table-cell")}>Last checked</th>
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
                    {it.next_date && (
                      <div className="text-xs text-zinc-500">Next {fmtDate(it.next_date)}</div>
                    )}
                  </td>
                  <td className={cx(td, "text-right")}>
                    <Amount cents={it.direction === "in" ? it.amount : -it.amount} currency={currency} />
                  </td>
                  <td className={cx(td, "hidden sm:table-cell")}>
                    {it.last_confirmed_at ? fmtDate(it.last_confirmed_at) : "Not yet"}
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
                          aria-label={`Mark ${it.name} checked`}
                          title="It still holds: the date and amount are right."
                        >
                          Mark checked
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => confirmRemove(it.name) && archive.mutate(it.id)}
                          aria-label={`Remove ${it.name}`}
                        >
                          Remove
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
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

type AssumptionKey = keyof typeof DEFAULT_ASSUMPTIONS;

/** One assumption as a sentence with the number in it: "Customers pay [5] days after the due date". */
function SentenceField({
  before,
  after,
  ariaLabel,
  value,
  onChange,
  inputMode,
  hint,
  note,
  onUseBaseline,
  error,
}: {
  before: string;
  after: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  inputMode: "numeric" | "decimal";
  hint: string;
  note: string;
  onUseBaseline: (() => void) | null;
  error: string | null;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <label htmlFor={id}>{before}</label>
        <Input
          id={id}
          inputMode={inputMode}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputMode === "numeric" ? "w-20" : "w-32"}
        />
        <span>{after}</span>
      </div>
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : (
        <p className="text-xs text-zinc-500">{hint}</p>
      )}
      <p className="text-xs text-zinc-500">
        {note}
        {onUseBaseline && (
          <>
            {" · "}
            <button
              type="button"
              className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={onUseBaseline}
            >
              Use baseline
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Three plain questions, each filled in with the value in effect: the scenario's own, else the
 * baseline's, else the default. Saving sends null for a value equal to what it would inherit, so a
 * scenario keeps following the baseline (and the baseline the defaults).
 */
function AssumptionsDialog({
  scenario,
  baseline,
  currency,
  onClose,
}: {
  scenario: ForecastScenario;
  baseline: ForecastScenario | undefined;
  currency: string;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateForecast(orgId);
  const own = scenario.assumptions;
  const inherited = (k: AssumptionKey): number =>
    (scenario.is_baseline ? undefined : baseline?.assumptions[k]) ?? DEFAULT_ASSUMPTIONS[k];
  const effective = (k: AssumptionKey) => own[k] ?? inherited(k);
  const [lag, setLag] = useState(String(effective("collection_lag_days")));
  const [billLag, setBillLag] = useState(String(effective("bill_lag_days")));
  const [buffer, setBuffer] = useState(centsToDecimal(effective("min_cash_buffer")));
  const days = (v: string) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isInteger(n) && n >= -90 && n <= 365 ? n : null;
  };
  const lagN = days(lag);
  const billLagN = days(billLag);
  const bufferCents = buffer.trim() === "" ? 0 : tryParseCents(buffer);
  const bufferBad = bufferCents == null || bufferCents < 0;
  const bad = lagN == null || billLagN == null || bufferBad;
  const keep = (k: AssumptionKey, v: number) => (v === inherited(k) ? null : v);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/orgs/{orgId}/forecast/scenarios/{id}", {
          params: { path: { orgId, id: scenario.id } },
          body: {
            assumptions: {
              collection_lag_days: keep("collection_lag_days", lagN!),
              bill_lag_days: keep("bill_lag_days", billLagN!),
              min_cash_buffer: keep("min_cash_buffer", bufferCents!),
            },
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const dayText = (n: number) => `${n} day${Math.abs(n) === 1 ? "" : "s"}`;
  const note = (k: AssumptionKey, text: (n: number) => string) =>
    `${scenario.is_baseline ? "Default" : "Baseline"}: ${text(inherited(k))}`;
  // A scenario that sets its own value can go back to following the baseline.
  const useBaseline = (
    k: AssumptionKey,
    current: number | null,
    set: (v: string) => void,
    asText: (n: number) => string = String,
  ) => (!scenario.is_baseline && current !== inherited(k) ? () => set(asText(inherited(k))) : null);
  const dayError = "Enter whole days from -90 to 365.";
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
      <div className="space-y-4">
        <ErrorText error={save.error} />
        <SentenceField
          before="Customers pay"
          after="days after the due date"
          ariaLabel="Days customers pay after the due date"
          inputMode="numeric"
          value={lag}
          onChange={setLag}
          hint="Use a negative number if they pay early."
          note={note("collection_lag_days", dayText)}
          onUseBaseline={useBaseline("collection_lag_days", lagN, setLag)}
          error={lagN == null ? dayError : null}
        />
        <SentenceField
          before="You pay bills"
          after="days after the due date"
          ariaLabel="Days you pay bills after the due date"
          inputMode="numeric"
          value={billLag}
          onChange={setBillLag}
          hint="Use a negative number if you pay early."
          note={note("bill_lag_days", dayText)}
          onUseBaseline={useBaseline("bill_lag_days", billLagN, setBillLag)}
          error={billLagN == null ? dayError : null}
        />
        <SentenceField
          before="Keep at least"
          after="in cash"
          ariaLabel="Cash to keep on hand"
          inputMode="decimal"
          value={buffer}
          onChange={setBuffer}
          hint="Your comfortable minimum balance. Safe to draw keeps this much back."
          note={note("min_cash_buffer", (n) => money(n, currency))}
          onUseBaseline={useBaseline(
            "min_cash_buffer",
            bufferBad ? null : bufferCents,
            setBuffer,
            centsToDecimal,
          )}
          error={bufferBad ? "Enter an amount, or 0." : null}
        />
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
          <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
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
            <Field label="Occurrences">
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

/** One entry the draw will propose, for the "How it books" preview. */
interface BookingPreview {
  key: string;
  title: string;
  lines: { side: "Dr" | "Cr"; account: string; amount: number; note?: string }[];
}

const nameStartsDueTo = (name: string) => name.trim().toLowerCase().startsWith("due to");

/**
 * Propose an owner draw. Part of it can pay out tax money set aside in a reserve (each its own
 * reserve payment entry) or pay the owner back for expenses recorded against a "Due to" liability
 * (in the draw's own entry); the rest is an ordinary Owner Draw. "How it books" shows the entries
 * before anything is proposed.
 */
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
  const invalidateReserves = useInvalidateReserves(orgId);
  const banks = useBankAccounts(orgId);
  const accounts = useAccounts(orgId, { balances: true });
  const reserves = useReserves(orgId);
  const active = (reserves.data ?? []).filter((r) => !r.archived_at);
  const views = useReserveViews(
    orgId,
    active.map((r) => r.id),
  );
  const cash = (banks.data ?? []).filter((b) => b.is_active && b.kind !== "credit_card");
  const [bankId, setBankId] = useState("");
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState(centsToDecimal(f.draw_capacity.amount));
  const [memo, setMemo] = useState("");
  const [payouts, setPayouts] = useState<Record<string, { amount: string; year: number | null }>>({});
  const [trueUps, setTrueUps] = useState(false);
  const [dueToId, setDueToId] = useState("");
  const [reimburse, setReimburse] = useState("");
  const bank = bankId || cash[0]?.id || "";
  const bankName = cash.find((b) => b.id === bank)?.name ?? "the bank account";
  const cents = tryParseCents(amount);
  const cur = f.currency;

  const accts = accounts.data ?? [];
  const nameOf = (id: string | null | undefined) => accts.find((a) => a.id === id)?.name ?? "Account";
  const ownerDraw = accts.find((a) => a.system_key === "owner_draw")?.name ?? "Owner Draw";
  // What the business owes the owner: a "Due to" liability's credit balance.
  const dueTos = accts
    .filter((a) => a.type === "liability" && a.is_active && nameStartsDueTo(a.name))
    .map((a) => ({ ...a, owed: -(a.balance ?? 0) }))
    .filter((a) => a.owed > 0);
  const dueTo = dueTos.find((a) => a.id === dueToId) ?? dueTos[0];
  const reimburseCents = !dueTo || reimburse.trim() === "" ? 0 : tryParseCents(reimburse);

  // Each active reserve's parts, with what can be paid out now.
  const parts = active.flatMap((r, i) => {
    const v = views[i]?.data;
    if (!v) return [];
    return v.parts.map((p) => {
      const part = r.parts.find((x) => x.id === p.part_id);
      return {
        reserve: r,
        taxYear: v.tax_year,
        partId: p.part_id,
        label: p.label,
        available: r.mode === "book" ? (p.held ?? 0) : p.remaining,
        trueUpDue: r.mode === "book" ? (p.true_up_due ?? 0) : 0,
        liability: part?.liability_account_id ?? null,
      };
    });
  });
  const payoutOf = (partId: string) => {
    const p = payouts[partId];
    return !p || p.amount.trim() === "" ? 0 : tryParseCents(p.amount);
  };
  const badPayout = parts.some((p) => {
    const c = payoutOf(p.partId);
    return c == null || c < 0;
  });
  const paid = parts.reduce((t, p) => t + Math.max(0, payoutOf(p.partId) ?? 0), 0);
  const reimbursed = Math.max(0, reimburseCents ?? 0);
  const rest = (cents ?? 0) - paid - reimbursed;
  const overSplit = cents != null && rest < 0;
  const overOwed = dueTo != null && reimbursed > dueTo.owed;
  const badReimburse = reimburseCents == null || reimburseCents < 0 || overOwed;
  const trueUpParts = parts.filter((p) => p.trueUpDue !== 0 && p.liability);

  const preview: BookingPreview[] = [];
  if (trueUps)
    for (const p of trueUpParts)
      preview.push({
        key: `tu:${p.partId}`,
        title: `True-up: ${p.reserve.name}, ${p.label}`,
        lines:
          p.trueUpDue > 0
            ? [
                {
                  side: "Dr",
                  account: ownerDraw,
                  amount: p.trueUpDue,
                  note: "Sets aside what the rate says",
                },
                { side: "Cr", account: nameOf(p.liability), amount: p.trueUpDue },
              ]
            : [
                {
                  side: "Dr",
                  account: nameOf(p.liability),
                  amount: -p.trueUpDue,
                  note: "Releases what was over",
                },
                { side: "Cr", account: ownerDraw, amount: -p.trueUpDue },
              ],
      });
  for (const p of parts) {
    const c = payoutOf(p.partId) ?? 0;
    if (c <= 0) continue;
    const year = payouts[p.partId]?.year ?? p.taxYear;
    preview.push({
      key: `pay:${p.partId}`,
      title: `Tax payment: ${p.reserve.name}, ${p.label} ${year}`,
      lines:
        p.reserve.mode === "book"
          ? [
              {
                side: "Dr",
                account: nameOf(p.liability),
                amount: c,
                note: "Clears tax money held for the owner",
              },
              { side: "Cr", account: bankName, amount: c },
            ]
          : [
              {
                side: "Dr",
                account: p.reserve.charge_account_id ? nameOf(p.reserve.charge_account_id) : ownerDraw,
                amount: c,
                note: `Counts as paid toward ${p.label} ${year}`,
              },
              { side: "Cr", account: bankName, amount: c },
            ],
    });
  }
  if (reimbursed > 0 || rest > 0) {
    const lines: BookingPreview["lines"] = [];
    if (reimbursed > 0 && dueTo)
      lines.push({
        side: "Dr",
        account: dueTo.name,
        amount: reimbursed,
        note: "Pays back expenses you covered personally",
      });
    if (rest > 0) lines.push({ side: "Dr", account: ownerDraw, amount: rest, note: "Ordinary owner draw" });
    lines.push({ side: "Cr", account: bankName, amount: reimbursed + Math.max(0, rest) });
    preview.push({
      key: "draw",
      title: reimbursed > 0 ? "Owner reimbursement and draw" : "Owner draw",
      lines,
    });
  }

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
            include_true_ups: trueUps || undefined,
            pay_reserves: parts
              .filter((p) => (payoutOf(p.partId) ?? 0) > 0)
              .map((p) => ({
                part_id: p.partId,
                tax_year: payouts[p.partId]?.year ?? p.taxYear,
                amount: payoutOf(p.partId)!,
              })),
            reimburse_owner: dueTo && reimbursed > 0 ? { account_id: dueTo.id, amount: reimbursed } : null,
          },
        }),
      ),
    onSuccess: () => Promise.all([invalidate(), invalidateReserves()]),
  });
  const done = save.data;
  const over = cents != null && cents > f.draw_capacity.amount;
  const proposed = done
    ? [
        ...done.true_ups
          .filter((t) => t.entry_id)
          .map((t) => ({
            key: `tu:${t.reserve_id}`,
            label: `True-up of ${active.find((r) => r.id === t.reserve_id)?.name ?? "a reserve"}`,
            review: Boolean(t.review_item_id),
          })),
        ...done.payments.map((p) => ({
          key: p.payment.id,
          label: `Tax payment: ${p.payment.part_label} ${p.payment.tax_year}, ${money(p.payment.amount, cur)}`,
          review: Boolean(p.review_item_id),
        })),
        ...(done.draw
          ? [
              {
                key: "draw",
                label: `${done.draw.entry.memo ?? "Owner draw"}, ${money(
                  done.draw.entry.lines.reduce((t, l) => t + Math.max(0, l.amount), 0),
                  cur,
                )}`,
                review: Boolean(done.draw.review),
              },
            ]
          : []),
      ]
    : [];
  const anyReview = proposed.some((p) => p.review);
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
              disabled={!cents || cents <= 0 || !bank || overSplit || badPayout || badReimburse}
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
              {anyReview
                ? "Proposed. What waits in review counts once someone approves it."
                : "Recorded: a review policy approved it."}
              {done.exceeds_capacity &&
                ` It is more than the ${money(done.forecast_snapshot.draw_capacity.amount, cur)} the forecast says is safe to draw.`}
            </Alert>
            <ul className="space-y-1">
              {proposed.map((p) => (
                <li key={p.key} className="flex justify-between gap-3">
                  <span>{p.label}</span>
                  <span className="whitespace-nowrap text-zinc-500">
                    {p.review ? "waits in review" : "recorded"}
                  </span>
                </li>
              ))}
            </ul>
            {anyReview && (
              <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
                Open the review queue
              </Link>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-zinc-500">
              Safe to draw now: <strong>{money(f.draw_capacity.amount, cur)}</strong>. A draw over that is
              still proposed; the reviewer sees the forecast.
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

            {parts.length > 0 && (
              <section className="space-y-2" aria-label="Taxes">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Taxes</h3>
                <p className="text-xs text-zinc-500">
                  Pay part of the draw out as a tax payment from {bankName}. Leave 0 to keep it set aside.
                </p>
                {parts.map((p) => {
                  const c = payoutOf(p.partId);
                  const year = payouts[p.partId]?.year ?? p.taxYear;
                  const set = (v: Partial<{ amount: string; year: number | null }>) =>
                    setPayouts((cur) => ({
                      ...cur,
                      [p.partId]: {
                        amount: cur[p.partId]?.amount ?? "",
                        year: cur[p.partId]?.year ?? null,
                        ...v,
                      },
                    }));
                  return (
                    <div key={p.partId} className="flex flex-wrap items-end gap-3">
                      <div className="min-w-36 flex-1 text-sm">
                        <div className="font-medium">
                          {p.reserve.name}: {p.label}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {p.reserve.mode === "book" ? "Held" : "Still to pay"}: {money(p.available, cur)}
                        </div>
                      </div>
                      <Field
                        label="Pay out for this"
                        className="w-32"
                        error={c == null || c < 0 ? "Enter an amount." : null}
                      >
                        {(id) => (
                          <Input
                            id={id}
                            inputMode="decimal"
                            placeholder="0.00"
                            aria-label={`Pay out for ${p.label}`}
                            value={payouts[p.partId]?.amount ?? ""}
                            onChange={(e) => set({ amount: e.target.value })}
                          />
                        )}
                      </Field>
                      <Field label="Tax year" className="w-24">
                        {(id) => (
                          <Select
                            id={id}
                            value={year}
                            onChange={(e) => set({ year: Number(e.target.value) })}
                          >
                            {[p.taxYear, p.taxYear - 1].map((y) => (
                              <option key={y} value={y}>
                                {y}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    </div>
                  );
                })}
                {trueUpParts.length > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={trueUps} onChange={(e) => setTrueUps(e.target.checked)} />
                    Book the true-up first
                    <span className="text-xs text-zinc-500">
                      (set aside what the rate says for net income to date)
                    </span>
                  </label>
                )}
              </section>
            )}

            {dueTo && (
              <section className="space-y-2" aria-label="Paid back to you">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Paid back to you</h3>
                <p className="text-xs text-zinc-500">
                  Expenses you covered personally (mileage, purchases) that the business owes you back.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  {dueTos.length > 1 ? (
                    <Field label="Account" className="min-w-36 flex-1">
                      {(id) => (
                        <Select id={id} value={dueTo.id} onChange={(e) => setDueToId(e.target.value)}>
                          {dueTos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({money(a.owed, cur)})
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ) : (
                    <div className="min-w-36 flex-1 text-sm">
                      <div className="font-medium">{dueTo.name}</div>
                      <div className="text-xs text-zinc-500">Owed to you: {money(dueTo.owed, cur)}</div>
                    </div>
                  )}
                  <Field
                    label="Pay back"
                    className="w-32"
                    error={
                      reimburseCents == null || reimburseCents < 0
                        ? "Enter an amount."
                        : overOwed
                          ? `At most ${money(dueTo.owed, cur)}.`
                          : null
                    }
                  >
                    {(id) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={reimburse}
                        onChange={(e) => setReimburse(e.target.value)}
                      />
                    )}
                  </Field>
                  <button
                    type="button"
                    className="pb-2 text-xs underline hover:text-zinc-800 dark:hover:text-zinc-200"
                    onClick={() => setReimburse(centsToDecimal(dueTo.owed))}
                  >
                    Pay all {money(dueTo.owed, cur)}
                  </button>
                </div>
              </section>
            )}

            {overSplit && (
              <Alert kind="error">
                The tax payments and the pay-back add up to {money(paid + reimbursed, cur)}, more than the
                draw.
              </Alert>
            )}
            {preview.length > 0 && !overSplit && (
              <section className="space-y-2" aria-label="How it books">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">How it books</h3>
                {preview.map((e) => (
                  <div key={e.key} className="rounded-md ring-1 ring-zinc-200 dark:ring-zinc-800">
                    <div className="border-b border-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                      {e.title}
                    </div>
                    <table className="w-full text-sm">
                      <tbody>
                        {e.lines.map((l, i) => (
                          <tr key={`${l.side}-${i}`}>
                            <td className="w-8 px-3 py-1 text-xs text-zinc-500">{l.side}</td>
                            <td className={cx("py-1", l.side === "Cr" && "pl-4")}>
                              {l.account}
                              {l.note && <div className="text-xs text-zinc-500">{l.note}</div>}
                            </td>
                            <td className="px-3 py-1 text-right whitespace-nowrap tabular-nums">
                              {money(l.amount, cur)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </section>
            )}

            <Field label="Memo" hint="Optional">
              {(id) => (
                <Input
                  id={id}
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder={reimbursed > 0 ? "Owner reimbursement and draw" : "Owner draw"}
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
