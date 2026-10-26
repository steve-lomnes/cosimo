import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api, unwrap } from "../api/client";
import { AccountSelect } from "../components/AccountSelect";
import { Attachments } from "../components/Attachments";
import { RecurringList } from "../components/recurring";
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
  Modal,
  PageHeader,
  Select,
  Table,
  Tabs,
  Textarea,
  td,
  th,
} from "../components/ui";
import { centsToDecimal, fmtDate, fmtDateTime, money, todayIso, tryParseCents } from "../lib/format";
import {
  type Account,
  DOCUMENT_SOURCES,
  type Entry,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type SubmitResult,
  useAccounts,
} from "../lib/ledger";
import { useOrg, useOrgId, useRole } from "../lib/org";

type EntrySearch = { account?: string; status?: string; q?: string; from?: string; to?: string };

export function validateEntrySearch(s: Record<string, unknown>): EntrySearch {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { account: str(s.account), status: str(s.status), q: str(s.q), from: str(s.from), to: str(s.to) };
}

// ----------------------------------------------------------------------------- list

export function EntriesPage() {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const search = useSearch({ strict: false }) as EntrySearch;
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onRecurring = pathname.endsWith("/recurring");
  const accounts = useAccounts(orgId);
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const [q, setQ] = useState(search.q ?? "");
  const setSearch = (p: Partial<EntrySearch>) =>
    navigate({ to: ".", search: { ...search, ...p } as never, replace: true });

  const list = useInfiniteQuery({
    queryKey: ["entries", orgId, search],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/entries", {
          params: {
            path: { orgId },
            query: {
              account_id: search.account,
              status: search.status,
              q: search.q,
              from: search.from,
              to: search.to,
              limit: 50,
              cursor: pageParam ?? undefined,
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor,
    enabled: !onRecurring,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const acct = search.account ? byId.get(search.account) : undefined;

  return (
    <>
      <PageHeader
        title="Journal entries"
        subtitle={
          onRecurring
            ? "Entries are created each morning when a template is due."
            : acct
              ? `Entries touching ${acct.code} ${acct.name}`
              : "Every change to the books, newest first."
        }
        actions={
          canWrite &&
          (onRecurring ? (
            <Link to="/o/$orgId/accounting/entries/recurring/new" params={{ orgId }}>
              <Button>New recurring entry</Button>
            </Link>
          ) : (
            <Link to="/o/$orgId/accounting/entries/new" params={{ orgId }}>
              <Button>New entry</Button>
            </Link>
          ))
        }
      />
      <Tabs
        value={onRecurring ? "recurring" : "entries"}
        onChange={(v) =>
          navigate({
            to:
              v === "recurring"
                ? `/o/${orgId}/accounting/entries/recurring`
                : `/o/${orgId}/accounting/entries`,
          })
        }
        tabs={[
          { value: "entries", label: "Entries" },
          { value: "recurring", label: "Recurring" },
        ]}
      />
      {onRecurring ? (
        <RecurringList kind="entry" />
      ) : (
        <>
          <form
            className="mb-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch({ q: q || undefined });
            }}
          >
            <Input
              aria-label="Search memo"
              placeholder="Search memo"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-xs"
            />
            <Select
              aria-label="Status"
              value={search.status ?? ""}
              onChange={(e) => setSearch({ status: e.target.value || undefined })}
              className="w-auto"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <div className="w-64">
              <AccountSelect
                aria-label="Account"
                accounts={accounts.data ?? []}
                value={search.account ?? ""}
                onChange={(id) => setSearch({ account: id || undefined })}
                placeholder="All accounts"
              />
            </div>
            <Input
              aria-label="From"
              type="date"
              value={search.from ?? ""}
              onChange={(e) => setSearch({ from: e.target.value || undefined })}
              className="w-auto"
            />
            <Input
              aria-label="To"
              type="date"
              value={search.to ?? ""}
              onChange={(e) => setSearch({ to: e.target.value || undefined })}
              className="w-auto"
            />
          </form>
          <ErrorText error={list.error} />
          <Card>
            {list.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-zinc-500">No entries match.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>#</th>
                    <th className={th}>Memo</th>
                    <th className={`${th} hidden md:table-cell`}>Accounts</th>
                    <th className={`${th} hidden sm:table-cell`}>Source</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map((e) => (
                    <tr key={e.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <td className={`${td} whitespace-nowrap`}>{fmtDate(e.date)}</td>
                      <td className={`${td} num text-zinc-500`}>{e.chain_seq ?? ""}</td>
                      <td className={td}>
                        <Link
                          to="/o/$orgId/accounting/entries/$entryId"
                          params={{ orgId, entryId: e.id }}
                          className="hover:underline"
                        >
                          {e.memo || <span className="text-zinc-400">(no memo)</span>}
                        </Link>
                        {e.reversed_by_entry_id && <Badge tone="zinc">Reversed</Badge>}
                      </td>
                      <td className={`${td} hidden text-zinc-500 md:table-cell`}>
                        {[...new Set(e.lines.map((l) => byId.get(l.account_id)?.name ?? "?"))]
                          .slice(0, 3)
                          .join(", ")}
                      </td>
                      <td className={`${td} hidden text-zinc-500 sm:table-cell`}>
                        {SOURCE_LABEL[e.source_type] ?? e.source_type}
                      </td>
                      <td className={td}>
                        <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                      </td>
                      <td className={`${td} text-right`}>
                        {acct ? (
                          <Amount
                            cents={e.lines
                              .filter((l) => l.account_id === acct.id)
                              .reduce((s, l) => s + l.amount, 0)}
                          />
                        ) : (
                          <Amount cents={e.total} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
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
          </Card>
        </>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------- editor

export interface DraftLine {
  key: number;
  account_id: string;
  debit: string;
  credit: string;
  description: string;
  /** Not edited here, but kept, so editing an entry doesn't drop its lines' contacts. */
  contact_id: string | null;
}

let lineKey = 0;
export const blank = (): DraftLine => ({
  key: ++lineKey,
  account_id: "",
  debit: "",
  credit: "",
  description: "",
  contact_id: null,
});

export function toDraftLines(e: Entry | null, negate = false): DraftLine[] {
  if (!e) return [blank(), blank()];
  return e.lines.map((l) => {
    const amt = negate ? -l.amount : l.amount;
    return {
      key: ++lineKey,
      account_id: l.account_id,
      debit: amt > 0 ? centsToDecimal(amt) : "",
      credit: amt < 0 ? centsToDecimal(-amt) : "",
      description: l.description ?? "",
      contact_id: l.contact_id ?? null,
    };
  });
}

export function lineAmount(l: DraftLine): number | null {
  const d = l.debit.trim() ? tryParseCents(l.debit) : 0;
  const c = l.credit.trim() ? tryParseCents(l.credit) : 0;
  if (d === null || c === null) return null;
  return d - c;
}

/**
 * Balanced debit/credit line table, shared by the journal entry editor and recurring entry
 * templates. Shows its own totals row; the caller derives `invalid`/`diff` again from `lines` (via
 * `lineAmount`) for anything else it needs to show, the same way `LinesEditor` and `lineCents` split
 * the work for invoices and bills.
 */
export function JournalLinesEditor({
  lines,
  setLines,
}: {
  lines: DraftLine[];
  setLines: (f: (ls: DraftLine[]) => DraftLine[]) => void;
}) {
  const orgId = useOrgId();
  const accounts = useAccounts(orgId);
  const parsed = lines.map(lineAmount);
  const debits = parsed.reduce<number>((s, p) => s + (p && p > 0 ? p : 0), 0);
  const credits = parsed.reduce<number>((s, p) => s + (p && p < 0 ? -p : 0), 0);
  const diff = debits - credits;

  const update = (key: number, p: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const balanceLast = () => {
    if (!diff) return;
    setLines((ls) => {
      const idx = ls.findIndex((l) => !l.account_id && !l.debit && !l.credit);
      const target = idx >= 0 ? idx : ls.length;
      const next = idx >= 0 ? [...ls] : [...ls, blank()];
      const t = next[target]!;
      next[target] = {
        ...t,
        debit: diff < 0 ? centsToDecimal(-diff) : "",
        credit: diff > 0 ? centsToDecimal(diff) : "",
      };
      return next;
    });
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr>
            <th className={`${th} w-[40%]`}>Account</th>
            <th className={`${th} w-32 text-right`}>Debit</th>
            <th className={`${th} w-32 text-right`}>Credit</th>
            <th className={th}>Description</th>
            <th className={`${th} w-8`}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.key}>
              <td className="py-1 pr-2">
                <AccountSelect
                  aria-label={`Line ${i + 1} account`}
                  accounts={accounts.data ?? []}
                  value={l.account_id}
                  onChange={(id) => update(l.key, { account_id: id })}
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  aria-label={`Line ${i + 1} debit`}
                  inputMode="decimal"
                  className="text-right num"
                  value={l.debit}
                  onChange={(e) =>
                    update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })
                  }
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  aria-label={`Line ${i + 1} credit`}
                  inputMode="decimal"
                  className="text-right num"
                  value={l.credit}
                  onChange={(e) =>
                    update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })
                  }
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  aria-label={`Line ${i + 1} description`}
                  value={l.description}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && i === lines.length - 1) {
                      e.preventDefault();
                      setLines((ls) => [...ls, blank()]);
                    }
                  }}
                />
              </td>
              <td className="py-1 text-center">
                {lines.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    className="rounded p-1 text-zinc-400 hover:text-red-600"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-200 font-medium dark:border-zinc-800">
            <td className="py-2">
              <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blank()])}>
                + Add line
              </Button>
              {diff !== 0 && (
                <Button size="sm" variant="ghost" onClick={balanceLast}>
                  Balance
                </Button>
              )}
            </td>
            <td className="px-3 py-2 text-right num">{money(debits)}</td>
            <td className="px-3 py-2 text-right num">{money(credits)}</td>
            <td className="px-3 py-2" colSpan={2}>
              {diff === 0 ? (
                debits > 0 && <span className="text-emerald-700 dark:text-emerald-400">Balanced</span>
              ) : (
                <span className="text-red-700 dark:text-red-400">
                  Out of balance by {money(Math.abs(diff))}
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Journal entry editor. Used for new entries, drafts, and "edit" of posted entries (which
 * reverses the original and posts the corrected version).
 */
export function EntryEditor({
  initial,
  mode,
  onDone,
}: {
  initial: Entry | null;
  mode: "new" | "draft" | "replace";
  onDone: (r: { entryId: string; status: string; message?: string }) => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const org = useOrg();
  const { isOwner } = useRole();
  const accounts = useAccounts(orgId);
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [lines, setLines] = useState<DraftLine[]>(() => toDraftLines(initial));
  const [note, setNote] = useState("");

  const parsed = lines.map(lineAmount);
  const filled = lines.filter((l, i) => l.account_id && parsed[i]);
  const invalid = parsed.some((p) => p === null);
  const debits = parsed.reduce<number>((s, p) => s + (p && p > 0 ? p : 0), 0);
  const credits = parsed.reduce<number>((s, p) => s + (p && p < 0 ? -p : 0), 0);
  const diff = debits - credits;
  const s = org.data?.settings;
  const softLocked = Boolean(s?.soft_lock_date && date <= s.soft_lock_date);
  const hardLocked = Boolean(s?.hard_lock_date && date <= s.hard_lock_date);

  const payloadLines = () =>
    lines
      .map((l, i) => ({ l, amt: parsed[i] }))
      .filter(({ l, amt }) => l.account_id && amt)
      .map(({ l, amt }) => ({
        account_id: l.account_id,
        amount: amt!,
        description: l.description || null,
        contact_id: l.contact_id,
      }));

  const invalidate = () =>
    qc
      .invalidateQueries({ queryKey: ["entries", orgId] })
      .then(() => qc.invalidateQueries({ queryKey: ["accounts", orgId] }));

  const save = useMutation({
    mutationFn: async (asDraft: boolean) => {
      const body = {
        date,
        memo: memo || null,
        lines: payloadLines(),
        lock_override_note: note || null,
      };
      if (mode === "replace") {
        const r = await unwrap(
          api.POST("/api/v1/orgs/{orgId}/entries/{entryId}/replace", {
            params: { path: { orgId, entryId: initial!.id } },
            body,
          }),
        );
        return r.replacement;
      }
      if (mode === "draft") {
        await unwrap(
          api.PATCH("/api/v1/orgs/{orgId}/entries/{entryId}", {
            params: { path: { orgId, entryId: initial!.id } },
            body,
          }),
        );
        if (asDraft)
          return { entry: { id: initial!.id }, status: "draft", review: null } as unknown as SubmitResult;
        return unwrap(
          api.POST("/api/v1/orgs/{orgId}/entries/{entryId}/submit", {
            params: { path: { orgId, entryId: initial!.id } },
            body: {},
          }),
        );
      }
      return unwrap(
        api.POST("/api/v1/orgs/{orgId}/entries", {
          params: { path: { orgId } },
          body: { ...body, draft: asDraft },
        }),
      );
    },
    onSuccess: async (r) => {
      await invalidate();
      onDone({
        entryId: r.entry.id,
        status: r.status,
        message: r.review ? `Sent to the review queue: ${r.review.reason}` : undefined,
      });
    },
  });

  if (accounts.isLoading) return <Loading />;
  const canPost =
    filled.length >= 2 && diff === 0 && !invalid && !hardLocked && (!softLocked || (isOwner && note.trim()));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canPost) save.mutate(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="Date">
          {(id) => (
            <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          )}
        </Field>
        <Field label="Memo">
          {(id) => (
            <Input
              id={id}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="What is this entry for?"
            />
          )}
        </Field>
      </div>

      <JournalLinesEditor lines={lines} setLines={setLines} />
      {invalid && <Alert kind="error">Amounts must be numbers with at most two decimal places.</Alert>}
      {hardLocked && (
        <Alert kind="error">
          The books are closed through {fmtDate(s!.hard_lock_date)}. Choose a later date.
        </Alert>
      )}
      {softLocked &&
        !hardLocked &&
        (isOwner ? (
          <Field
            label="Lock override note"
            hint={`The books are locked through ${fmtDate(s!.soft_lock_date)}. Explain why this entry belongs in a locked period.`}
          >
            {(id) => (
              <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} required />
            )}
          </Field>
        ) : (
          <Alert kind="error">
            The books are locked through {fmtDate(s!.soft_lock_date)}. Only an owner can post there.
          </Alert>
        ))}
      {mode === "replace" && (
        <Alert kind="info">
          Saving reverses the original entry and posts this corrected version. Both stay in the ledger.
        </Alert>
      )}
      <ErrorText error={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending && save.variables === false} disabled={!canPost}>
          {mode === "replace" ? "Save correction" : "Post entry"}
        </Button>
        {mode !== "replace" && (
          <Button
            variant="secondary"
            loading={save.isPending && save.variables === true}
            onClick={() => save.mutate(true)}
            disabled={invalid}
          >
            Save draft
          </Button>
        )}
      </div>
    </form>
  );
}

export function NewEntryPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="New journal entry"
        subtitle="Debits are positive, credits negative. Every entry must balance."
      />
      <Card>
        <EntryEditor
          initial={null}
          mode="new"
          onDone={(r) =>
            navigate({
              to: "/o/$orgId/accounting/entries/$entryId",
              params: { orgId, entryId: r.entryId },
              search: { msg: r.message } as never,
            })
          }
        />
      </Card>
    </>
  );
}

// ----------------------------------------------------------------------------- detail

export function EntryPage() {
  const orgId = useOrgId();
  const { entryId } = useParams({ strict: false }) as { entryId: string };
  const search = useSearch({ strict: false }) as { msg?: string };
  const { canWrite, isOwner } = useRole();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useAccounts(orgId);
  const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const [editing, setEditing] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [flash, setFlash] = useState<string | undefined>(search.msg);
  useEffect(() => setFlash(search.msg), [search.msg]);

  const entry = useQuery({
    queryKey: ["entry", orgId, entryId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/entries/{entryId}", { params: { path: { orgId, entryId } } })),
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["entry", orgId] });
    await qc.invalidateQueries({ queryKey: ["entries", orgId] });
    await qc.invalidateQueries({ queryKey: ["accounts", orgId] });
  };
  const del = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/api/v1/orgs/{orgId}/entries/{entryId}", { params: { path: { orgId, entryId } } })),
    onSuccess: async () => {
      await refresh();
      navigate({ to: "/o/$orgId/accounting/entries", params: { orgId } });
    },
  });

  if (entry.isLoading) return <Loading />;
  if (!entry.data) return <ErrorText error={entry.error ?? new Error("Entry not found")} />;
  const e = entry.data;
  const isDocument = DOCUMENT_SOURCES.includes(e.source_type);

  if (editing) {
    return (
      <>
        <PageHeader title={e.status === "posted" ? "Edit posted entry" : "Edit draft"} />
        <Card>
          <EntryEditor
            initial={e}
            mode={e.status === "posted" ? "replace" : "draft"}
            onDone={async (r) => {
              setEditing(false);
              await refresh();
              navigate({
                to: "/o/$orgId/accounting/entries/$entryId",
                params: { orgId, entryId: r.entryId },
                search: { msg: r.message } as never,
              });
            }}
          />
          <Button variant="ghost" className="mt-2" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={e.memo || "Journal entry"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
            {fmtDate(e.date)} · {SOURCE_LABEL[e.source_type] ?? e.source_type}
            {e.chain_seq && <span className="num">· #{e.chain_seq}</span>}
          </span>
        }
        actions={
          canWrite && (
            <>
              {e.status === "draft" && (
                <>
                  <Button onClick={() => setEditing(true)}>Edit</Button>
                  <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
                    Delete draft
                  </Button>
                </>
              )}
              {e.status === "posted" && !e.reversed_by_entry_id && !isDocument && (
                <>
                  <Button onClick={() => setEditing(true)}>Edit</Button>
                  <Button variant="secondary" onClick={() => setReversing(true)}>
                    Reverse
                  </Button>
                </>
              )}
              {!isDocument && (
                <Link
                  to="/o/$orgId/accounting/entries/recurring/new"
                  params={{ orgId }}
                  search={{ from: e.id }}
                >
                  <Button variant="secondary">Make recurring</Button>
                </Link>
              )}
            </>
          )
        }
      />
      <div className="space-y-4">
        {flash && <Alert kind="warn">{flash}</Alert>}
        {e.status === "pending_review" && (
          <Alert kind="warn">
            This entry is waiting in the{" "}
            <Link to="/o/$orgId/accounting/review" params={{ orgId }} className="underline">
              review queue
            </Link>{" "}
            and does not affect any balance yet.
          </Alert>
        )}
        {isDocument && e.status === "posted" && (
          <Alert kind="info">
            This entry belongs to a document. Change or void the document to correct it.
          </Alert>
        )}
        <ErrorText error={del.error} />
        <Card>
          <Table>
            <thead>
              <tr>
                <th className={th}>Account</th>
                <th className={`${th} text-right`}>Debit</th>
                <th className={`${th} text-right`}>Credit</th>
                <th className={th}>Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {e.lines.map((l) => {
                const a = byId.get(l.account_id) as Account | undefined;
                return (
                  <tr key={l.id}>
                    <td className={td}>{a ? `${a.code} · ${a.name}` : l.account_id}</td>
                    <td className={`${td} text-right num`}>{l.amount > 0 ? money(l.amount) : ""}</td>
                    <td className={`${td} text-right num`}>{l.amount < 0 ? money(-l.amount) : ""}</td>
                    <td className={`${td} text-zinc-500`}>{l.description}</td>
                  </tr>
                );
              })}
              <tr className="font-medium">
                <td className={td}>Total</td>
                <td className={`${td} text-right num`}>{money(e.total)}</td>
                <td className={`${td} text-right num`}>{money(e.total)}</td>
                <td />
              </tr>
            </tbody>
          </Table>
        </Card>
        <Card title="Attachments">
          <Attachments targetType="journal_entry" targetId={e.id} label="Add file" />
        </Card>
        <Card title="Details">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Detail k="Created">
              {fmtDateTime(e.created_at)} by {e.created_by_actor}
            </Detail>
            {e.posted_at && <Detail k="Posted">{fmtDateTime(e.posted_at)}</Detail>}
            {e.lock_override_note && <Detail k="Lock override note">{e.lock_override_note}</Detail>}
            {e.reverses_entry_id && (
              <Detail k="Reverses">
                <Link
                  to="/o/$orgId/accounting/entries/$entryId"
                  params={{ orgId, entryId: e.reverses_entry_id }}
                  className="underline"
                >
                  original entry
                </Link>
              </Detail>
            )}
            {e.reversed_by_entry_id && (
              <Detail k="Reversed by">
                <Link
                  to="/o/$orgId/accounting/entries/$entryId"
                  params={{ orgId, entryId: e.reversed_by_entry_id }}
                  className="underline"
                >
                  reversing entry
                </Link>
              </Detail>
            )}
            {e.entry_hash && (
              <Detail k="Chain hash">
                <code className="break-all text-xs">{e.entry_hash}</code>
              </Detail>
            )}
            {e.recurring_template_id && (
              <Detail k="Recurring template">
                <Link
                  to={`/o/${orgId}/accounting/entries/recurring/${e.recurring_template_id}`}
                  className="underline"
                >
                  From recurring template ›
                </Link>
              </Detail>
            )}
          </dl>
        </Card>
      </div>
      {reversing && (
        <ReverseModal
          entry={e}
          isOwner={isOwner}
          onClose={() => setReversing(false)}
          onDone={async (r) => {
            setReversing(false);
            await refresh();
            navigate({
              to: "/o/$orgId/accounting/entries/$entryId",
              params: { orgId, entryId: r.entry.id },
              search: { msg: r.review ? `Sent to the review queue: ${r.review.reason}` : undefined } as never,
            });
          }}
        />
      )}
    </>
  );
}

function Detail({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReverseModal({
  entry,
  isOwner,
  onClose,
  onDone,
}: {
  entry: Entry;
  isOwner: boolean;
  onClose: () => void;
  onDone: (r: SubmitResult) => void;
}) {
  const orgId = useOrgId();
  const org = useOrg();
  const [date, setDate] = useState(entry.date);
  const [note, setNote] = useState("");
  const s = org.data?.settings;
  const soft = Boolean(s?.soft_lock_date && date <= s.soft_lock_date);
  const rev = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/orgs/{orgId}/entries/{entryId}/reverse", {
          params: { path: { orgId, entryId: entry.id } },
          body: { date, lock_override_note: note || null },
        }),
      ),
    onSuccess: onDone,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Reverse entry"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={rev.isPending} onClick={() => rev.mutate()}>
            Reverse
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm">A new entry with every line negated will be posted and linked to this one.</p>
        <Field label="Reversal date">
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        {soft && isOwner && (
          <Field label="Lock override note">
            {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        )}
        <ErrorText error={rev.error} />
      </div>
    </Modal>
  );
}
