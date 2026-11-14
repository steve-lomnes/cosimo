import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
  Tabs,
  td,
  th,
} from "../components/ui";
import { useBankAccounts } from "../lib/banking";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import {
  bpToPercent,
  dueDateText,
  MONTHS,
  percentToBp,
  type Reserve,
  type ReserveDueDate,
  type ReservePayment,
  type ReserveView,
  shortDate,
  US_QUARTERLY,
  useInvalidateReserves,
  useReservePayments,
  useReserves,
  useReserveView,
} from "../lib/reserves";

/** Switches between the forecast and its reserves; both pages show it under their header. */
export function ForecastTabs({ value }: { value: "forecast" | "reserves" }) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  return (
    <Tabs
      value={value}
      onChange={(v) =>
        navigate(
          v === "reserves"
            ? { to: "/o/$orgId/forecast/reserves", params: { orgId } }
            : { to: "/o/$orgId/forecast", params: { orgId }, search: {} as never },
        )
      }
      tabs={[
        { value: "forecast", label: "Forecast" },
        { value: "reserves", label: "Reserves" },
      ]}
    />
  );
}

type Dialog =
  | null
  | { kind: "form"; reserve?: Reserve }
  | { kind: "payment"; view: ReserveView }
  | { kind: "true_up"; view: ReserveView };

export function ReservesPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const reserves = useReserves(orgId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  return (
    <>
      <PageHeader
        title="Cash forecast"
        subtitle="Reserves set money aside as a rate of net income each tax year, such as tax on the owner's share of profit. You choose the rates and due dates; Cosimo doesn't compute tax."
        actions={canWrite && <Button onClick={() => setDialog({ kind: "form" })}>New reserve</Button>}
      />
      <ForecastTabs value="reserves" />
      <ErrorText error={reserves.error} />
      {reserves.isLoading ? (
        <Loading />
      ) : !reserves.data?.length ? (
        <Empty title="No reserves yet">
          Add one to hold back money for taxes or another obligation that follows net income. Its due dates
          show in the forecast, and Safe to draw leaves out what it owes.
        </Empty>
      ) : (
        <div className="space-y-4">
          {reserves.data.map((r) => (
            <ReserveCard
              key={r.id}
              reserve={r}
              canWrite={canWrite}
              onEdit={() => setDialog({ kind: "form", reserve: r })}
              onPay={(view) => setDialog({ kind: "payment", view })}
              onTrueUp={(view) => setDialog({ kind: "true_up", view })}
            />
          ))}
        </div>
      )}
      {dialog?.kind === "form" && <ReserveForm reserve={dialog.reserve} onClose={close} />}
      {dialog?.kind === "payment" && <PaymentDialog view={dialog.view} onClose={close} />}
      {dialog?.kind === "true_up" && <TrueUpDialog view={dialog.view} onClose={close} />}
    </>
  );
}

// ----------------------------------------------------------------------------- a reserve's card

function ReserveCard({
  reserve,
  canWrite,
  onEdit,
  onPay,
  onTrueUp,
}: {
  reserve: Reserve;
  canWrite: boolean;
  onEdit: () => void;
  onPay: (v: ReserveView) => void;
  onTrueUp: (v: ReserveView) => void;
}) {
  const orgId = useOrgId();
  const [year, setYear] = useState<number | undefined>(undefined);
  const view = useReserveView(orgId, reserve.id, year);
  const v = view.data;
  const book = reserve.mode === "book";
  // The tax year today falls in, then the two before it.
  const [ty, tm] = todayIso().split("-").map(Number);
  const current = tm! >= reserve.tax_year_start_month ? ty! : ty! - 1;
  const years = [current, current - 1, current - 2];
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {reserve.name}
          <Badge tone={book ? "blue" : "zinc"}>{book ? "Booked" : "Tracked"}</Badge>
        </span>
      }
    >
      <ErrorText error={view.error} />
      {!v ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          {canWrite && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => onPay(v)}>
                Record payment
              </Button>
              {book && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onTrueUp(v)}
                  disabled={v.true_up_pending}
                >
                  Propose true-up
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Net income {fmtDate(v.tax_year_start)} to{" "}
              {fmtDate(v.as_of < v.tax_year_end ? v.as_of : v.tax_year_end)} ({v.basis} basis):{" "}
              <Amount cents={v.net_income} />
            </p>
            <Field label="Tax year" className="w-32">
              {(id) => (
                <Select
                  id={id}
                  value={String(v.tax_year)}
                  onChange={(e) => {
                    const y = Number(e.target.value);
                    setYear(y === current ? undefined : y);
                  }}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {v.true_up_pending && (
            <Alert kind="info">
              A true-up is waiting in the{" "}
              <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
                review queue
              </Link>
              . Booked amounts include it.
            </Alert>
          )}
          <PartsTable v={v} />
          <PaymentsList reserveId={reserve.id} taxYear={v.tax_year} canWrite={canWrite} />
        </div>
      )}
    </Card>
  );
}

