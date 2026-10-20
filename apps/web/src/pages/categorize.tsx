import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import { Attachments } from "../components/Attachments";
import {
  Alert,
  Amount,
  Badge,
  Button,
  cx,
  ErrorText,
  FilterPills,
  Input,
  Loading,
  PageHeader,
  Select,
  Textarea,
} from "../components/ui";
import { type BankTxn, useBankAccounts } from "../lib/banking";
import { centsToDecimal, fmtDate, money, tryParseCents } from "../lib/format";
import { type Account, useAccounts } from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";
import { useInvalidateReceipts, useReceipt } from "../lib/receipts";
import { ContactPicker } from "./invoices";
import { Thumb } from "./receipts";

type Filter = "all" | "todo" | "pending" | "categorized" | "excluded";
type Mode = "categorize" | "split" | "transfer" | "match" | "payment";

/** What each filter pill sends as the `bucket` query param; "all" sends none. */
const FILTER_BUCKET: Record<Filter, string | undefined> = {
  all: undefined,
  todo: "to_categorize",
  pending: "pending",
  categorized: "categorized",
  excluded: "excluded",
};

/** Unknown values fall back to All; the old tab value "new" is kept working as "todo". */
function normalizeFilter(s: string | undefined): Filter {
  if (s === "new") return "todo";
  return s === "todo" || s === "pending" || s === "categorized" || s === "excluded" ? s : "all";
}

export function CategorizePage() {
  const orgId = useOrgId();
  const search = useSearch({ strict: false }) as { account?: string; status?: string };
  const navigate = useNavigate();
  const banks = useBankAccounts(orgId);
  const accounts = useAccounts(orgId);
  const filter = normalizeFilter(search.status);
  const bankId = search.account ?? "";
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const set = (p: Record<string, string | undefined>) =>
    navigate({ to: ".", search: { ...search, ...p } as never, replace: true });

  const counts = useQuery({
    queryKey: ["bank-txns", orgId, "counts", bankId, q],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/bank-transactions/counts", {
          params: { path: { orgId }, query: { bank_account_id: bankId || undefined, q: q || undefined } },
        }),
      ),
  });
  const list = useInfiniteQuery({
    queryKey: ["bank-txns", orgId, bankId, filter, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/bank-transactions", {
          params: {
            path: { orgId },
            query: {
              bank_account_id: bankId || undefined,
              bucket: FILTER_BUCKET[filter],
              q: q || undefined,
              limit: 100,
              cursor: pageParam ?? undefined,
            },
          },
        }),
      ),
    getNextPageParam: (l) => l.next_cursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const bankName = useMemo(() => new Map((banks.data ?? []).map((b) => [b.id, b.name])), [banks.data]);

  // Keyboard: j/k or arrows to move, Esc to collapse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const idx = rows.findIndex((r) => r.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected(rows[Math.min(idx + 1, rows.length - 1)]?.id ?? null);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected(rows[Math.max(idx - 1, 0)]?.id ?? null);
      } else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected]);

  const advance = (id: string) => {
    const idx = rows.findIndex((r) => r.id === id);
    setSelected(rows[idx + 1]?.id ?? null);
  };

  const pending = counts.data?.pending;
  const emptyMessage =
    filter === "todo"
      ? "All caught up."
      : filter === "pending"
        ? "Nothing pending. Pending transactions can be categorized once the bank posts them."
        : "Nothing here.";

  return (
    <>
      <PageHeader
        title="Categorize"
        subtitle="Assign each bank transaction to an account, split it, or match it."
        actions={
          <>
            <Select
              aria-label="Bank account"
              value={bankId}
              onChange={(e) => set({ account: e.target.value || undefined })}
              className="w-auto"
            >
              <option value="">All accounts</option>
              {(banks.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} {b.unreviewed ? `(${b.unreviewed})` : ""}
                </option>
              ))}
            </Select>
            <Link to="/o/$orgId/banking/import" params={{ orgId }}>
              <Button variant="secondary">Import</Button>
            </Link>
          </>
        }
      />
      <ErrorText error={list.error} />
      <div className="overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <FilterPills
            value={filter}
            onChange={(v) => set({ status: v === "all" ? undefined : v })}
            options={[
              { value: "all", label: "All", count: counts.data?.all },
              { value: "todo", label: "To categorize", count: counts.data?.to_categorize },
              { value: "pending", label: "Pending", count: pending?.count },
              { value: "categorized", label: "Categorized", count: counts.data?.categorized },
              { value: "excluded", label: "Excluded", count: counts.data?.excluded },
            ]}
          />
          <Input
            aria-label="Search"
            placeholder="Search transactions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
        </div>
        {filter === "todo" && pending && pending.count > 0 && (
          <p className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/40">
            {pending.count} pending transaction{pending.count === 1 ? "" : "s"} ({money(pending.total)}) will
            be ready once they post.{" "}
            <button type="button" className="underline" onClick={() => set({ status: "pending" })}>
              View pending
            </button>
          </p>
        )}
        {list.isLoading || accounts.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">{emptyMessage}</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((t) => (
              <TxnRow
                key={t.id}
                t={t}
                bankName={bankId ? null : (bankName.get(t.bank_account_id) ?? null)}
                accounts={accounts.data ?? []}
                open={selected === t.id}
                onToggle={() => setSelected(selected === t.id ? null : t.id)}
                onDone={() => advance(t.id)}
              />
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="p-3 text-center">
            <Button
              variant="secondary"
              loading={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500 touch:hidden">j/k to move · Enter to save · Esc to close</p>
    </>
  );
}

