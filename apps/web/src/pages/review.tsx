import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Input,
  Loading,
  PageHeader,
  Tabs,
  Textarea,
} from "../components/ui";
import { type ReviewItem, useBankAccounts } from "../lib/banking";
import type { Recurring } from "../lib/documents";
import { centsToDecimal, fmtDate, fmtDateTime, money, tryParseCents } from "../lib/format";
import { type Entry, useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";

const TYPE_LABEL: Record<string, string> = {
  journal_entry: "Journal entry",
  bank_categorization: "Bank categorization",
  rule: "New rule",
  invoice_draft: "Invoice draft",
  bill_draft: "Bill draft",
  entry_replacement: "Entry correction",
  payment_redate: "Payment date change",
  import_batch: "Import",
  recurring_template: "Recurring template",
};
const ACTOR_LABEL: Record<string, string> = {
  mcp: "AI assistant",
  api_token: "API token",
  rule: "Rule",
  user: "Person",
  system: "System",
  integration: "Payment provider",
};
const ADJUSTMENT_LABEL = {
  refund: "Stripe refund",
  dispute_withdrawal: "Stripe dispute: funds taken back",
  dispute_reinstatement: "Stripe dispute: funds returned",
} as const;

type ForecastSnapshot = components["schemas"]["ForecastSnapshot"];

/** What the forecast said when an owner draw was proposed: how much was safe to draw, and why. */
function ForecastSnapshotView({ s }: { s: ForecastSnapshot }) {
  const cap = s.draw_capacity;
  return (
    <div className="space-y-1 rounded-md bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-800">
      <p className="font-medium">
        Cash forecast when proposed ({s.scenario.name}, {s.window.name}, as of {fmtDate(s.computed_at)})
      </p>
      <p>
        Safe to draw <strong>{money(cap.amount)}</strong>: low point {money(cap.breakdown.low_point)} on{" "}
        {fmtDate(s.low_point.date)}, less a {money(cap.breakdown.buffer)} buffer
        {/* Snapshots from before reserves have no reserves_not_in_window. */}
        {cap.breakdown.reserves_not_in_window
          ? ` and ${money(cap.breakdown.reserves_not_in_window)} of reserves due later`
          : ""}
        . Opening cash {money(s.opening_cash)}.
        {s.exceeds_capacity && (
          <>
            {" "}
            <Badge tone="red">More than is safe to draw</Badge>
          </>
        )}
      </p>
      {s.drivers.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          {s.drivers.map((d) => (
            <li key={d.id}>
              {d.label} · {fmtDate(d.date)} · {money(d.amount)} ({d.firmness})
            </li>
          ))}
        </ul>
      )}
      {s.attention_count > 0 && (
        <p className="text-xs text-zinc-500">
          {s.attention_count} item{s.attention_count === 1 ? "" : "s"} needed attention in the forecast.
        </p>
      )}
    </div>
  );
}