function NextDue({ next }: { next: { date: string; amount: number } | null }) {
  if (!next) return <span className="text-zinc-500">None left</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="sm:hidden">{shortDate(next.date)}</span>
      <span className="hidden sm:inline">{fmtDate(next.date)}</span>
      {" · "}
      <Amount cents={next.amount} />
    </span>
  );
}

/** Per-part figures: a table from the small breakpoint up, stacked rows on a phone. */
function PartsTable({ v }: { v: ReserveView }) {
  const book = v.reserve.mode === "book";
  const rows = [
    ...v.parts.map((p) => ({ key: p.part_id, label: `${p.label} (${bpToPercent(p.rate_bp)}%)`, s: p })),
    ...(v.parts.length > 1 ? [{ key: "total", label: "Total", s: v.totals }] : []),
  ];
  const cols: { label: string; get: (s: ReserveView["totals"]) => number | null }[] = [
    { label: "Target", get: (s) => s.target },
    { label: "Paid", get: (s) => s.paid },
    { label: "Remaining", get: (s) => s.remaining },
    ...(book
      ? [
          { label: "Booked", get: (s: ReserveView["totals"]) => s.booked },
          { label: "Held", get: (s: ReserveView["totals"]) => s.held },
          { label: "True-up due", get: (s: ReserveView["totals"]) => s.true_up_due },
        ]
      : []),
  ];
  return (
    <>
      <ul className="divide-y divide-zinc-100 sm:hidden dark:divide-zinc-800" aria-label="Parts">
        {rows.map((r) => (
          <li key={r.key} className="py-2">
            <p className={cx("text-sm", r.key === "total" && "font-semibold")}>{r.label}</p>
            <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
              {cols.map((c) => (
                <div key={c.label}>
                  <dt className="text-zinc-500">{c.label}</dt>
                  <dd>
                    <Amount cents={c.get(r.s)} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 text-xs text-zinc-500">
              Next due: <NextDue next={r.s.next_due} />
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table>
          <thead>
            <tr>
              <th className={th}>Part</th>
              {cols.map((c) => (
                <th key={c.label} className={cx(th, "text-right")}>
                  {c.label}
                </th>
              ))}
              <th className={cx(th, "text-right")}>Next due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => (
              <tr key={r.key} className={cx(r.key === "total" && "font-semibold")}>
                <td className={td}>{r.label}</td>
                {cols.map((c) => (
                  <td key={c.label} className={cx(td, "text-right")}>
                    <Amount cents={c.get(r.s)} />
                  </td>
                ))}
                <td className={cx(td, "text-right")}>
                  <NextDue next={r.s.next_due} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}

const ENTRY_TONE: Record<string, "amber" | "green" | "red" | "zinc"> = {
  pending_review: "amber",
  posted: "green",
  rejected: "red",
};
const ENTRY_LABEL: Record<string, string> = {
  pending_review: "Waiting in review",
  posted: "Posted",
  rejected: "Rejected",
};

function PaymentsList({
  reserveId,
  taxYear,
  canWrite,
}: {
  reserveId: string;
  taxYear: number;
  canWrite: boolean;
}) {
  const orgId = useOrgId();
  const [open, setOpen] = useState(false);
  const payments = useReservePayments(orgId, open ? reserveId : "", taxYear);
  const invalidate = useInvalidateReserves(orgId);
  const del = useMutation({
    mutationFn: (p: ReservePayment) =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/reserve-payments/{id}", { params: { path: { orgId, id: p.id } } }),
      ),
    onSuccess: invalidate,
  });
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="flex items-center gap-1.5 text-sm font-medium touch:min-h-11"
      >
        <span aria-hidden className="w-3 text-zinc-400">
          {open ? "▾" : "▸"}
        </span>
        Payments for {taxYear}
      </button>
      {open && (
        <div className="mt-2">
          <ErrorText error={payments.error ?? del.error} />
          {payments.isLoading ? (
            <Loading />
          ) : !payments.data?.length ? (
            <p className="text-sm text-zinc-500">No payments recorded for {taxYear}.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Part</th>
                  <th className={cx(th, "text-right")}>Amount</th>
                  {canWrite && <th className={th}>{""}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {payments.data.map((p) => (
                  <tr key={p.id}>
                    <td className={cx(td, "whitespace-nowrap")}>
                      <span className="sm:hidden">{shortDate(p.date)}</span>
                      <span className="hidden sm:inline">{fmtDate(p.date)}</span>
                    </td>
                    <td className={td}>
                      <div>{p.part_label}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        {p.entry_id ? (
                          <Link
                            to="/o/$orgId/accounting/entries/$entryId"
                            params={{ orgId, entryId: p.entry_id }}
                          >
                            <Badge
                              tone={p.entry_reversed ? "zinc" : (ENTRY_TONE[p.entry_status ?? ""] ?? "zinc")}
                            >
                              {p.entry_reversed
                                ? "Reversed"
                                : (ENTRY_LABEL[p.entry_status ?? ""] ?? p.entry_status)}
                            </Badge>
                          </Link>
                        ) : (
                          <Badge>Paid personally</Badge>
                        )}
                        {p.note && <span>{p.note}</span>}
                      </div>
                    </td>
                    <td className={cx(td, "text-right")}>
                      <Amount cents={p.amount} />
                    </td>
                    {canWrite && (
                      <td className={cx(td, "text-right")}>
                        {p.can_delete && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete the ${money(p.amount)} payment of ${p.date}`}
                            loading={del.isPending && del.variables?.id === p.id}
                            onClick={() => del.mutate(p)}
                          >
                            Delete
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            A payment from a bank account has an entry. Delete it only once that entry is rejected or
            reversed.
          </p>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- dialogs

function PaymentDialog({ view, onClose }: { view: ReserveView; onClose: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReserves(orgId);
  const banks = useBankAccounts(orgId);
  const cash = (banks.data ?? []).filter((b) => b.is_active && b.kind !== "credit_card");
  const [partId, setPartId] = useState(view.parts[0]?.part_id ?? "");
  const [taxYear, setTaxYear] = useState(String(view.tax_year));
  const [date, setDate] = useState(todayIso());
  const part = view.parts.find((p) => p.part_id === partId);
  const [amount, setAmount] = useState(centsToDecimal(Math.max(0, part?.remaining ?? 0)));
  const [bank, setBank] = useState("");
  const [note, setNote] = useState("");
  const cents = tryParseCents(amount);
  const year = Number(taxYear);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/reserves/{id}/payments", {
          params: { path: { orgId, id: view.reserve.id } },
          body: {
            part_id: partId,
            tax_year: year,
            date,
            amount: cents!,
            from_bank_account_id: bank || null,
            note: note.trim() || null,
          },
        }),
      ),
    onSuccess: invalidate,
  });
  const done = save.data;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Record a payment: ${view.reserve.name}`}
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
              disabled={!cents || cents <= 0 || !partId || !Number.isInteger(year)}
              onClick={() => save.mutate()}
            >
              Record payment
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <ErrorText error={save.error} />
        {done ? (
          <Alert kind="success">
            {!done.entry
              ? "Recorded. No entry: it was paid outside the business accounts."
              : done.entry.review
                ? "Recorded. Its entry waits in the review queue; rejecting it there removes the payment."
                : "Recorded and posted."}
          </Alert>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Part">
                {(id) => (
                  <Select id={id} value={partId} onChange={(e) => setPartId(e.target.value)}>
                    {view.parts.map((p) => (
                      <option key={p.part_id} value={p.part_id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="For tax year" hint="A January payment is often for the year before.">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={taxYear}
                    onChange={(e) => setTaxYear(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Date paid">
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
            <Field
              label="Paid from"
              hint={
                bank
                  ? view.reserve.mode === "book"
                    ? "Proposes an entry: debit the part's liability account, credit this bank account."
                    : "Proposes an entry: debit the charge account (Owner Draw unless set), credit this bank account."
                  : view.reserve.mode === "book"
                    ? "Paid personally out of a draw already taken: proposes debit the part's liability account, credit the charge account, so the liability clears and the draw isn't counted twice."
                    : "Paid personally (for example after a draw): only the record, no entry."
              }
            >
              {(id) => (
                <Select id={id} value={bank} onChange={(e) => setBank(e.target.value)}>
                  <option value="">Not from a business account</option>
                  {cash.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Note" hint="Optional">
              {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function TrueUpDialog({ view, onClose }: { view: ReserveView; onClose: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReserves(orgId);
  const [asOf, setAsOf] = useState(todayIso());
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/reserves/{id}/true-up", {
          params: { path: { orgId, id: view.reserve.id } },
          body: { as_of: asOf },
        }),
      ),
    onSuccess: invalidate,
  });
  const done = save.data;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Propose a true-up: ${view.reserve.name}`}
      footer={
        done ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Propose true-up
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        <ErrorText error={save.error} />
        {done ? (
          <Alert kind="success">
            {done.review ? "Proposed. It waits in the review queue." : "Posted: a review policy approved it."}
          </Alert>
        ) : (
          <>
            <p>
              One entry books each part at its target as of the date: debit the charge account, credit the
              part's liability account, for the target less what is already booked. Today that is{" "}
              <strong>{money(view.totals.true_up_due)}</strong> in total.
            </p>
            <Field label="As of" hint="The entry's date; net income runs to it.">
              {(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

interface PartDraft {
  id?: string;
  label: string;
  rate: string;
  due_dates: ReserveDueDate[];
  liability_account_id: string;
}

const blankPart = (): PartDraft => ({ label: "", rate: "", due_dates: [], liability_account_id: "" });

function ReserveForm({ reserve, onClose }: { reserve?: Reserve; onClose: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReserves(orgId);
  const accounts = useAccounts(orgId);
  const [name, setName] = useState(reserve?.name ?? "");
  const [mode, setMode] = useState<Reserve["mode"]>(reserve?.mode ?? "track");
  const [startMonth, setStartMonth] = useState(reserve?.tax_year_start_month ?? 1);
  const [schedule, setSchedule] = useState<Reserve["true_up_schedule"]>(
    reserve?.true_up_schedule ?? "manual",
  );
  const [charge, setCharge] = useState(reserve?.charge_account_id ?? "");
  const [parts, setParts] = useState<PartDraft[]>(
    reserve?.parts.map((p) => ({
      id: p.id,
      label: p.label,
      rate: bpToPercent(p.rate_bp),
      due_dates: p.due_dates,
      liability_account_id: p.liability_account_id ?? "",
    })) ?? [blankPart()],
  );
  const book = mode === "book";
  const setPart = (i: number, patch: Partial<PartDraft>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const problems = parts.flatMap((p, i) => {
    const n = p.label || `Part ${i + 1}`;
    const out: string[] = [];
    if (!p.label.trim()) out.push(`Part ${i + 1} needs a label.`);
    if (percentToBp(p.rate) == null) out.push(`${n}: enter a rate from 0 to 100%, with up to 2 decimals.`);
    if (!p.due_dates.length) out.push(`${n}: add a due date.`);
    if (book && !p.liability_account_id) out.push(`${n}: choose a liability account.`);
    return out;
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        mode,
        tax_year_start_month: startMonth,
        true_up_schedule: book ? schedule : ("manual" as const),
        charge_account_id: charge || null,
        parts: parts.map((p) => ({
          id: p.id ?? null,
          label: p.label.trim(),
          rate_bp: percentToBp(p.rate)!,
          due_dates: p.due_dates,
          liability_account_id: p.liability_account_id || null,
        })),
      };
      return reserve
        ? unwrap(
            api.PATCH("/api/v1/orgs/{orgId}/reserves/{id}", {
              params: { path: { orgId, id: reserve.id } },
              body,
            }),
          )
        : unwrap(api.POST("/api/v1/orgs/{orgId}/reserves", { params: { path: { orgId } }, body }));
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/orgs/{orgId}/reserves/{id}", { params: { path: { orgId, id: reserve!.id } } }),
      ),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={reserve ? `Edit ${reserve.name}` : "New reserve"}
      footer={
        <>
          {reserve && (
            <Button
              variant="ghost"
              className="mr-auto"
              loading={archive.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Archive this reserve? It leaves the forecast; its payments and entries stay.",
                  )
                )
                  archive.mutate();
              }}
            >
              Archive
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!name.trim() || problems.length > 0}
            onClick={() => save.mutate()}
          >
            {reserve ? "Save" : "Create reserve"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorText error={save.error ?? archive.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Owner taxes"
              />
            )}
          </Field>
          <Field label="Tax year starts in">
            {(id) => (
              <Select id={id} value={startMonth} onChange={(e) => setStartMonth(Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Mode"
            hint={
              book
                ? "Book: true-up entries book the target as a liability (a declared distribution payable). Use a separate liability account for each part, such as “Tax Distributions Payable”, not Due to Owner."
                : "Track: Cosimo reports the target, what's paid, and what's left. Nothing is booked until you record a payment."
            }
          >
            {(id) => (
              <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as Reserve["mode"])}>
                <option value="track">Track</option>
                <option value="book">Book</option>
              </Select>
            )}
          </Field>
          {book && (
            <Field
              label="True-ups"
              hint="Monthly proposes one on the 1st, as of the month before; it waits in review."
            >
              {(id) => (
                <Select
                  id={id}
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value as Reserve["true_up_schedule"])}
                >
                  <option value="manual">When I propose one</option>
                  <option value="monthly">Monthly</option>
                </Select>
              )}
            </Field>
          )}
          <Field
            label="Charge account"
            hint="Debited by true-ups and by payments in track mode. Owner Draw unless you choose another (an income tax expense account for a C corporation)."
            className="sm:col-span-2"
          >
            {(id) => (
              <AccountSelect
                id={id}
                accounts={accounts.data ?? []}
                value={charge}
                onChange={setCharge}
                placeholder="Owner Draw (default)"
                types={["equity", "expense"]}
              />
            )}
          </Field>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Parts</legend>
          {parts.map((p, i) => (
            <div
              key={p.id ?? `new-${i}`}
              className="space-y-3 rounded-md p-3 ring-1 ring-zinc-200 dark:ring-zinc-800"
            >
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <Field label="Label">
                  {(id) => (
                    <Input
                      id={id}
                      value={p.label}
                      onChange={(e) => setPart(i, { label: e.target.value })}
                      placeholder="Federal"
                    />
                  )}
                </Field>
                <Field label="Rate (%)" error={p.rate && percentToBp(p.rate) == null ? "0 to 100" : null}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={p.rate}
                      onChange={(e) => setPart(i, { rate: e.target.value })}
                      placeholder="25"
                    />
                  )}
                </Field>
              </div>
              <DueDatesEditor
                label={p.label || `Part ${i + 1}`}
                value={p.due_dates}
                onChange={(due_dates) => setPart(i, { due_dates })}
              />
              {book && (
                <Field label="Liability account">
                  {(id) => (
                    <AccountSelect
                      id={id}
                      accounts={accounts.data ?? []}
                      value={p.liability_account_id}
                      onChange={(v) => setPart(i, { liability_account_id: v })}
                      types={["liability"]}
                    />
                  )}
                </Field>
              )}
              {parts.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                >
                  Remove part
                </Button>
              )}
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setParts((ps) => [...ps, blankPart()])}>
            Add part
          </Button>
        </fieldset>
        {problems.length > 0 && (name.trim() || parts.some((p) => p.label)) && (
          <ul className="list-disc pl-5 text-xs text-zinc-500">
            {problems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function DueDatesEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReserveDueDate[];
  onChange: (v: ReserveDueDate[]) => void;
}) {
  const set = (i: number, patch: Partial<ReserveDueDate>) =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Due dates</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => onChange(US_QUARTERLY.map((d) => ({ ...d })))}>
            US quarterly estimates
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onChange([...value, { month: 1, day: 15, year_offset: 0 }])}
          >
            Add date
          </Button>
        </div>
      </div>
      {!value.length && <p className="text-xs text-zinc-500">No due dates yet.</p>}
      <ul className="space-y-2">
        {value.map((d, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={`${label} due date ${i + 1} month`}
              className="w-auto"
              value={d.month}
              onChange={(e) => set(i, { month: Number(e.target.value) })}
            >
              {MONTHS.map((m, k) => (
                <option key={m} value={k + 1}>
                  {m.slice(0, 3)}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`${label} due date ${i + 1} day`}
              className="w-16"
              type="number"
              min={1}
              max={31}
              value={d.day}
              onChange={(e) => set(i, { day: Number(e.target.value) })}
            />
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={d.year_offset === 1}
                onChange={(e) => set(i, { year_offset: e.target.checked ? 1 : 0 })}
              />
              Following year
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${dueDateText(d)}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