function TxnRow({
  t,
  bankName,
  accounts,
  open,
  onToggle,
  onDone,
}: {
  t: BankTxn;
  bankName: string | null;
  accounts: Account[];
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const orgId = useOrgId();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const sug = t.suggestion;
  const sugAccount = sug?.account_id ? accounts.find((a) => a.id === sug.account_id) : null;
  const fromReceipt = sug?.source === "receipt";
  const receiptIds = t.receipt_id ? [t.receipt_id] : t.suggested_receipt_ids;
  const sugTransfer = sug?.transfer_account_id
    ? accounts.find((a) => a.id === sug.transfer_account_id)
    : null;
  return (
    <li ref={ref} className={cx(open && "bg-zinc-50 dark:bg-zinc-800/40")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
        aria-expanded={open}
      >
        <span className="w-24 shrink-0 whitespace-nowrap text-zinc-500">{fmtDate(t.date)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {t.payee && t.payee !== t.description ? `${t.payee} · ${t.description}` : t.description}
          </span>
          <span className="flex flex-wrap gap-1.5 text-xs text-zinc-500">
            {bankName && <span>{bankName}</span>}
            {t.is_pending && <Badge tone="blue">Pending</Badge>}
            {t.review_item_id && <Badge tone="amber">In review queue</Badge>}
            {t.status === "new" && !t.review_item_id && sugAccount && (
              <span>
                {fromReceipt ? "From receipt" : "Suggested"}: {sugAccount.name}
                {sug?.source === "rule" && sug.rule_name ? ` (rule: ${sug.rule_name})` : ""}
              </span>
            )}
            {t.status === "new" && !t.review_item_id && sugTransfer && (
              <span>
                {sug?.source === "payout" && sug.payout_arrival_date
                  ? `Stripe payout ${fmtDate(sug.payout_arrival_date)}: transfer from ${sugTransfer.name}`
                  : `Suggested transfer: ${sugTransfer.name}`}
              </span>
            )}
            {receiptIds.length > 0 && (
              <Badge tone={t.receipt_id ? "green" : "amber"}>
                <span aria-hidden="true">🧾 </span>
                {t.receipt_id ? "Receipt" : "Receipt suggested"}
              </Badge>
            )}
            {t.status === "matched" && <Badge tone="blue">Matched</Badge>}
            {t.status === "categorized" && <Badge tone="green">Categorized</Badge>}
            {t.status === "excluded" && <Badge tone="zinc">Excluded</Badge>}
          </span>
        </span>
        <Amount cents={t.amount} className="shrink-0 font-medium" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <p className="break-words text-sm text-zinc-700 dark:text-zinc-300">
            {t.payee && t.payee !== t.description ? `${t.payee} · ${t.description}` : t.description}
          </p>
          {receiptIds.map((id) => (
            <TxnReceipt key={id} receiptId={id} t={t} />
          ))}
          {t.status === "new" && !t.review_item_id ? (
            <Editor key={JSON.stringify(sug)} t={t} accounts={accounts} onDone={onDone} />
          ) : (
            <Done t={t} orgId={orgId} />
          )}
          <Attachments targetType="bank_transaction" targetId={t.id} />
        </div>
      )}
    </li>
  );
}

/** The receipt behind a row: thumbnail and details, fetched when the row opens. */
function TxnReceipt({ receiptId, t }: { receiptId: string; t: BankTxn }) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const invalidateReceipts = useInvalidateReceipts();
  const q = useReceipt(orgId, receiptId);
  const r = q.data;
  const matched = t.receipt_id === receiptId;
  const act = useMutation({
    mutationFn: (kind: "match" | "unmatch") =>
      kind === "match"
        ? unwrap(
            api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/match", {
              params: { path: { orgId, receiptId } },
              body: { bank_transaction_id: t.id },
            }),
          )
        : unwrap(
            api.POST("/api/v1/orgs/{orgId}/receipts/{receiptId}/unmatch", {
              params: { path: { orgId, receiptId } },
            }),
          ),
    onSuccess: () => invalidateReceipts(orgId),
  });
  if (q.isLoading) return <Loading />;
  if (!r) return <ErrorText error={q.error} />;
  return (
    <div className="space-y-2 rounded-md bg-white p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-start gap-3">
        <Thumb r={r} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {matched ? "Receipt" : "Possible receipt"}: {r.merchant || "(no merchant)"}
            {r.amount != null && <> · {money(r.amount)}</>}
          </p>
          {r.business_purpose && <p className="break-words">Purpose: {r.business_purpose}</p>}
          {r.attendees && <p className="break-words">Attendees: {r.attendees}</p>}
          <Link
            to="/o/$orgId/banking/receipts/$receiptId"
            params={{ orgId, receiptId }}
            className="text-xs underline"
          >
            Open receipt
          </Link>
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {!matched && (
            <Button
              size="sm"
              loading={act.isPending && act.variables === "match"}
              onClick={() => act.mutate("match")}
            >
              Confirm receipt
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            loading={act.isPending && act.variables === "unmatch"}
            onClick={() => act.mutate("unmatch")}
          >
            Not this receipt
          </Button>
        </div>
      )}
      <ErrorText error={act.error} />
    </div>
  );
}