export function ReviewQueuePage() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { canWrite } = useRole();
  const [status, setStatus] = useState<"pending" | "expired" | "approved,rejected">("pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["review", orgId, status],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/review", {
          params: { path: { orgId }, query: { status, limit: 200 } },
        }),
      ),
  });
  const items = q.data?.data ?? [];
  const invalidate = async () => {
    setSelected(new Set());
    await Promise.all(
      ["review", "bank-txns", "entries", "accounts", "bank-accounts"].map((k) =>
        qc.invalidateQueries({ queryKey: [k, orgId] }),
      ),
    );
  };
  const bulk = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/review/bulk-approve", {
          params: { path: { orgId } },
          body: { ids: [...selected] },
        }),
      ),
    onSuccess: invalidate,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const idx = items.findIndex((i) => i.id === focus);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocus(items[Math.min(idx + 1, items.length - 1)]?.id ?? null);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus(items[Math.max(idx - 1, 0)]?.id ?? null);
      } else if (e.key === " " && focus) {
        e.preventDefault();
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(focus)) n.delete(focus);
          else n.add(focus);
          return n;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focus]);

  const failures = bulk.data?.results.filter((r) => !r.ok) ?? [];
  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle="Changes proposed by AI assistants, rules, and limited API tokens wait here. Nothing affects the books until approved. Keys: j/k to move, space to select."
        actions={
          canWrite &&
          status === "pending" &&
          selected.size > 0 && (
            <Button loading={bulk.isPending} onClick={() => bulk.mutate()}>
              Approve {selected.size} selected
            </Button>
          )
        }
      />
      <Tabs
        value={status}
        onChange={(v) => {
          setStatus(v);
          setSelected(new Set());
        }}
        tabs={[
          {
            value: "pending",
            label: `Pending${q.data && status === "pending" ? ` (${q.data.pending_count})` : ""}`,
          },
          { value: "expired", label: "Expired" },
          { value: "approved,rejected", label: "Decided" },
        ]}
      />
      <ErrorText error={q.error ?? bulk.error} />
      {failures.length > 0 && (
        <Alert kind="warn">
          {failures.length} item(s) could not be approved: {failures.map((f) => f.error?.message).join("; ")}
        </Alert>
      )}
      {q.isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500">
            {status === "pending" ? "Nothing waiting for review." : "Nothing here."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {status === "pending" && canWrite && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.size === items.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
              />
              Select all shown
            </label>
          )}
          {items.map((it) => (
            <ReviewCard
              key={it.id}
              item={it}
              focused={focus === it.id}
              selected={selected.has(it.id)}
              onSelect={(v) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (v) n.add(it.id);
                  else n.delete(it.id);
                  return n;
                })
              }
              onChanged={invalidate}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ReviewCard({
  item,
  focused,
  selected,
  onSelect,
  onChanged,
}: {
  item: ReviewItem;
  focused: boolean;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onChanged: () => void;
}) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const accounts = useAccounts(orgId);
  const banks = useBankAccounts(orgId);
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const payload = (item.payload ?? {}) as {
    entry?: Entry;
    bank_transaction?: { description: string; amount: number; date: string; bank_account_id: string };
    provider_adjustment?: {
      kind: "refund" | "dispute_withdrawal" | "dispute_reinstatement";
      invoice_number: string | null;
      gross: number;
      amount: number;
      fee: number;
    };
    forecast_snapshot?: ForecastSnapshot;
    reserve_true_up?: {
      reserve_name: string;
      as_of: string;
      tax_year: number;
      net_income: number;
      parts: { label: string; target: number; booked: number | null; amount: number }[];
    };
    reserve_payment?: {
      reserve_name: string;
      mode: "track" | "book";
      part_label: string;
      tax_year: number;
      amount: number;
    };
    rule?: { name: string; conditions: Record<string, unknown>; actions: Record<string, unknown> };
    // Invoices and bills held over the threshold before #62 carry only a summary
    // ({ id, number, customer | vendor }); the entry lines above show the amounts.
    invoice?: {
      number: string;
      customer_name?: string;
      customer?: string;
      issue_date?: string;
      total?: number;
      lines?: { description: string; amount: number }[];
    };
    bill?: {
      bill_number?: string | null;
      number?: string | null;
      vendor_name?: string;
      vendor?: string;
      issue_date?: string;
      total?: number;
      lines?: { description: string; amount: number }[];
    };
    original?: Entry;
    replacement?: {
      date: string;
      memo: string | null;
      lines: { account_id: string; amount: number; description: string | null }[];
    };
    payment?: {
      direction: "received" | "sent";
      contact_name: string;
      amount: number;
      applications: { document_type: string; document_number: string; amount: number }[];
    };
    from_date?: string;
    to_date?: string;
    action?: "create" | "update" | "pause" | "resume";
    template?: Recurring;
    before?: Recurring | null;
    import?: {
      source: string;
      files: string[];
      date_range: { from: string; to: string } | null;
      entries: number;
      accounts_created: number;
      contacts_created: number;
    };
  };
  const original = (item.original_payload ?? {}) as { entry?: Entry };
  const approve = useMutation({
    mutationFn: (lockNote?: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/review/{reviewId}/approve", {
          params: { path: { orgId, reviewId: item.id } },
          body: { note: note || null, lock_override_note: lockNote || null },
        }),
      ),
    onSuccess: onChanged,
  });
  const reject = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/review/{reviewId}/reject", {
          params: { path: { orgId, reviewId: item.id } },
          body: { note: note || null },
        }),
      ),
    onSuccess: onChanged,
  });
  const pending = item.status === "pending";
  const bankName = payload.bank_transaction
    ? banks.data?.find((b) => b.id === payload.bank_transaction!.bank_account_id)?.name
    : null;

  return (
    <Card className={cx(focused && "ring-2 ring-brand-500")}>
      <div className="flex flex-wrap items-start gap-3">
        {pending && canWrite && (
          <input
            type="checkbox"
            aria-label="Select"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">{TYPE_LABEL[item.item_type] ?? item.item_type}</Badge>
            <span>
              from <strong>{ACTOR_LABEL[item.proposed_by_actor] ?? item.proposed_by_actor}</strong>
            </span>
            <span className="text-zinc-500">{fmtDateTime(item.created_at)}</span>
            {item.amount != null && <span className="ml-auto font-medium num">{money(item.amount)}</span>}
          </div>
          <p className="text-xs text-zinc-500">Why it is here: {item.reason}</p>
          {item.rationale && (
            <blockquote className="border-l-2 border-zinc-300 pl-3 text-sm italic text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              {item.rationale}
            </blockquote>
          )}
          {payload.bank_transaction && (
            <p className="text-sm">
              Bank: {fmtDate(payload.bank_transaction.date)} · {payload.bank_transaction.description} ·{" "}
              {money(payload.bank_transaction.amount)}
              {bankName && <span className="text-zinc-500"> ({bankName})</span>}
            </p>
          )}
          {payload.reserve_true_up && (
            <div className="space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">Reserve true-up</Badge>
                <span>
                  <strong>{payload.reserve_true_up.reserve_name}</strong> through{" "}
                  {fmtDate(payload.reserve_true_up.as_of)}, tax year {payload.reserve_true_up.tax_year} (net
                  income {money(payload.reserve_true_up.net_income)})
                </span>
              </p>
              <ul className="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
                {payload.reserve_true_up.parts.map((p) => (
                  <li key={p.label}>
                    {p.label}: target {money(p.target)}, booked {money(p.booked ?? 0)}, this books{" "}
                    {money(p.amount)}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-zinc-500">
                Approving books each part at its target in its liability account.
              </p>
            </div>
          )}
          {payload.reserve_payment && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="blue">Reserve payment</Badge>
              <span>
                {payload.reserve_payment.reserve_name}: {payload.reserve_payment.part_label}, tax year{" "}
                {payload.reserve_payment.tax_year} · {money(payload.reserve_payment.amount)}
                <span className="text-zinc-500"> Rejecting it also removes the payment record.</span>
              </span>
            </p>
          )}
          {payload.forecast_snapshot && <ForecastSnapshotView s={payload.forecast_snapshot} />}
          {payload.provider_adjustment && (
            <p className="text-sm">
              {ADJUSTMENT_LABEL[payload.provider_adjustment.kind]}:{" "}
              {money(payload.provider_adjustment.amount)}
              {payload.provider_adjustment.fee > 0 &&
                ` · Stripe dispute fee ${money(payload.provider_adjustment.fee)}`}
              {payload.provider_adjustment.fee < 0 &&
                ` · dispute fee returned ${money(-payload.provider_adjustment.fee)}`}
              {payload.provider_adjustment.invoice_number &&
                ` · invoice ${payload.provider_adjustment.invoice_number}`}
              <span className="text-zinc-500">
                {" "}
                (online payment of {money(payload.provider_adjustment.gross)})
              </span>
            </p>
          )}
          {payload.entry && !editing && (
            <table className="w-full text-sm">
              <tbody>
                {payload.entry.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="py-0.5">{byId.get(l.account_id)?.name ?? l.account_id}</td>
                    <td className="w-28 py-0.5 text-right num">{l.amount > 0 ? money(l.amount) : ""}</td>
                    <td className="w-28 py-0.5 text-right num">{l.amount < 0 ? money(-l.amount) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {payload.entry && (
            <p className="text-xs text-zinc-500">
              {fmtDate(payload.entry.date)} · {payload.entry.memo}
            </p>
          )}
          {item.edited && original.entry && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Edited before approval. Original total {money(original.entry.total)}.
            </p>
          )}
          {payload.rule && (
            <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-800">
              {JSON.stringify(
                {
                  name: payload.rule.name,
                  conditions: payload.rule.conditions,
                  actions: payload.rule.actions,
                },
                null,
                2,
              )}
            </pre>
          )}
          {payload.invoice && (
            <div className="text-sm">
              <p>
                Invoice {payload.invoice.number} to{" "}
                <strong>{payload.invoice.customer_name ?? payload.invoice.customer}</strong>
                {payload.invoice.issue_date && `, ${fmtDate(payload.invoice.issue_date)}`}
                {payload.invoice.total != null && ` · ${money(payload.invoice.total)}`}
              </p>
              <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {(payload.invoice.lines ?? []).map((l, i) => (
                  <li key={`${i}-${l.description}`}>
                    {l.description} · {money(l.amount)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-zinc-500">
                Approving finalizes the invoice. Sending it stays up to you.
              </p>
            </div>
          )}
          {payload.bill && (
            <div className="text-sm">
              <p>
                Bill
                {(payload.bill.bill_number ?? payload.bill.number)
                  ? ` ${payload.bill.bill_number ?? payload.bill.number}`
                  : ""}{" "}
                from <strong>{payload.bill.vendor_name ?? payload.bill.vendor}</strong>
                {payload.bill.issue_date && `, ${fmtDate(payload.bill.issue_date)}`}
                {payload.bill.total != null && ` · ${money(payload.bill.total)}`}
              </p>
              <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {(payload.bill.lines ?? []).map((l, i) => (
                  <li key={`${i}-${l.description}`}>
                    {l.description} · {money(l.amount)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-zinc-500">Approving posts the bill to Accounts Payable.</p>
            </div>
          )}
          {item.item_type === "entry_replacement" && payload.original && payload.replacement && (
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                {
                  title: "Original (reversed)",
                  date: payload.original.date,
                  memo: payload.original.memo,
                  lines: payload.original.lines,
                },
                { title: "Replacement", ...payload.replacement },
              ].map((side) => (
                <div key={side.title}>
                  <p className="text-xs font-medium text-zinc-500">
                    {side.title} · {fmtDate(side.date)}
                    {side.memo ? ` · ${side.memo}` : ""}
                  </p>
                  <table className="w-full">
                    <tbody>
                      {side.lines.map((l, i) => (
                        <tr key={`${i}-${l.account_id}`}>
                          <td className="py-0.5">{byId.get(l.account_id)?.name ?? l.account_id}</td>
                          <td className="w-24 py-0.5 text-right num">
                            {l.amount > 0 ? money(l.amount) : ""}
                          </td>
                          <td className="w-24 py-0.5 text-right num">
                            {l.amount < 0 ? money(-l.amount) : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <p className="text-xs text-zinc-500 sm:col-span-2">
                Approving reverses the original and posts the replacement together. Rejecting changes nothing.
              </p>
            </div>
          )}
          {item.item_type === "payment_redate" && payload.payment && (
            <div className="text-sm">
              <p>
                Payment {payload.payment.direction === "sent" ? "to" : "from"}{" "}
                <strong>{payload.payment.contact_name}</strong> · {money(payload.payment.amount)}
              </p>
              <p>
                {fmtDate(payload.from_date ?? "")} → <strong>{fmtDate(payload.to_date ?? "")}</strong>
              </p>
              <PaymentApplications payment={payload.payment} />
              <p className="mt-1 text-xs text-zinc-500">
                Approving reverses the payment's entry on the old date and posts it again on the new date. The
                documents it pays stay paid, and a matched bank transaction stays matched.
              </p>
            </div>
          )}
          {item.item_type === "journal_entry" && payload.payment && (
            <div className="text-sm">
              <p>
                Payment {payload.payment.direction === "sent" ? "to" : "from"}{" "}
                <strong>{payload.payment.contact_name}</strong> · {money(payload.payment.amount)}
              </p>
              <PaymentApplications payment={payload.payment} showCredit />
            </div>
          )}
          {item.item_type === "recurring_template" && payload.template && (
            <RecurringProposal
              action={payload.action ?? "create"}
              template={payload.template}
              before={payload.before ?? null}
              accountName={(id) => byId.get(id)?.name ?? id}
            />
          )}
          {payload.import && (
            <p className="text-sm">
              {payload.import.entries} entries
              {payload.import.date_range &&
                ` dated ${fmtDate(payload.import.date_range.from)} to ${fmtDate(payload.import.date_range.to)}`}{" "}
              from {payload.import.files.join(", ")}. {payload.import.accounts_created} account(s) and{" "}
              {payload.import.contacts_created} contact(s) were already created. Approving posts every entry;
              rejecting rejects them all. Journal entries lists them as pending review.
            </p>
          )}
          {item.decision_note && <p className="text-xs text-zinc-500">Note: {item.decision_note}</p>}
          {!pending && (
            <Badge tone={item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "amber"}>
              {item.status}
            </Badge>
          )}
          {editing && payload.entry && (
            <EditApprove
              item={item}
              entry={payload.entry}
              onDone={() => {
                setEditing(false);
                onChanged();
              }}
              onCancel={() => setEditing(false)}
            />
          )}
          {canWrite && (pending || item.status === "expired") && !editing && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Input
                aria-label="Decision note"
                placeholder="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="max-w-xs"
              />
              {pending && (
                <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(undefined)}>
                  Approve
                </Button>
              )}
              {pending && payload.entry && (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit and approve
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-red-700"
                loading={reject.isPending}
                onClick={() => reject.mutate()}
              >
                {item.status === "expired" ? "Discard" : "Reject"}
              </Button>
            </div>
          )}
          <ErrorText error={approve.error ?? reject.error} />
        </div>
      </div>
    </Card>
  );
}

/** Edit-and-approve: reuse the entry editor, then approve with the edited lines. */
function EditApprove({
  item,
  entry,
  onDone,
  onCancel,
}: {
  item: ReviewItem;
  entry: Entry;
  onDone: () => void;
  onCancel: () => void;
}) {
  const orgId = useOrgId();
  const [draft, setDraft] = useState<Entry | null>(null);
  const [note, setNote] = useState("");
  const approve = useMutation({
    mutationFn: (e: Entry) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/review/{reviewId}/approve", {
          params: { path: { orgId, reviewId: item.id } },
          body: {
            note: note || "Edited before approval",
            edit: {
              date: e.date,
              memo: e.memo,
              lines: e.lines.map((l) => ({
                account_id: l.account_id,
                amount: l.amount,
                description: l.description,
              })),
            },
          },
        }),
      ),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
      <EntryEditorInline initial={entry} onChange={setDraft} />
      <Textarea
        aria-label="Approval note"
        rows={2}
        placeholder="What did you change?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <ErrorText error={approve.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!draft}
          loading={approve.isPending}
          onClick={() => draft && approve.mutate(draft)}
        >
          Save and approve
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A compact line editor emitting a balanced entry (or null while unbalanced). */
function EntryEditorInline({ initial, onChange }: { initial: Entry; onChange: (e: Entry | null) => void }) {
  const orgId = useOrgId();
  const accounts = useAccounts(orgId);
  const [lines, setLines] = useState(initial.lines.map((l) => ({ ...l, text: centsToDecimal(l.amount) })));
  useEffect(() => {
    const parsed = lines.map((l) => tryParseCents(l.text));
    const ok =
      parsed.every((n) => n !== null && n !== 0) && parsed.reduce<number>((a, b) => a + (b ?? 0), 0) === 0;
    onChange(ok ? { ...initial, lines: lines.map((l, i) => ({ ...l, amount: parsed[i]! })) } : null);
  }, [lines, initial, onChange]);
  return (
    <div className="space-y-1">
      {lines.map((l, i) => (
        <div key={l.id} className="flex gap-2">
          <select
            aria-label={`Line ${i + 1} account`}
            className="flex-1 rounded-md bg-white px-2 py-1 text-sm ring-1 ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700"
            value={l.account_id}
            onChange={(e) =>
              setLines((ls) => ls.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)))
            }
          >
            {(accounts.data ?? [])
              .filter((a) => a.is_active || a.id === l.account_id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
          </select>
          <Input
            aria-label={`Line ${i + 1} amount (debit positive)`}
            className="w-32 text-right num"
            value={l.text}
            onChange={(e) =>
              setLines((ls) => ls.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
            }
          />
        </div>
      ))}
      <p className="text-xs text-zinc-500">Debits positive, credits negative. Lines must sum to zero.</p>
    </div>
  );
}

const RECURRING_ACTION = {
  create: "New",
  update: "Change to",
  pause: "Pause",
  resume: "Resume",
} as const;
const RECURRING_KIND = { invoice: "invoice", bill: "bill", entry: "journal entry" } as const;
const RECURRING_MODE = {
  draft: "Creates drafts",
  post: "Posts each one",
  post_and_send: "Posts and emails each invoice",
} as const;

/** The invoices or bills a payment pays, and any amount left over as customer credit. */
function PaymentApplications({
  payment,
  showCredit,
}: {
  payment: { direction: "received" | "sent"; amount: number; applications: PaymentApplication[] };
  showCredit?: boolean;
}) {
  const applied = payment.applications.reduce((s, x) => s + x.amount, 0);
  return (
    <>
      {payment.applications.length > 0 && (
        <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          {payment.applications.map((x) => (
            <li key={`${x.document_type}-${x.document_number}`}>
              {x.document_type === "bill" ? "Bill" : "Invoice"} {x.document_number} · {money(x.amount)}
            </li>
          ))}
        </ul>
      )}
      {showCredit && payment.amount > applied && (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Unapplied ({payment.direction === "sent" ? "vendor" : "customer"} credit):{" "}
          {money(payment.amount - applied)}
        </p>
      )}
    </>
  );
}

type PaymentApplication = { document_type: string; document_number: string; amount: number };

/** A proposed recurring template, or a change to one, with what it will create and when. */
function RecurringProposal({
  action,
  template: t,
  before,
  accountName,
}: {
  action: keyof typeof RECURRING_ACTION;
  template: Recurring;
  before: Recurring | null;
  accountName: (id: string) => string;
}) {
  const changes = before
    ? [
        ["Name", before.name, t.name],
        ["Contact", before.contact_name ?? "None", t.contact_name ?? "None"],
        ["Schedule", before.schedule_summary, t.schedule_summary],
        ["Starts", fmtDate(before.schedule.start_date), fmtDate(t.schedule.start_date)],
        ["Runs", RECURRING_MODE[before.run_mode], RECURRING_MODE[t.run_mode]],
        ["Amount", money(before.total), money(t.total)],
        ["Memo", before.template.memo ?? "", t.template.memo ?? ""],
        ["Status", before.status, t.status],
      ].filter(([, a, b]) => a !== b)
    : [];
  const linesChanged = before && JSON.stringify(before.template.lines) !== JSON.stringify(t.template.lines);
  return (
    <div className="space-y-1 text-sm">
      <p>
        {RECURRING_ACTION[action]} recurring {RECURRING_KIND[t.kind]} <strong>{t.name}</strong>
        {t.contact_name && <> · {t.contact_name}</>}
      </p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {t.schedule_summary}, from {fmtDate(t.schedule.start_date)} · {RECURRING_MODE[t.run_mode]}
        {t.upcoming.length > 0 && <> · next {t.upcoming.map((d) => fmtDate(d)).join(", ")}</>}
      </p>
      {changes.length > 0 && (
        <ul className="text-xs text-zinc-600 dark:text-zinc-400">
          {changes.map(([label, a, b]) => (
            <li key={label}>
              {label}: <span className="line-through">{a || "none"}</span> → <strong>{b || "none"}</strong>
            </li>
          ))}
        </ul>
      )}
      {(action === "create" || linesChanged) && (
        <table className="w-full text-xs">
          <tbody>
            {t.template.lines.map((l, i) => {
              const amount =
                l.amount ?? Math.round(((l.quantity_milli ?? 1000) * (l.unit_price ?? 0)) / 1000);
              return (
                <tr key={`${i}-${l.account_id}`}>
                  <td className="py-0.5">{accountName(l.account_id)}</td>
                  <td className="py-0.5 text-zinc-500">{l.description}</td>
                  <td className="w-24 py-0.5 text-right num">
                    {t.kind !== "entry" || amount > 0 ? money(Math.abs(amount)) : ""}
                  </td>
                  {t.kind === "entry" && (
                    <td className="w-24 py-0.5 text-right num">{amount < 0 ? money(-amount) : ""}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {t.run_mode === "post_and_send" && action !== "pause" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This template emails the customer automatically each time it runs.
        </p>
      )}
      <p className="text-xs text-zinc-500">
        {action === "create"
          ? "Approving starts the schedule. Rejecting discards the template."
          : "Approving applies the change. Rejecting leaves the template as it is."}
      </p>
    </div>
  );
}
