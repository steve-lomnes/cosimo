import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, rawFetch, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import { SearchSelect } from "../components/SearchSelect";
import { SnapReceipt } from "../components/SnapReceipt";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Tabs,
  Textarea,
} from "../components/ui";
import { useBankAccounts } from "../lib/banking";
import { useContacts } from "../lib/documents";
import { centsToDecimal, fmtDate, money, todayIso, tryParseCents } from "../lib/format";
import { useAccounts } from "../lib/ledger";
import { useOrgId, useRole } from "../lib/org";
import {
  type Receipt,
  takePendingReceiptFile,
  useInvalidateReceipts,
  useLastPaidWith,
  useReceipt,
} from "../lib/receipts";
import { ContactPicker } from "./invoices";

type Tab = "inbox" | "matched" | "booked" | "dismissed";
const TABS: { value: Tab; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "matched", label: "Matched" },
  { value: "booked", label: "Booked" },
  { value: "dismissed", label: "Dismissed" },
];

// ----------------------------------------------------------------------------- list

export function ReceiptsPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const [tab, setTab] = useState<Tab>("inbox");
  const list = useInfiniteQuery({
    queryKey: ["receipts", orgId, "list", tab],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/receipts", {
          params: { path: { orgId }, query: { status: tab, limit: 50, cursor: pageParam ?? undefined } },
        }),
      ),
    getNextPageParam: (l) => l.next_cursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader
        title="Receipts"
        subtitle="Snap a receipt when you pay. Cosimo matches it to the bank transaction when it arrives."
        actions={
          canWrite && (
            <>
              <SnapReceipt />
              <Link to="/o/$orgId/expenses/receipts/new" params={{ orgId }}>
                <Button variant="secondary">Enter by hand</Button>
              </Link>
            </>
          )
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={TABS} />
      <ErrorText error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title={tab === "inbox" ? "No receipts waiting." : "Nothing here."}>
          {tab === "inbox" && "Receipts you snap show up here until they match a bank transaction."}
        </Empty>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
          {rows.map((r) => (
            <ReceiptRow key={r.id} r={r} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="p-3 text-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function Thumb({ r, size = "h-14 w-14" }: { r: Receipt; size?: string }) {
  const a = r.attachment;
  const box = `${size} shrink-0 rounded bg-zinc-100 text-[10px] text-zinc-500 dark:bg-zinc-800`;
  if (!a) return <span className={`${box} flex items-center justify-center text-center`}>No photo</span>;
  if (!a.mime_type.startsWith("image/"))
    return (
      <span className={`${box} flex items-center justify-center`} role="img" aria-label="PDF receipt">
        PDF
      </span>
    );
  return <img src={a.download_url} alt="Receipt" loading="lazy" className={`${box} object-cover`} />;
}

function MatchState({ r }: { r: Receipt }) {
  const orgId = useOrgId();
  const t = r.transaction;
  const txn = t ? `${fmtDate(t.date)} ${t.description}` : "";
  if (r.status === "matched" && t)
    return (
      <span>
        Matched to {txn} <Amount cents={t.amount} />
      </span>
    );
  if (r.status === "booked")
    return r.booked_target_type === "bill" && r.booked_target_id ? (
      <Link
        to="/o/$orgId/expenses/bills/$billId"
        params={{ orgId, billId: r.booked_target_id }}
        className="underline"
      >
        Booked as a bill
      </Link>
    ) : r.booked_target_id ? (
      <Link
        to="/o/$orgId/accounting/entries/$entryId"
        params={{ orgId, entryId: r.booked_target_id }}
        className="underline"
      >
        Booked as an entry
      </Link>
    ) : (
      <span>Booked</span>
    );
  if (r.status === "dismissed")
    return <span>Dismissed{r.dismissed_reason ? `: ${r.dismissed_reason}` : ""}</span>;
  if (r.suggested_bank_txn_id)
    return (
      <span>
        <Badge tone="amber">Possible match: confirm</Badge>
        {t && (
          <span className="ml-1">
            {txn} <Amount cents={t.amount} />
          </span>
        )}
      </span>
    );
  return (
    <span>
      <Badge tone="zinc">Waiting for bank</Badge>
      {r.stale && <span className="ml-1 text-amber-700 dark:text-amber-400">Over 30 days</span>}
    </span>
  );
}

function ReceiptRow({ r }: { r: Receipt }) {
  const orgId = useOrgId();
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <Thumb r={r} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Link
              to="/o/$orgId/expenses/receipts/$receiptId"
              params={{ orgId, receiptId: r.id }}
              className="min-w-0 break-words font-medium hover:underline"
            >
              {r.merchant || "(no merchant yet)"}
            </Link>
            {r.amount != null ? (
              <Amount cents={r.amount} className="font-medium" />
            ) : (
              <Badge>No amount</Badge>
            )}
          </div>
          <p className="text-xs text-zinc-500">{fmtDate(r.receipt_date)}</p>
          <p className="mt-1 break-words text-xs text-zinc-600 dark:text-zinc-400">
            <MatchState r={r} />
          </p>
        </div>
      </div>
      <ReceiptActions r={r} />
    </li>
  );
}

// ----------------------------------------------------------------------------- actions

type Panel = "match" | "book" | "dismiss" | null;

/** Edit / Match / Confirm / Not this receipt / Book / Dismiss / Restore, with their small panels. */
export function ReceiptActions({ r, showEdit = true }: { r: Receipt; showEdit?: boolean }) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const invalidate = useInvalidateReceipts();
  const [panel, setPanel] = useState<Panel>(null);
  const path = { orgId, receiptId: r.id };
  const post = useMutation({
    mutationFn: async (kind: "match" | "unmatch" | "restore") => {
      if (kind === "match")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/match", {
            params: { path },
            body: { bank_transaction_id: r.suggested_bank_txn_id as string },
          }),
        );
      return unwrap(
        api.POST(
          kind === "unmatch"
            ? "/api/v1/orgs/{orgId}/receipts/{receiptId}/unmatch"
            : "/api/v1/orgs/{orgId}/receipts/{receiptId}/restore",
          { params: { path } },
        ),
      );
    },
    onSuccess: () => invalidate(orgId),
  });
  const toggle = (p: Exclude<Panel, null>) => setPanel(panel === p ? null : p);
  if (!canWrite) return null;
  const inbox = r.status === "inbox";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {showEdit && r.status !== "booked" && (
          <Link to="/o/$orgId/expenses/receipts/$receiptId" params={{ orgId, receiptId: r.id }}>
            <Button size="sm" variant="secondary">
              Edit
            </Button>
          </Link>
        )}
        {inbox && r.suggested_bank_txn_id && (
          <Button
            size="sm"
            loading={post.isPending && post.variables === "match"}
            onClick={() => post.mutate("match")}
          >
            Confirm
          </Button>
        )}
        {inbox && (
          <Button size="sm" variant="secondary" onClick={() => toggle("match")}>
            Match…
          </Button>
        )}
        {(r.status === "matched" || (inbox && r.suggested_bank_txn_id)) && (
          <Button
            size="sm"
            variant="secondary"
            loading={post.isPending && post.variables === "unmatch"}
            onClick={() => post.mutate("unmatch")}
          >
            Not this receipt
          </Button>
        )}
        {inbox && (
          <Button size="sm" variant="secondary" onClick={() => toggle("book")}>
            Book…
          </Button>
        )}
        {(inbox || r.status === "matched") && (
          <Button size="sm" variant="ghost" onClick={() => toggle("dismiss")}>
            Dismiss
          </Button>
        )}
        {r.status === "dismissed" && (
          <Button
            size="sm"
            variant="secondary"
            loading={post.isPending && post.variables === "restore"}
            onClick={() => post.mutate("restore")}
          >
            Restore
          </Button>
        )}
      </div>
      <ErrorText error={post.error} />
      {panel === "match" && <CandidatePicker r={r} onDone={() => setPanel(null)} />}
      {panel === "book" && <BookPanel r={r} />}
      {panel === "dismiss" && <DismissPanel r={r} onDone={() => setPanel(null)} />}
    </div>
  );
}