function useInvalidate() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["bank-txns", orgId] }),
      qc.invalidateQueries({ queryKey: ["bank-accounts", orgId] }),
      qc.invalidateQueries({ queryKey: ["accounts", orgId] }),
      qc.invalidateQueries({ queryKey: ["review", orgId] }),
      qc.invalidateQueries({ queryKey: ["entries", orgId] }),
      // Categorizing confirms a suggested receipt.
      qc.invalidateQueries({ queryKey: ["receipts", orgId] }),
    ]);
  };
}

function Done({ t, orgId }: { t: BankTxn; orgId: string }) {
  const { canWrite } = useRole();
  const invalidate = useInvalidate();
  const undo = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/undo", {
          params: { path: { orgId, txnId: t.id } },
          body: {},
        }),
      ),
    onSuccess: invalidate,
  });
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {t.entry_id && (
        <Link
          to="/o/$orgId/accounting/entries/$entryId"
          params={{ orgId, entryId: t.entry_id }}
          className="underline"
        >
          View entry
        </Link>
      )}
      {t.review_item_id && (
        <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
          Open review queue
        </Link>
      )}
      {canWrite && (
        <Button size="sm" variant="secondary" loading={undo.isPending} onClick={() => undo.mutate()}>
          {t.status === "excluded" ? "Restore" : "Undo"}
        </Button>
      )}
      <ErrorText error={undo.error} />
    </div>
  );
}

