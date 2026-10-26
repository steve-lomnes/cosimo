/**
 * Recurring templates (#24, #35): shared by the Invoices, Bills and Journal entries pages, each of
 * which has its own "Recurring" tab and its own `…/recurring/…` routes rather than a combined page.
 * `kind` picks the API filter, the contact type, the run modes offered, and the lines editor.
 */
import {
  describeSchedule,
  LAST_DAY,
  RECURRENCE_UNITS,
  type RecurrenceUnit,
  renderPeriodText,
  type Schedule,
  upcoming,
} from "@cosimo/core";
import { addMonths, parseTerms } from "@cosimo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, unwrap } from "../api/client";
import { parseQty, type Recurring } from "../lib/documents";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import {
  blank as blankJournalLine,
  type DraftLine,
  JournalLinesEditor,
  lineAmount,
  toDraftLines,
} from "../pages/entries";
import { blankLine, ContactPicker, type EditLine, LinesEditor, lineCents } from "../pages/invoices";
import { TermsSelect } from "./TermsSelect";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Table,
  Textarea,
  td,
  th,
} from "./ui";

let docLineKey = 0;
let entryLineKey = 0;

export type RecurringKind = "invoice" | "bill" | "entry";

interface KindMeta {
  label: string;
  contactKind: "customer" | "vendor" | null;
  runModes: Recurring["run_mode"][];
  accountTypes: ("income" | "expense" | "asset" | "liability")[];
  basePath: (orgId: string) => string;
}

const KIND_META: Record<RecurringKind, KindMeta> = {
  invoice: {
    label: "invoice",
    contactKind: "customer",
    runModes: ["draft", "post", "post_and_send"],
    accountTypes: ["income", "liability"],
    basePath: (orgId) => `/o/${orgId}/sales/invoices`,
  },
  bill: {
    label: "bill",
    contactKind: "vendor",
    runModes: ["draft", "post"],
    accountTypes: ["expense", "asset", "liability"],
    basePath: (orgId) => `/o/${orgId}/expenses/bills`,
  },
  entry: {
    label: "entry",
    contactKind: null,
    runModes: ["draft", "post"],
    accountTypes: [],
    basePath: (orgId) => `/o/${orgId}/accounting/entries`,
  },
};

const RUN_MODE_LABEL: Record<Recurring["run_mode"], string> = {
  draft: "Save as draft",
  post: "Post",
  post_and_send: "Post and email",
};

const RUN_MODE_TONE: Record<Recurring["run_mode"], "zinc" | "blue" | "green"> = {
  draft: "zinc",
  post: "blue",
  post_and_send: "green",
};

const STATUS_LABEL: Record<Recurring["status"], string> = {
  proposed: "Proposed",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
  archived: "Deleted",
};

const STATUS_TONE: Record<Recurring["status"], "zinc" | "green" | "amber" | "red" | "blue"> = {
  proposed: "amber",
  active: "green",
  paused: "zinc",
  ended: "zinc",
  archived: "zinc",
};

