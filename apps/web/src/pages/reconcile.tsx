import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";
import { AccountSelect } from "../components/AccountSelect";
import { Attachments } from "../components/Attachments";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  Input,
  Loading,
  PageHeader,
  Table,
  td,
  th,
} from "../components/ui";
import { fmtDate, fmtDateTime, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

const STATUS_TONE = { in_progress: "amber", completed: "green", undone: "zinc" } as const;

const FLAG_KIND_LABEL = {
  missing_from_books: "On the statement, not in the books",
  not_on_statement: "In the books, not on the statement",
  mismatch: "Different amount or date",
  beginning_balance: "Beginning balance differs",
  other: "Other",
} as const;
type Flag = components["schemas"]["ReconciliationFlag"];

const who = (actor: string | null) =>
  actor === "mcp" ? "AI assistant" : actor === "api_token" ? "an API token" : "a person";

function FlagRow({
  flag,
  editable,
  onResolve,
  busy,
}: {
  flag: Flag;
  editable: boolean;
  onResolve: (status: "resolved" | "dismissed", note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const open = flag.status === "open";
  return (
    <li className={cx("py-3 text-sm", !open && "text-zinc-500")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={open ? "amber" : "zinc"}>{FLAG_KIND_LABEL[flag.kind]}</Badge>
        {flag.date && <span>{fmtDate(flag.date)}</span>}
        {flag.amount != null && <Amount cents={flag.amount} />}
        {!open && <Badge>{flag.status}</Badge>}
      </div>
      <p className="mt-1">{flag.description}</p>
      <p className="text-xs text-zinc-500">
        Raised by {who(flag.created_actor)} on {fmtDateTime(flag.created_at)}
        {!open && ` · ${flag.status} by ${who(flag.resolved_actor)} on ${fmtDateTime(flag.resolved_at)}`}
        {flag.resolution_note && ` · ${flag.resolution_note}`}
      </p>
      {open && editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Note"
            className="max-w-xs"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResolve("resolved", note)}>
            Resolve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve("dismissed", note)}>
            Dismiss
          </Button>
        </div>
      )}
    </li>
  );
}

export function ReconcileListPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const { canWrite } = useRole();
  const accounts = useAccounts(orgId);
  const recons = useQuery({
    queryKey: ["recons", orgId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/reconciliations", { params: { path: { orgId }, query: {} } }),
      ).then((r) => r.data),
  });
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(todayIso());
  const [bal, setBal] = useState("");
  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/reconciliations", {
          params: { path: { orgId } },
          body: {
            account_id: account,
            statement_end_date: date,
            statement_ending_balance: tryParseCents(bal) ?? 0,
          },
        }),
      ),
    onSuccess: (r) =>
      navigate({ to: "/o/$orgId/banking/reconcile/$reconId", params: { orgId, reconId: r.id } }),
  });
  const name = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? id;
  const reconcilable = (accounts.data ?? []).filter(
    (a) => a.subtype === "bank" || a.subtype === "credit_card",
  );
  return (
    <>
      <PageHeader title="Reconcile" subtitle="Check your books against each bank or card statement." />
      <div className="space-y-4">
        {canWrite && (
          <Card title="Start a reconciliation">
            <form
              className="grid gap-3 sm:grid-cols-4 sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                start.mutate();
              }}
            >
              <Field label="Account" className="sm:col-span-2">
                {(id) => (
                  <AccountSelect id={id} accounts={reconcilable} value={account} onChange={setAccount} />
                )}
              </Field>
              <Field label="Statement end date">
                {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
              <Field label="Statement ending balance" hint="For cards, the amount owed.">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={bal}
                    onChange={(e) => setBal(e.target.value)}
                    placeholder="0.00"
                  />
                )}
              </Field>
              <div className="sm:col-span-4">
                <Button
                  type="submit"
                  disabled={!account || tryParseCents(bal) === null}
                  loading={start.isPending}
                >
                  Start
                </Button>
                <ErrorText error={start.error} />
              </div>
            </form>
          </Card>
        )}
        <Card title="History">
          {recons.isLoading ? (
            <Loading />
          ) : !recons.data?.length ? (
            <p className="text-sm text-zinc-500">No reconciliations yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Account</th>
                  <th className={th}>Statement date</th>
                  <th className={`${th} text-right`}>Ending balance</th>
                  <th className={th}>Status</th>
                  <th className={th}>Statement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recons.data.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>
                      <Link
                        to="/o/$orgId/banking/reconcile/$reconId"
                        params={{ orgId, reconId: r.id }}
                        className="hover:underline"
                      >
                        {name(r.account_id)}
                      </Link>
                    </td>
                    <td className={td}>{fmtDate(r.statement_end_date)}</td>
                    <td className={`${td} text-right`}>
                      <Amount cents={r.statement_ending_balance} />
                    </td>
                    <td className={td}>
                      <Badge tone={STATUS_TONE[r.status]}>{r.status.replace("_", " ")}</Badge>
                    </td>
                    <td className={td}>
                      {r.statement_count ? (
                        `${r.statement_count} ${r.statement_count === 1 ? "file" : "files"}`
                      ) : (
                        <span className="text-zinc-500">None</span>
                      )}
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

export function ReconcilePage() {
  const orgId = useOrgId();
  const { reconId } = useParams({ strict: false }) as { reconId: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { canWrite, isOwner } = useRole();
  const accounts = useAccounts(orgId);
  const q = useQuery({
    queryKey: ["recon", orgId, reconId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/reconciliations/{reconId}", { params: { path: { orgId, reconId } } }),
      ),
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["recon", orgId, reconId] }),
      qc.invalidateQueries({ queryKey: ["recons", orgId] }),
    ]);
  const toggle = useMutation({
    mutationFn: (v: { ids: string[]; cleared: boolean }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/reconciliations/{reconId}/lines", {
          params: { path: { orgId, reconId } },
          body: { line_ids: v.ids, cleared: v.cleared },
        }),
      ),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: (v: { flagId: string; status: "resolved" | "dismissed"; note: string }) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/reconciliations/{reconId}/flags/{flagId}/resolve", {
          params: { path: { orgId, reconId, flagId: v.flagId } },
          body: { status: v.status, note: v.note.trim() || undefined },
        }),
      ),
    onSuccess: refresh,
  });
  const action = useMutation({
    mutationFn: async (a: "complete" | "undo" | "discard") => {
      const params = { path: { orgId, reconId } };
      if (a === "discard")
        return unwrap(api.DELETE("/api/v1/orgs/{orgId}/reconciliations/{reconId}", { params }));
      if (a === "complete")
        return unwrap(api.POST("/api/v1/orgs/{orgId}/reconciliations/{reconId}/complete", { params }));
      return unwrap(api.POST("/api/v1/orgs/{orgId}/reconciliations/{reconId}/undo", { params }));
    },
    onSuccess: async (_d, a) => {
      await refresh();
      if (a === "discard") navigate({ to: "/o/$orgId/banking/reconcile", params: { orgId } });
    },
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorText error={q.error} />;
  const { reconciliation: r, lines, flags } = q.data;
  const openFlags = flags.filter((f) => f.status === "open");
  const closedFlags = flags.filter((f) => f.status !== "open");
  const flagged = new Set(
    flags.filter((f) => f.status === "open" && f.journal_line_id).map((f) => f.journal_line_id),
  );
  const acct = accounts.data?.find((a) => a.id === r.account_id);
  const editable = r.status === "in_progress" && canWrite;
  const cleared = lines.filter((l) => l.cleared);
  const uncleared = lines.filter((l) => !l.cleared);
  const sum = (ls: typeof lines, sign: 1 | -1) =>
    ls.filter((l) => Math.sign(l.amount) === sign).reduce((s, l) => s + l.amount, 0);
  return (
    <>
      <PageHeader
        title={`Reconcile ${acct?.name ?? ""}`}
        subtitle={`Statement ending ${fmtDate(r.statement_end_date)}`}
        actions={
          <>
            {editable && (
              <>
                <Button
                  variant="ghost"
                  loading={action.isPending && action.variables === "discard"}
                  onClick={() => action.mutate("discard")}
                >
                  Discard
                </Button>
                <Button
                  disabled={r.difference !== 0 || openFlags.length > 0}
                  loading={action.isPending && action.variables === "complete"}
                  onClick={() => action.mutate("complete")}
                >
                  Complete
                </Button>
              </>
            )}
            {r.status === "completed" && isOwner && (
              <Button
                variant="secondary"
                loading={action.isPending && action.variables === "undo"}
                onClick={() => action.mutate("undo")}
              >
                Undo reconciliation
              </Button>
            )}
            <Button variant="secondary" onClick={() => window.print()}>
              Print report
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ["Beginning balance", r.beginning_balance],
            ["Cleared balance", r.cleared_balance],
            ["Statement balance", r.statement_ending_balance],
            ["Difference", r.difference],
          ].map(([label, v]) => (
            <Card key={label as string}>
              <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
              <p
                className={cx(
                  "text-lg font-semibold num",
                  label === "Difference" &&
                    (v === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"),
                )}
              >
                {money(v as number)}
              </p>
            </Card>
          ))}
        </div>
        <ErrorText error={toggle.error ?? action.error ?? resolve.error} />
        {editable && openFlags.length > 0 && (
          <Alert kind="warn">
            Resolve or dismiss the {openFlags.length} open {openFlags.length === 1 ? "flag" : "flags"} below
            to complete this reconciliation.
          </Alert>
        )}
        <Card title="Statement">
          <Attachments targetType="reconciliation" targetId={r.id} label="Upload statement" />
        </Card>
        {flags.length > 0 && (
          <Card title={`Flags (${openFlags.length} open)`}>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="Flags">
              {[...openFlags, ...closedFlags].map((f) => (
                <FlagRow
                  key={f.id}
                  flag={f}
                  editable={editable}
                  busy={resolve.isPending}
                  onResolve={(status, note) => resolve.mutate({ flagId: f.id, status, note })}
                />
              ))}
            </ul>
          </Card>
        )}
        {r.status === "completed" && <Alert kind="success">Completed and locked.</Alert>}
        {r.status === "undone" && <Alert kind="warn">This reconciliation was undone.</Alert>}
        <Card
          title={`Transactions through ${fmtDate(r.statement_end_date)}`}
          actions={
            editable && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle.mutate({ ids: uncleared.map((l) => l.id), cleared: true })}
                >
                  Clear all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle.mutate({ ids: cleared.map((l) => l.id), cleared: false })}
                >
                  Unclear all
                </Button>
              </>
            )
          }
        >
          <p className="mb-2 text-xs text-zinc-500">
            Cleared: {cleared.length} · deposits {money(sum(cleared, 1))} · withdrawals{" "}
            {money(sum(cleared, -1))}. Uncleared: {uncleared.length}.
          </p>
          <Table>
            <thead>
              <tr>
                <th className={`${th} w-8`}>
                  <span className="sr-only">Cleared</span>
                </th>
                <th className={th}>Date</th>
                <th className={th}>Memo</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {lines.map((l) => (
                <tr key={l.id} className={l.cleared ? "bg-emerald-50/50 dark:bg-emerald-950/20" : ""}>
                  <td className={td}>
                    <input
                      type="checkbox"
                      aria-label={`Cleared ${l.memo ?? ""}`}
                      checked={Boolean(l.cleared)}
                      disabled={!editable || toggle.isPending}
                      onChange={(e) => toggle.mutate({ ids: [l.id], cleared: e.target.checked })}
                    />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{fmtDate(l.date)}</td>
                  <td className={td}>
                    <Link
                      to="/o/$orgId/accounting/entries/$entryId"
                      params={{ orgId, entryId: l.entry_id }}
                      className="hover:underline"
                    >
                      {l.memo || l.description || "(no memo)"}
                    </Link>
                    {flagged.has(l.id) && (
                      <span role="img" aria-label="Flagged" title="Flagged" className="ml-1.5">
                        ⚑
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    <Amount cents={l.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