interface SplitLine {
  key: number;
  account_id: string;
  amount: string;
}
let k = 0;

function Editor({ t, accounts, onDone }: { t: BankTxn; accounts: Account[]; onDone: () => void }) {
  const orgId = useOrgId();
  const org = useOrg();
  const { canWrite, isOwner } = useRole();
  const invalidate = useInvalidate();
  const sug = t.suggestion;
  const [mode, setMode] = useState<Mode>(sug?.transfer_account_id ? "transfer" : "categorize");
  const [account, setAccount] = useState(sug?.account_id ?? "");
  const [transferTo, setTransferTo] = useState(sug?.transfer_account_id ?? "");
  const [memo, setMemo] = useState(sug?.memo ?? "");
  const [makeRule, setMakeRule] = useState(false);
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const abs = Math.abs(t.amount);
  const [splits, setSplits] = useState<SplitLine[]>([
    { key: ++k, account_id: sug?.account_id ?? "", amount: centsToDecimal(abs) },
    { key: ++k, account_id: "", amount: "" },
  ]);
  const s = org.data?.settings;
  const soft = Boolean(s?.soft_lock_date && t.date <= s.soft_lock_date);
  const bankLedger = useBankAccounts(orgId).data?.find((b) => b.id === t.bank_account_id)?.ledger_account_id;
  const others = accounts.filter((a) => a.id !== bankLedger);

  const candidates = useQuery({
    queryKey: ["match-candidates", orgId, t.id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/match-candidates", {
          params: { path: { orgId, txnId: t.id } },
        }),
      ),
    enabled: mode === "match",
  });

  const splitParsed = splits.map((x) => (x.amount.trim() ? tryParseCents(x.amount) : 0));
  const splitTotal = splitParsed.reduce<number>((a, b) => a + (b ?? 0), 0);
  const lock = note.trim() ? { lock_override_note: note } : {};

  const act = useMutation({
    mutationFn: async (kind: Mode | "exclude") => {
      const path = { orgId, txnId: t.id };
      if (kind === "exclude")
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/exclude", { params: { path } }),
        );
      if (kind === "transfer") {
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/transfer", {
            params: { path },
            body: { account_id: transferTo, memo: memo || null, ...lock },
          }),
        );
      }
      if (kind === "match") throw new Error("Choose an entry to match.");
      const body =
        kind === "split"
          ? {
              splits: splits
                .map((x, i) => ({ account_id: x.account_id, amount: splitParsed[i] ?? 0 }))
                .filter((x) => x.account_id && x.amount > 0),
              memo: memo || null,
              contact_id: contact || null,
              ...lock,
            }
          : {
              splits: [{ account_id: account, amount: abs }],
              memo: memo || null,
              contact_id: contact || null,
              ...lock,
            };
      const r = await unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/categorize", { params: { path }, body }),
      );
      if (makeRule && kind === "categorize") {
        const words = (t.payee || t.description)
          .split(/\s+/)
          .filter((w) => /[a-z]/i.test(w))
          .slice(0, 2)
          .join(" ");
        await unwrap(
          api.POST("/api/v1/orgs/{orgId}/rules", {
            params: { path: { orgId } },
            body: {
              name: words || t.description.slice(0, 40),
              conditions: { description_contains: words, direction: t.amount < 0 ? "out" : "in" },
              actions: { account_id: account, memo: memo || null, auto_post: false },
            },
          }),
        );
      }
      return r;
    },
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const match = useMutation({
    mutationFn: (entryId: string) =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/match", {
          params: { path: { orgId, txnId: t.id } },
          body: { entry_id: entryId },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });

  if (!canWrite) return <p className="text-sm text-zinc-500">Your role is read-only.</p>;
  if (t.is_pending)
    return (
      <Alert kind="info">
        This transaction is still pending at the bank. It can be categorized once it posts.
      </Alert>
    );

  const canSave =
    mode === "categorize"
      ? Boolean(account)
      : mode === "split"
        ? splitTotal === abs &&
          splitParsed.every((p) => p !== null) &&
          splits.filter((x) => x.account_id).length >= 1
        : mode === "transfer"
          ? Boolean(transferTo)
          : false;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) act.mutate(mode);
      }}
    >
      <div className="flex flex-wrap gap-1 text-sm" role="tablist">
        {(["categorize", "split", "transfer", "match", "payment"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx(
              "rounded px-2.5 py-1 capitalize touch:min-h-11 touch:px-3",
              mode === m ? "bg-brand-600 text-white" : "hover:bg-zinc-200 dark:hover:bg-zinc-700",
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "categorize" && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
          <AccountSelect
            aria-label="Category"
            accounts={others}
            value={account}
            onChange={setAccount}
            autoFocus
          />
          <Input
            aria-label="Memo"
            placeholder="Memo (optional)"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <div className="sm:col-span-2">
            <ContactPicker
              kind={t.amount > 0 ? "customer" : "vendor"}
              value={contact}
              onChange={setContact}
            />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
            Create a rule from this (suggests this account for similar transactions)
          </label>
        </div>
      )}
      {mode === "split" && (
        <div className="space-y-2">
          {splits.map((x, i) => (
            <div key={x.key} className="flex gap-2">
              <div className="min-w-0 flex-1">
                <AccountSelect
                  aria-label={`Split ${i + 1} account`}
                  accounts={others}
                  value={x.account_id}
                  onChange={(id) =>
                    setSplits((ss) => ss.map((y) => (y.key === x.key ? { ...y, account_id: id } : y)))
                  }
                />
              </div>
              <Input
                aria-label={`Split ${i + 1} amount`}
                inputMode="decimal"
                placeholder="0.00"
                className="w-28 shrink-0 text-right num sm:w-32"
                value={x.amount}
                onChange={(e) =>
                  setSplits((ss) => ss.map((y) => (y.key === x.key ? { ...y, amount: e.target.value } : y)))
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSplits((ss) => [...ss, { key: ++k, account_id: "", amount: "" }])}
            >
              + Add split
            </Button>
            <span
              className={
                splitTotal === abs
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-red-700 dark:text-red-400"
              }
            >
              {splitTotal === abs ? "Splits add up" : `Remaining ${money(abs - splitTotal)}`}
            </span>
          </div>
          <Input
            aria-label="Memo"
            placeholder="Memo (optional)"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      )}
      {mode === "transfer" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <AccountSelect
            aria-label="Transfer account"
            accounts={others}
            types={["asset", "liability"]}
            value={transferTo}
            onChange={setTransferTo}
            placeholder={t.amount < 0 ? "Transfer to…" : "Transfer from…"}
          />
          <p className="text-xs text-zinc-500 sm:self-center">
            If the other side was already imported, both are linked to one entry. Otherwise it will be matched
            when it arrives.
          </p>
        </div>
      )}
      {mode === "match" && (
        <div className="text-sm">
          {candidates.isLoading ? (
            <Loading />
          ) : !candidates.data?.data.length ? (
            <p className="text-zinc-500">
              No posted entries with this amount on this account within 30 days.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {candidates.data.data.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span>
                    {fmtDate(c.date)} · {c.memo || "(no memo)"}{" "}
                    <span className="text-zinc-400">({c.source})</span>
                  </span>
                  <Button
                    size="sm"
                    loading={match.isPending && match.variables === c.id}
                    onClick={() => match.mutate(c.id)}
                  >
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {mode === "payment" && <PaymentFromTxn t={t} onDone={onDone} />}
      {soft && isOwner && (
        <Textarea
          aria-label="Lock override note"
          rows={2}
          placeholder="This date is in a locked period. Explain why to post anyway."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <ErrorText error={act.error ?? match.error} />
      <div className="flex flex-wrap gap-2">
        {mode !== "match" && mode !== "payment" && (
          <Button
            type="submit"
            size="sm"
            disabled={!canSave}
            loading={act.isPending && act.variables !== "exclude"}
          >
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          loading={act.isPending && act.variables === "exclude"}
          onClick={() => act.mutate("exclude")}
        >
          Exclude
        </Button>
      </div>
    </form>
  );
}

/** Record an invoice payment (deposit) or bill payment (withdrawal) from this transaction. */
function PaymentFromTxn({ t, onDone }: { t: BankTxn; onDone: () => void }) {
  const orgId = useOrgId();
  const invalidate = useInvalidate();
  const received = t.amount > 0;
  const kind = received ? "customer" : "vendor";
  const [contact, setContact] = useState("");
  const [apply, setApply] = useState<Record<string, string>>({});
  const docs = useQuery({
    queryKey: ["open-docs", orgId, received ? "invoice" : "bill", contact],
    enabled: Boolean(contact),
    queryFn: async () =>
      received
        ? (
            await unwrap(
              api.GET("/api/v1/orgs/{orgId}/invoices", {
                params: { path: { orgId }, query: { open: "true", customer_id: contact } },
              }),
            )
          ).data.map((d) => ({ id: d.id, label: d.number, balance: d.balance_due }))
        : (
            await unwrap(
              api.GET("/api/v1/orgs/{orgId}/bills", {
                params: { path: { orgId }, query: { open: "true", vendor_id: contact } },
              }),
            )
          ).data.map((d) => ({ id: d.id, label: d.bill_number || d.issue_date, balance: d.balance_due })),
  });
  useEffect(() => {
    // Prefill: oldest documents first until the transaction amount is used up.
    if (!docs.data) return;
    let left = Math.abs(t.amount);
    const next: Record<string, string> = {};
    for (const d of docs.data) {
      if (left <= 0) break;
      const x = Math.min(left, d.balance);
      next[d.id] = centsToDecimal(x);
      left -= x;
    }
    setApply(next);
  }, [docs.data, t.amount]);
  const applied = Object.values(apply).reduce((s, v) => s + (tryParseCents(v || "0") ?? 0), 0);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/bank-transactions/{txnId}/record-payment", {
          params: { path: { orgId, txnId: t.id } },
          body: {
            contact_id: contact,
            applications: Object.entries(apply)
              .map(([document_id, v]) => ({ document_id, amount: tryParseCents(v || "0") ?? 0 }))
              .filter((x) => x.amount > 0),
          },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  return (
    <div className="space-y-2 text-sm">
      <ContactPicker kind={kind} value={contact} onChange={setContact} />
      {contact && docs.data && docs.data.length === 0 && (
        <p className="text-zinc-500">
          No open {received ? "invoices" : "bills"}; the amount becomes a credit.
        </p>
      )}
      {docs.data?.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-2">
          <span>
            {d.label} <span className="text-zinc-500">· open {money(d.balance)}</span>
          </span>
          <Input
            aria-label={`Apply to ${d.label}`}
            inputMode="decimal"
            className="w-28 text-right num"
            value={apply[d.id] ?? ""}
            onChange={(e) => setApply({ ...apply, [d.id]: e.target.value })}
          />
        </div>
      ))}
      {applied > Math.abs(t.amount) && (
        <Alert kind="error">More than the transaction amount is applied.</Alert>
      )}
      <ErrorText error={save.error} />
      <Button
        size="sm"
        disabled={!contact || applied > Math.abs(t.amount)}
        loading={save.isPending}
        onClick={() => save.mutate()}
      >
        Record {received ? "payment received" : "bill payment"}
      </Button>
    </div>
  );
}