export function StatusBadge({ status, error }: { status: Recurring["status"]; error?: string | null }) {
  if (error) {
    return (
      <span title={error}>
        <Badge tone="red">Error</Badge>
      </span>
    );
  }
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

function docPath(kind: RecurringKind, orgId: string, docId: string): string {
  const base = KIND_META[kind].basePath(orgId);
  return `${base}/${docId}`;
}

// ----------------------------------------------------------------------------- list

export function RecurringList({ kind }: { kind: RecurringKind }) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const meta = KIND_META[kind];
  const list = useQuery({
    queryKey: ["recurring", orgId, kind],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/recurring-templates", {
          params: { path: { orgId }, query: { kind } },
        }),
      ).then((r) => r.data),
  });
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["recurring", orgId] }),
      qc.invalidateQueries({ queryKey: ["recurring-template", orgId] }),
    ]);
  const act = useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "skip" | "run" | "delete";
    }): Promise<unknown> => {
      const params = { path: { orgId, templateId: id } };
      if (action === "delete")
        return unwrap(api.DELETE("/api/v1/orgs/{orgId}/recurring-templates/{templateId}", { params }));
      if (action === "run")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/recurring-templates/{templateId}/run", {
            params,
            body: { early: true },
          }),
        );
      return unwrap(
        api.POST(`/api/v1/orgs/{orgId}/recurring-templates/{templateId}/${action}`, {
          params,
          body: {},
        } as never),
      );
    },
    onSuccess: invalidate,
  });
  return (
    <Card>
      {list.isLoading ? (
        <Loading />
      ) : !list.data?.length ? (
        <p className="text-sm text-zinc-500">No recurring {meta.label}s yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Name</th>
              {meta.contactKind && <th className={th}>Contact</th>}
              <th className={th}>Schedule</th>
              <th className={th}>Next</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={th}>Mode</th>
              <th className={th}>Status</th>
              {canWrite && <th className={th} />}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.data.map((t) => (
              <tr key={t.id}>
                <td className={td}>
                  <Link
                    to={`${meta.basePath(orgId)}/recurring/${t.id}`}
                    className="font-medium hover:underline"
                  >
                    {t.name}
                  </Link>
                </td>
                {meta.contactKind && <td className={td}>{t.contact_name}</td>}
                <td className={td}>{t.schedule_summary}</td>
                <td className={`${td} whitespace-nowrap`}>{t.next_date ? fmtDate(t.next_date) : "—"}</td>
                <td className={`${td} text-right`}>
                  <Amount cents={t.total} />
                </td>
                <td className={td}>
                  <Badge tone={RUN_MODE_TONE[t.run_mode]}>{RUN_MODE_LABEL[t.run_mode]}</Badge>
                </td>
                <td className={td}>
                  <StatusBadge status={t.status} error={t.last_error} />
                </td>
                {canWrite && (
                  <td className={`${td} whitespace-nowrap`}>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(t.status === "active" || t.status === "paused") && (
                        <button
                          type="button"
                          className="text-brand-700 hover:underline dark:text-gold-400"
                          onClick={() =>
                            act.mutate({ id: t.id, action: t.status === "active" ? "pause" : "resume" })
                          }
                        >
                          {t.status === "active" ? "Pause" : "Resume"}
                        </button>
                      )}
                      {t.status === "active" && (
                        <button
                          type="button"
                          className="text-brand-700 hover:underline dark:text-gold-400"
                          onClick={() => act.mutate({ id: t.id, action: "skip" })}
                        >
                          Skip next
                        </button>
                      )}
                      {t.status !== "archived" && (
                        <button
                          type="button"
                          className="text-brand-700 hover:underline dark:text-gold-400"
                          onClick={() => act.mutate({ id: t.id, action: "run" })}
                        >
                          Run now
                        </button>
                      )}
                      <Link
                        to={`${meta.basePath(orgId)}/recurring/${t.id}/edit`}
                        className="text-brand-700 hover:underline dark:text-gold-400"
                      >
                        Edit
                      </Link>
                      {t.status !== "archived" && (
                        <button
                          type="button"
                          className="text-red-700 hover:underline dark:text-red-400"
                          onClick={() => {
                            if (confirm(`Delete "${t.name}"?`)) act.mutate({ id: t.id, action: "delete" });
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ErrorText error={act.error} />
    </Card>
  );
}

// ----------------------------------------------------------------------------- detail

export function RecurringDetail({ kind }: { kind: RecurringKind }) {
  const orgId = useOrgId();
  const { templateId } = useParams({ strict: false }) as { templateId: string };
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const meta = KIND_META[kind];
  const q = useQuery({
    queryKey: ["recurring-template", orgId, templateId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/recurring-templates/{templateId}", {
          params: { path: { orgId, templateId } },
        }),
      ),
  });
  const occurrences = useQuery({
    queryKey: ["recurring-occurrences", orgId, templateId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/recurring-templates/{templateId}/occurrences", {
          params: { path: { orgId, templateId }, query: { count: 6 } },
        }),
      ).then((r) => r.data),
    enabled: Boolean(q.data),
  });
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["recurring-template", orgId] }),
      qc.invalidateQueries({ queryKey: ["recurring", orgId] }),
      qc.invalidateQueries({ queryKey: ["recurring-occurrences", orgId] }),
    ]);
  const act = useMutation({
    mutationFn: async (action: "pause" | "resume" | "skip" | "retry" | "run"): Promise<unknown> => {
      const params = { path: { orgId, templateId } };
      if (action === "retry")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/recurring-templates/{templateId}/run", { params, body: {} }),
        );
      if (action === "run")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/recurring-templates/{templateId}/run", {
            params,
            body: { early: true },
          }),
        );
      return unwrap(
        api.POST(`/api/v1/orgs/{orgId}/recurring-templates/{templateId}/${action}`, {
          params,
          body: {},
        } as never),
      );
    },
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/recurring-templates/{templateId}", {
          params: { path: { orgId, templateId } },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      navigate({ to: `${meta.basePath(orgId)}/recurring` });
    },
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const t = q.data.template;
  const runs = q.data.runs;

  return (
    <>
      <PageHeader
        title={t.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            {t.contact_name && `${t.contact_name} · `}
            {t.schedule_summary}
          </span>
        }
        actions={
          canWrite && (
            <>
              {(t.status === "active" || t.status === "paused") && (
                <Button
                  variant="secondary"
                  loading={act.isPending && act.variables === (t.status === "active" ? "pause" : "resume")}
                  onClick={() => act.mutate(t.status === "active" ? "pause" : "resume")}
                >
                  {t.status === "active" ? "Pause" : "Resume"}
                </Button>
              )}
              {t.status === "active" && (
                <Button
                  variant="secondary"
                  loading={act.isPending && act.variables === "skip"}
                  onClick={() => act.mutate("skip")}
                >
                  Skip next
                </Button>
              )}
              {t.status !== "archived" && (
                <Button
                  variant="secondary"
                  loading={act.isPending && act.variables === "run"}
                  onClick={() => act.mutate("run")}
                >
                  Run now
                </Button>
              )}
              <Link to={`${meta.basePath(orgId)}/recurring/${t.id}/edit`}>
                <Button variant="secondary">Edit</Button>
              </Link>
              {t.status !== "archived" && (
                <Button
                  variant="danger"
                  loading={del.isPending}
                  onClick={() => {
                    if (confirm(`Delete "${t.name}"?`)) del.mutate();
                  }}
                >
                  Delete
                </Button>
              )}
            </>
          )
        }
      />
      <div className="space-y-4">
        {t.last_error && (
          <Alert kind="error">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t.last_error}</span>
              <Button
                size="sm"
                variant="secondary"
                loading={act.isPending && act.variables === "retry"}
                onClick={() => act.mutate("retry")}
              >
                Retry now
              </Button>
            </div>
          </Alert>
        )}
        {t.pending_review && (
          <Alert kind="warn">
            This change is waiting in the{" "}
            <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
              review queue
            </Link>
            .
          </Alert>
        )}
        <Card title="Schedule">
          <p className="text-sm">{t.schedule_summary}</p>
          {occurrences.data && occurrences.data.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              {occurrences.data.map((o) => (
                <li key={o.index}>{fmtDate(o.date)}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Template">
          <Table>
            <thead>
              <tr>
                <th className={th}>Description</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {t.template.lines.map((l, i) => (
                <tr key={i}>
                  <td className={td}>{l.description || "—"}</td>
                  <td className={`${td} text-right num`}>
                    {money(l.amount ?? (l.unit_price ?? 0) * ((l.quantity_milli ?? 1000) / 1000))}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-right text-sm font-semibold">
            Total <Amount cents={t.total} />
          </p>
          {t.template.memo && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{t.template.memo}</p>
          )}
        </Card>
        <Card title="History">
          {!runs.length ? (
            <p className="text-sm text-zinc-500">Nothing created yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Document</th>
                  <th className={th}>Status</th>
                  <th className={th}>Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{fmtDate(r.scheduled_date)}</td>
                    <td className={td}>
                      {r.status === "skipped" ? (
                        <span className="text-zinc-500">Skipped</span>
                      ) : r.doc_id ? (
                        <Link to={docPath(kind, orgId, r.doc_id)} className="underline">
                          {r.doc_number || "View"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={td}>{r.doc_status ?? "—"}</td>
                    <td className={td}>
                      {r.send_status === "sent"
                        ? "Sent"
                        : r.send_status === "pending"
                          ? "Pending"
                          : r.send_status === "failed"
                            ? "Failed"
                            : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------- schedule fields

export interface ScheduleState {
  unit: RecurrenceUnit;
  interval: number;
  anchor_day: number | null;
  start_date: string;
  end_date: string | null;
  max_occurrences: number | null;
}

export function defaultSchedule(startDate = todayIso()): ScheduleState {
  return {
    unit: "month",
    interval: 1,
    anchor_day: null,
    start_date: startDate,
    end_date: null,
    max_occurrences: null,
  };
}

type EndMode = "never" | "date" | "count";

export function ScheduleFields({
  schedule,
  setSchedule,
}: {
  schedule: ScheduleState;
  setSchedule: (f: (s: ScheduleState) => ScheduleState) => void;
}) {
  const endMode: EndMode = schedule.max_occurrences != null ? "count" : schedule.end_date ? "date" : "never";
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Repeat every</span>
        <Input
          aria-label="Repeat every"
          type="number"
          min={1}
          max={1000}
          className="w-16"
          value={String(schedule.interval)}
          onChange={(e) => setSchedule((s) => ({ ...s, interval: Math.max(1, Number(e.target.value) || 1) }))}
        />
        <Select
          aria-label="Schedule unit"
          className="w-auto"
          value={schedule.unit}
          onChange={(e) =>
            setSchedule((s) => ({
              ...s,
              unit: e.target.value as RecurrenceUnit,
              anchor_day: e.target.value === "month" || e.target.value === "year" ? s.anchor_day : null,
            }))
          }
        >
          {RECURRENCE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u.charAt(0).toUpperCase() + u.slice(1)}
              {schedule.interval === 1 ? "" : "s"}
            </option>
          ))}
        </Select>
        {(schedule.unit === "month" || schedule.unit === "year") && (
          <>
            <span>on</span>
            <Select
              aria-label="Day of the month"
              className="w-auto"
              value={schedule.anchor_day === LAST_DAY ? "last" : (schedule.anchor_day ?? "")}
              onChange={(e) =>
                setSchedule((s) => ({
                  ...s,
                  anchor_day:
                    e.target.value === "last" ? LAST_DAY : e.target.value ? Number(e.target.value) : null,
                }))
              }
            >
              <option value="">The start date's day</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="last">Last day</option>
            </Select>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Starts</span>
        <Input
          aria-label="Start date"
          type="date"
          className="w-auto"
          value={schedule.start_date}
          onChange={(e) => setSchedule((s) => ({ ...s, start_date: e.target.value }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span>Ends</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="end-mode"
            checked={endMode === "never"}
            onChange={() => setSchedule((s) => ({ ...s, end_date: null, max_occurrences: null }))}
          />
          Never
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="end-mode"
            checked={endMode === "date"}
            onChange={() =>
              setSchedule((s) => ({ ...s, end_date: s.end_date ?? s.start_date, max_occurrences: null }))
            }
          />
          On date
          <Input
            aria-label="End date"
            type="date"
            className="w-auto"
            disabled={endMode !== "date"}
            value={schedule.end_date ?? ""}
            onChange={(e) => setSchedule((s) => ({ ...s, end_date: e.target.value }))}
          />
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="end-mode"
            checked={endMode === "count"}
            onChange={() =>
              setSchedule((s) => ({ ...s, max_occurrences: s.max_occurrences ?? 12, end_date: null }))
            }
          />
          After
          <Input
            aria-label="Number of occurrences"
            type="number"
            min={1}
            className="w-16"
            disabled={endMode !== "count"}
            value={String(schedule.max_occurrences ?? "")}
            onChange={(e) => setSchedule((s) => ({ ...s, max_occurrences: Number(e.target.value) || 1 }))}
          />
          times
        </label>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- form

export function RecurringForm({ kind }: { kind: RecurringKind }) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meta = KIND_META[kind];
  const { templateId } = useParams({ strict: false }) as { templateId?: string };
  const search = useSearch({ strict: false }) as { from?: string };
  const accounts = useAccounts(orgId);

  const existing = useQuery({
    queryKey: ["recurring-template", orgId, templateId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/recurring-templates/{templateId}", {
          params: { path: { orgId, templateId: templateId! } },
        }),
      ),
    enabled: Boolean(templateId),
  });

  const fromInvoice = useQuery({
    queryKey: ["invoice", orgId, search.from],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/invoices/{invoiceId}", {
          params: { path: { orgId, invoiceId: search.from! } },
        }),
      ),
    enabled: kind === "invoice" && !templateId && Boolean(search.from),
  });
  const fromBill = useQuery({
    queryKey: ["bill", orgId, search.from],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/bills/{billId}", {
          params: { path: { orgId, billId: search.from! } },
        }),
      ),
    enabled: kind === "bill" && !templateId && Boolean(search.from),
  });
  const fromEntry = useQuery({
    queryKey: ["entry", orgId, search.from],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/entries/{entryId}", {
          params: { path: { orgId, entryId: search.from! } },
        }),
      ),
    enabled: kind === "entry" && !templateId && Boolean(search.from),
  });

  const [hydrated, setHydrated] = useState(false);
  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [runMode, setRunMode] = useState<Recurring["run_mode"]>("draft");
  const [schedule, setSchedule] = useState<ScheduleState>(() => defaultSchedule());
  const [memo, setMemo] = useState("");
  const [terms, setTerms] = useState("");
  const [dueDays, setDueDays] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [docLines, setDocLines] = useState<EditLine[]>([blankLine()]);
  const [entryLines, setEntryLines] = useState<DraftLine[]>(() => [blankJournalLine(), blankJournalLine()]);

  const defaultAccount =
    accounts.data?.find(
      (a) => a.type === (kind === "invoice" ? "income" : "expense") && a.is_active && !a.is_system,
    )?.id ?? "";

  // Hydrate once, either from the existing template (edit) or the source document (new from doc).
  useEffect(() => {
    if (hydrated) return;
    if (templateId) {
      if (!existing.data) return;
      const t = existing.data.template;
      setName(t.name);
      setContactId(t.contact_id ?? "");
      setRunMode(t.run_mode);
      setSchedule({
        unit: t.schedule.unit,
        interval: t.schedule.interval,
        anchor_day: t.schedule.anchor_day,
        start_date: t.schedule.start_date,
        end_date: t.schedule.end_date,
        max_occurrences: t.schedule.max_occurrences,
      });
      setMemo(t.template.memo ?? "");
      setTerms(t.template.terms ?? "");
      setDueDays(t.template.due_days != null ? String(t.template.due_days) : "");
      setBillNumber(t.template.bill_number ?? "");
      if (kind === "entry") {
        setEntryLines(
          t.template.lines.map((l) => ({
            key: ++entryLineKey,
            account_id: l.account_id,
            debit: (l.amount ?? 0) > 0 ? centsToDecimal(l.amount ?? 0) : "",
            credit: (l.amount ?? 0) < 0 ? centsToDecimal(-(l.amount ?? 0)) : "",
            description: l.description ?? "",
            contact_id: null,
          })),
        );
      } else {
        setDocLines(
          t.template.lines.map((l) => ({
            key: ++docLineKey,
            description: l.description ?? "",
            qty: l.quantity_milli != null ? String(l.quantity_milli / 1000) : "1",
            price: centsToDecimal(l.unit_price ?? l.amount ?? 0),
            account_id: l.account_id,
          })),
        );
      }
      setHydrated(true);
      return;
    }
    if (search.from) {
      if (kind === "invoice") {
        if (!fromInvoice.data) return;
        const inv = fromInvoice.data;
        setName(`${inv.customer_name} recurring invoice`);
        setContactId(inv.customer_id);
        setMemo(inv.memo ?? "");
        setTerms(inv.terms ?? "");
        setSchedule(defaultSchedule(addMonths(inv.issue_date, 1)));
        setDocLines(
          inv.lines.map((l) => ({
            key: ++docLineKey,
            description: l.description,
            qty: String(l.quantity_milli / 1000),
            price: centsToDecimal(l.unit_price),
            account_id: l.account_id,
          })),
        );
      } else if (kind === "bill") {
        if (!fromBill.data) return;
        const b = fromBill.data;
        setName(`${b.vendor_name} recurring bill`);
        setContactId(b.vendor_id);
        setMemo(b.memo ?? "");
        setBillNumber(b.bill_number ?? "");
        setSchedule(defaultSchedule(addMonths(b.issue_date, 1)));
        setDocLines(
          b.lines.map((l) => ({
            key: ++docLineKey,
            description: l.description,
            qty: "1",
            price: centsToDecimal(l.amount),
            account_id: l.account_id,
          })),
        );
      } else {
        if (!fromEntry.data) return;
        const e = fromEntry.data;
        setName(e.memo ? `${e.memo} (recurring)` : "Recurring entry");
        setMemo(e.memo ?? "");
        setSchedule(defaultSchedule(addMonths(e.date, 1)));
        setEntryLines(toDraftLines(e));
      }
      setHydrated(true);
    }
  }, [
    hydrated,
    templateId,
    existing.data,
    search.from,
    kind,
    fromInvoice.data,
    fromBill.data,
    fromEntry.data,
  ]);

  const invalid =
    kind === "entry"
      ? (() => {
          const parsed = entryLines.map(lineAmount);
          const filled = entryLines.filter((l, i) => l.account_id && parsed[i]);
          const diff = parsed.reduce<number>((s, p) => s + (p ?? 0), 0);
          return filled.length < 2 || diff !== 0 || parsed.some((p) => p === null);
        })()
      : docLines.some((l) => lineCents(l, kind === "invoice") === null);

  // A terms rule fixes the due days (Net 15 is 15; end of month has none); only "On due date" and
  // custom terms leave them to the user.
  const termsRule = kind === "invoice" ? parseTerms(terms) : null;
  const derivedDays =
    termsRule && termsRule !== "on_due_date"
      ? termsRule.kind === "days"
        ? String(termsRule.days)
        : ""
      : null;
  const effectiveDueDays = derivedDays ?? dueDays;

  const buildBody = () => {
    const commonSchedule = {
      unit: schedule.unit,
      interval: schedule.interval,
      anchor_day: schedule.anchor_day,
      start_date: schedule.start_date,
      end_date: schedule.end_date,
      max_occurrences: schedule.max_occurrences,
    };
    if (kind === "invoice") {
      return {
        kind: "invoice" as const,
        name,
        contact_id: contactId,
        run_mode: runMode as "draft" | "post" | "post_and_send",
        schedule: commonSchedule,
        template: {
          memo: memo || null,
          terms: terms || null,
          due_days: effectiveDueDays ? Number(effectiveDueDays) : null,
          lines: docLines
            .filter((l) => l.description || l.price)
            .map((l) => ({
              description: l.description || "Item",
              quantity_milli: parseQty(l.qty || "1") ?? 1000,
              unit_price: tryParseCents(l.price || "0") ?? 0,
              account_id: l.account_id || defaultAccount,
            })),
        },
      };
    }
    if (kind === "bill") {
      return {
        kind: "bill" as const,
        name,
        contact_id: contactId,
        run_mode: runMode as "draft" | "post",
        schedule: commonSchedule,
        template: {
          bill_number: billNumber || null,
          memo: memo || null,
          due_days: dueDays ? Number(dueDays) : null,
          lines: docLines
            .filter((l) => l.price)
            .map((l) => ({
              description: l.description || "Item",
              amount: tryParseCents(l.price) ?? 0,
              account_id: l.account_id || defaultAccount,
            })),
        },
      };
    }
    const parsed = entryLines.map(lineAmount);
    return {
      kind: "entry" as const,
      name,
      contact_id: contactId || null,
      run_mode: runMode as "draft" | "post",
      schedule: commonSchedule,
      template: {
        memo: memo || null,
        lines: entryLines
          .map((l, i) => ({ l, amt: parsed[i] }))
          .filter(({ l, amt }) => l.account_id && amt)
          .map(({ l, amt }) => ({
            account_id: l.account_id,
            amount: amt!,
            description: l.description || null,
          })),
      },
    };
  };

  const save = useMutation({
    mutationFn: () => {
      const body = buildBody();
      if (templateId)
        return unwrap(
          api.PUT("/api/v1/orgs/{orgId}/recurring-templates/{templateId}", {
            params: { path: { orgId, templateId } },
            body,
          }),
        );
      return unwrap(
        api.POST("/api/v1/orgs/{orgId}/recurring-templates", { params: { path: { orgId } }, body }),
      );
    },
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: ["recurring", orgId] });
      await qc.invalidateQueries({ queryKey: ["recurring-template", orgId] });
      navigate({ to: `${meta.basePath(orgId)}/recurring/${t.id}` });
    },
  });

  const scheduleForPreview: Schedule = {
    unit: schedule.unit,
    interval: schedule.interval,
    anchor_day: schedule.anchor_day,
    start_date: schedule.start_date || todayIso(),
    end_date: schedule.end_date,
    max_occurrences: schedule.max_occurrences,
  };
  const nextDates = upcoming(scheduleForPreview, 0, 5);
  const backfilling = nextDates.some((d) => d.date < todayIso());
  const previewDate = nextDates[0]?.date ?? scheduleForPreview.start_date;

  if ((templateId && existing.isLoading) || (kind === "invoice" && search.from && fromInvoice.isLoading))
    return <Loading />;

  return (
    <>
      <PageHeader title={templateId ? `Edit ${name || "template"}` : `New recurring ${meta.label}`} />
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Monthly retainer"
                  required
                />
              )}
            </Field>
            {meta.contactKind && (
              <Field label={meta.contactKind === "customer" ? "Customer" : "Vendor"}>
                {() => <ContactPicker kind={meta.contactKind!} value={contactId} onChange={setContactId} />}
              </Field>
            )}
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Run mode</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {meta.runModes.map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="run-mode"
                    checked={runMode === m}
                    onChange={() => setRunMode(m)}
                  />
                  {RUN_MODE_LABEL[m]}
                </label>
              ))}
            </div>
            <p className="text-xs text-zinc-500">
              Posting still follows your review rules; a large or unusual amount may wait for approval.
            </p>
          </fieldset>
          <ScheduleFields schedule={schedule} setSchedule={setSchedule} />
          <div className="rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
            <p className="font-medium">{describeSchedule(scheduleForPreview)}</p>
            {nextDates.length > 0 && (
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                Next: {nextDates.map((d) => fmtDate(d.date)).join(" · ")}
              </p>
            )}
            {backfilling && (
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                Dates before today will be created right away when saved.
              </p>
            )}
          </div>
          {kind !== "entry" && (
            <div className="grid gap-4 sm:grid-cols-3">
              {kind === "invoice" && (
                <Field label="Terms">
                  {(id) => (
                    <TermsSelect id={id} value={terms} onChange={setTerms} emptyLabel="Default terms" />
                  )}
                </Field>
              )}
              {kind === "bill" && (
                <Field label="Bill number" hint="May use {month}, {year}, {quarter}, {period}, {date}.">
                  {(id) => (
                    <Input id={id} value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
                  )}
                </Field>
              )}
              <Field
                label="Due days"
                hint={
                  derivedDays !== null
                    ? "Set by the terms."
                    : kind === "invoice" && termsRule === "on_due_date"
                      ? "Required: days after the issue date."
                      : "Days after the issue date."
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={effectiveDueDays}
                    disabled={derivedDays !== null}
                    required={kind === "invoice" && termsRule === "on_due_date"}
                    onChange={(e) => setDueDays(e.target.value)}
                  />
                )}
              </Field>
            </div>
          )}
          <Field
            label={kind === "entry" ? "Memo" : "Notes"}
            hint={
              memo
                ? `Preview: ${renderPeriodText(memo, previewDate)}`
                : "May use {month}, {year}, {quarter}, {period}, {date}, and offsets like {month-1}."
            }
          >
            {(id) => <Textarea id={id} rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />}
          </Field>
          {kind === "entry" ? (
            <JournalLinesEditor lines={entryLines} setLines={setEntryLines} />
          ) : (
            <LinesEditor
              lines={docLines}
              setLines={setDocLines}
              withQty={kind === "invoice"}
              accountTypes={meta.accountTypes}
              defaultAccount={defaultAccount}
            />
          )}
          {invalid && <Alert kind="error">Check the lines above.</Alert>}
          <ErrorText error={save.error} />
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending} disabled={!name || invalid}>
              Save
            </Button>
            <Link to={`${meta.basePath(orgId)}/recurring`}>
              <Button variant="ghost">Cancel</Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