function CandidatePicker({ r, onDone }: { r: Receipt; onDone: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReceipts();
  const candidates = useQuery({
    queryKey: ["receipts", orgId, "candidates", r.id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/receipts/{receiptId}/candidates", {
          params: { path: { orgId, receiptId: r.id } },
        }),
      ),
  });
  const match = useMutation({
    mutationFn: (txnId: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/match", {
          params: { path: { orgId, receiptId: r.id } },
          body: { bank_transaction_id: txnId },
        }),
      ),
    onSuccess: async () => {
      await invalidate(orgId);
      onDone();
    },
  });
  return (
    <div className="rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-800/40">
      {candidates.isLoading ? (
        <Loading />
      ) : !candidates.data?.data.length ? (
        <p className="text-zinc-500">
          No bank transactions fit yet. A card charge usually posts within a few days.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-700">
          {candidates.data.data.map((c) => (
            <li key={c.transaction.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 break-words">
                {fmtDate(c.transaction.date)} {c.transaction.description}{" "}
                <Amount cents={c.transaction.amount} />
                {c.rejected && (
                  <span className="ml-1">
                    <Badge tone="red">Marked not this receipt</Badge>
                  </span>
                )}
                {c.fit === "tip" && <span className="ml-1 text-xs text-zinc-500">(with tip)</span>}
              </span>
              <Button
                size="sm"
                loading={match.isPending && match.variables === c.transaction.id}
                onClick={() => match.mutate(c.transaction.id)}
              >
                Match
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={match.error} />
    </div>
  );
}

function BookPanel({ r }: { r: Receipt }) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const invalidate = useInvalidateReceipts();
  const accounts = useAccounts(orgId);
  const [as, setAs] = useState<"bill" | "entry">("bill");
  const [vendor, setVendor] = useState(r.contact_id ?? "");
  const [credit, setCredit] = useState("");
  const ready = r.amount != null && Boolean(r.account_id);
  const book = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/book", {
          params: { path: { orgId, receiptId: r.id } },
          body: as === "bill" ? { as, vendor_id: vendor || null } : { as, credit_account_id: credit },
        }),
      ),
    onSuccess: async (out) => {
      await invalidate(orgId);
      if (out.target.type === "bill")
        navigate({
          to: "/o/$orgId/expenses/bills/$billId",
          params: { orgId, billId: out.target.id },
        } as never);
      else if (out.entry)
        navigate({
          to: "/o/$orgId/accounting/entries/$entryId",
          params: { orgId, entryId: out.entry.id },
        } as never);
    },
  });
  return (
    <div className="space-y-3 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-800/40">
      {!ready && (
        <Alert kind="warn">Booking needs an amount and an account. Edit the receipt to add them first.</Alert>
      )}
      <Select aria-label="Book as" value={as} onChange={(e) => setAs(e.target.value as "bill" | "entry")}>
        <option value="bill">A draft bill for a vendor</option>
        <option value="entry">A journal entry (for example paid personally)</option>
      </Select>
      {as === "bill" ? (
        <ContactPicker kind="vendor" value={vendor} onChange={setVendor} />
      ) : (
        <AccountSelect
          aria-label="Credit account"
          accounts={accounts.data ?? []}
          types={["asset", "liability", "equity"]}
          value={credit}
          onChange={setCredit}
          placeholder="Credit account…"
        />
      )}
      <ErrorText error={book.error} />
      <Button
        size="sm"
        disabled={!ready || (as === "bill" ? !vendor : !credit)}
        loading={book.isPending}
        onClick={() => book.mutate()}
      >
        {as === "bill" ? "Create bill" : "Book entry"}
      </Button>
    </div>
  );
}

function DismissPanel({ r, onDone }: { r: Receipt; onDone: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReceipts();
  const [reason, setReason] = useState("");
  const dismiss = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/dismiss", {
          params: { path: { orgId, receiptId: r.id } },
          body: { reason: reason.trim() || null },
        }),
      ),
    onSuccess: async () => {
      await invalidate(orgId);
      onDone();
    },
  });
  return (
    <div className="space-y-2 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-800/40">
      <Input
        aria-label="Reason (optional)"
        placeholder="Reason (optional), for example personal purchase"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ErrorText error={dismiss.error} />
      <Button size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
        Dismiss receipt
      </Button>
    </div>
  );
}

// ----------------------------------------------------------------------------- form

/** Capture (no receipt yet) or edit (with one). The same fields either way. */
function ReceiptForm({
  receipt,
  file,
  onSaved,
}: {
  receipt?: Receipt;
  file?: File | null;
  onSaved: (r: Receipt) => void;
}) {
  const orgId = useOrgId();
  const invalidate = useInvalidateReceipts();
  const banks = useBankAccounts(orgId);
  const accounts = useAccounts(orgId);
  const contacts = useContacts(orgId);
  const [merchant, setMerchant] = useState(receipt?.merchant ?? "");
  const [date, setDate] = useState(receipt?.receipt_date ?? todayIso());
  const [amount, setAmount] = useState(receipt?.amount != null ? centsToDecimal(receipt.amount) : "");
  const [tip, setTip] = useState(receipt?.tip_amount != null ? centsToDecimal(receipt.tip_amount) : "");
  const [paidWith, setPaidWith] = useState(receipt?.bank_account_id ?? "");
  // A new receipt defaults to the account the last one was paid with, until the person picks one.
  const [paidTouched, setPaidTouched] = useState(Boolean(receipt));
  const lastPaid = useLastPaidWith(orgId, !receipt);
  useEffect(() => {
    if (!paidTouched && lastPaid.data) setPaidWith(lastPaid.data);
  }, [paidTouched, lastPaid.data]);
  const [account, setAccount] = useState(receipt?.account_id ?? "");
  const [contact, setContact] = useState(receipt?.contact_id ?? "");
  const [purpose, setPurpose] = useState(receipt?.business_purpose ?? "");
  const [attendees, setAttendees] = useState(receipt?.attendees ?? "");
  // A remembered bank account may have been removed since.
  const paidOk = !paidWith || (banks.data ?? []).some((b) => b.id === paidWith);
  const bankId = banks.data && !paidOk ? "" : paidWith;

  const cents = amount.trim() ? tryParseCents(amount) : null;
  const tipCents = tip.trim() ? tryParseCents(tip) : null;
  const amountError =
    amount.trim() && (cents === null || cents <= 0)
      ? "Enter the amount as dollars, for example 8.69."
      : tipCents !== null && cents !== null && tipCents > cents
        ? "The tip can't be more than the amount charged."
        : tip.trim() && tipCents === null
          ? "Enter the tip as dollars."
          : null;
  const hasFile = Boolean(file || receipt?.attachment);
  const needs = !hasFile && !amount.trim() ? "Add a photo or the amount charged." : null;

  const save = useMutation({
    mutationFn: async () => {
      const tipOk = tipCents != null && cents != null;
      const fields = {
        merchant: merchant.trim() || null,
        receipt_date: date || null,
        amount: cents,
        tip_amount: tip.trim() ? tipCents : null,
        pre_tip_amount: tipOk ? cents - tipCents : null,
        bank_account_id: bankId || null,
        account_id: account || null,
        contact_id: contact || null,
        business_purpose: purpose.trim() || null,
        attendees: attendees.trim() || null,
      };
      if (receipt)
        return unwrap(
          api.PATCH("/api/v1/orgs/{orgId}/receipts/{receiptId}", {
            params: { path: { orgId, receiptId: receipt.id } },
            body: fields,
          }),
        );
      if (!file)
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/receipts", {
            params: { path: { orgId } },
            body: Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null)),
          }),
        );
      const form = new FormData();
      form.append("file", file);
      for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, String(v));
      return (await rawFetch(`/api/v1/orgs/${orgId}/receipts`, { method: "POST", body: form }).then((res) =>
        res.json(),
      )) as Receipt;
    },
    onSuccess: async (r) => {
      await invalidate(orgId);
      onSaved(r);
    },
  });
  const blocked = Boolean(amountError || needs);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Merchant">
          {(id) => <Input id={id} value={merchant} onChange={(e) => setMerchant(e.target.value)} />}
        </Field>
        <Field label="Date">
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <Field label="Amount charged" hint="The total on the card, tip included." error={amountError}>
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label="Tip (optional)">
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              placeholder="0.00"
              value={tip}
              onChange={(e) => setTip(e.target.value)}
            />
          )}
        </Field>
        <Field label="Paid with">
          {(id) => (
            <Select
              id={id}
              value={bankId}
              onChange={(e) => {
                setPaidTouched(true);
                setPaidWith(e.target.value);
              }}
            >
              <option value="">Not sure</option>
              {(banks.data ?? [])
                .filter((b) => b.is_active)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.mask ? ` ··${b.mask}` : ""}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Account">
          {(id) => (
            <AccountSelect
              id={id}
              accounts={accounts.data ?? []}
              value={account}
              onChange={setAccount}
              placeholder="Choose an account…"
            />
          )}
        </Field>
        <Field label="Contact">
          {(id) => (
            <SearchSelect
              id={id}
              value={contact}
              onChange={setContact}
              emptyLabel="None"
              options={(contacts.data ?? []).map((c) => ({
                value: c.id,
                label: c.name,
                keywords: [c.email, c.phone].filter(Boolean).join(" "),
              }))}
            />
          )}
        </Field>
        <Field label="Business purpose">
          {(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
        </Field>
      </div>
      <Field label="Attendees">
        {(id) => (
          <Textarea id={id} rows={2} value={attendees} onChange={(e) => setAttendees(e.target.value)} />
        )}
      </Field>
      {needs && <Alert kind="info">{needs}</Alert>}
      <ErrorText error={save.error} />
      <Button type="submit" loading={save.isPending} disabled={blocked}>
        {receipt ? "Save changes" : "Save receipt"}
      </Button>
    </form>
  );
}

// ----------------------------------------------------------------------------- pages

/** Preview of a file that hasn't been uploaded yet. */
function FilePreview({ file }: { file: File }) {
  const url = useMemo(() => (file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url ? (
    <img src={url} alt="Receipt preview" className="max-h-64 rounded-md object-contain" />
  ) : (
    <p className="text-sm text-zinc-500">{file.name}</p>
  );
}

export function NewReceiptPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const { canWrite } = useRole();
  // Take the file the Snap button left once, so a reload doesn't resurrect it.
  const [file, setFile] = useState<File | null>(() => takePendingReceiptFile());
  if (!canWrite) return <Alert kind="info">Your role is read-only.</Alert>;
  return (
    <>
      <PageHeader
        title="New receipt"
        subtitle="Add what you know now. Cosimo matches it to the bank charge."
      />
      <Card>
        <div className="mb-4 space-y-2">
          {file && <FilePreview file={file} />}
          <FilePicker label={file ? "Choose another photo" : "Add photo"} onFile={setFile} />
        </div>
        <ReceiptForm
          file={file}
          onSaved={() => navigate({ to: "/o/$orgId/expenses/receipts", params: { orgId } } as never)}
        />
      </Card>
    </>
  );
}

function FilePicker({
  label,
  onFile,
  busy,
  primary,
}: {
  label: string;
  onFile: (f: File) => void;
  busy?: boolean;
  primary?: boolean;
}) {
  return (
    <label
      className={
        primary
          ? "inline-flex cursor-pointer items-center justify-center rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500 touch:min-h-11"
          : "inline-flex cursor-pointer items-center justify-center rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500 touch:min-h-11 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800"
      }
    >
      {busy ? "Uploading…" : label}
      <input
        type="file"
        className="sr-only"
        accept="image/*,application/pdf"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

export function ReceiptPage() {
  const orgId = useOrgId();
  const { receiptId } = useParams({ strict: false }) as { receiptId: string };
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const invalidate = useInvalidateReceipts();
  const [saved, setSaved] = useState(false);
  const q = useReceipt(orgId, receiptId);
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append("file", f);
      await rawFetch(`/api/v1/orgs/${orgId}/receipts/${receiptId}/file`, { method: "PUT", body: form });
    },
    onSuccess: () => invalidate(orgId),
  });
  const r = q.data;
  if (q.isLoading) return <Loading />;
  if (!r) return <ErrorText error={q.error} />;
  const editable = canWrite && r.status !== "booked";
  let photo: ReactNode = null;
  if (r.attachment) {
    photo = r.attachment.mime_type.startsWith("image/") ? (
      <a href={r.attachment.download_url} target="_blank" rel="noreferrer">
        <img src={r.attachment.download_url} alt="Receipt" className="max-h-96 rounded-md object-contain" />
      </a>
    ) : (
      <a href={r.attachment.download_url} target="_blank" rel="noreferrer" className="text-sm underline">
        {r.attachment.filename}
      </a>
    );
  }
  return (
    <>
      <PageHeader
        title={r.merchant || "Receipt"}
        subtitle={
          <>
            {fmtDate(r.receipt_date)}
            {r.amount != null && <> · {money(r.amount)}</>}
          </>
        }
        actions={
          <Link to="/o/$orgId/expenses/receipts" params={{ orgId }}>
            <Button variant="secondary">All receipts</Button>
          </Link>
        }
      />
      <div className="space-y-4">
        <Card title="Photo">
          <div className="space-y-3">
            {photo}
            {!r.attachment && (
              <Alert kind="info">
                This receipt has no photo yet. Add the photo to keep it with the record.
              </Alert>
            )}
            {canWrite && (
              <FilePicker
                primary={!r.attachment}
                label={r.attachment ? "Replace photo" : "Add photo"}
                busy={upload.isPending}
                onFile={(f) => upload.mutate(f)}
              />
            )}
            <ErrorText error={upload.error} />
          </div>
        </Card>
        <Card title="Status">
          <div className="space-y-3 text-sm">
            <p className="break-words">
              <MatchState r={r} />
            </p>
            <ReceiptActions r={r} showEdit={false} />
          </div>
        </Card>
        {editable ? (
          <Card title="Details">
            <ReceiptForm
              key={r.updated_at}
              receipt={r}
              onSaved={() => {
                setSaved(true);
                qc.invalidateQueries({ queryKey: ["receipts", orgId] });
              }}
            />
            {saved && <Alert kind="success">Saved.</Alert>}
          </Card>
        ) : (
          <Card title="Details">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Detail label="Business purpose" value={r.business_purpose} />
              <Detail label="Attendees" value={r.attendees} />
            </dl>
          </Card>
        )}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="break-words">{value || "—"}</dd>
    </div>
  );
}
