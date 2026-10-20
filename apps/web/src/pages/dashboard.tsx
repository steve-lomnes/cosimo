import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";
import { Amount, Badge, Card, cx, ErrorText, Loading, PageHeader, Table, td, th } from "../components/ui";
import { fmtDate, fmtDateTime, money } from "../lib/format";
import { useOrg, useOrgId } from "../lib/org";

type Dashboard = components["schemas"]["Dashboard"];

const CONNECTION_STATUS: Record<string, { label: string; tone: "amber" | "red" | "zinc" }> = {
  needs_reauth: { label: "Needs sign-in", tone: "amber" },
  error: { label: "Error", tone: "red" },
  disconnected: { label: "Disconnected", tone: "zinc" },
};

export function DashboardPage() {
  const orgId = useOrgId();
  const org = useOrg();
  const q = useQuery({
    queryKey: ["dashboard", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/dashboard", { params: { path: { orgId } } })),
  });
  const d = q.data;
  return (
    <>
      <PageHeader
        title={org.data?.name ?? "Dashboard"}
        subtitle={
          d ? `As of ${fmtDate(d.as_of)} · ${d.basis === "cash" ? "Cash" : "Accrual"} basis` : "Overview"
        }
      />
      <ErrorText error={q.error} />
      {q.isLoading || !d ? q.error ? null : <Loading /> : <DashboardBody d={d} orgId={orgId} />}
    </>
  );
}

function DashboardBody({ d, orgId }: { d: Dashboard; orgId: string }) {
  const cur = d.currency;
  return (
    <div className="space-y-4">
      <section aria-label="Needs attention" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          label="Transactions to categorize"
          value={d.bank_needs_review}
          detail={
            d.bank_pending.count > 0
              ? `+ ${d.bank_pending.count} pending · ${money(d.bank_pending.total, cur)}`
              : undefined
          }
          attention={d.bank_needs_review > 0}
          link={
            <Link
              to="/o/$orgId/banking/categorize"
              params={{ orgId }}
              search={{ status: "todo" } as never}
              className={tileLink}
            >
              Categorize
            </Link>
          }
        />
        {d.stale_receipts.count > 0 && (
          <Tile
            label="Unmatched receipts"
            value={d.stale_receipts.count}
            detail="In the inbox for over 30 days"
            attention
            link={
              <Link to="/o/$orgId/expenses/receipts" params={{ orgId }} className={tileLink}>
                Receipts
              </Link>
            }
          />
        )}
        <Tile
          label="Waiting for approval"
          value={d.review_pending}
          attention={d.review_pending > 0}
          link={
            <Link to="/o/$orgId/accounting/review" params={{ orgId }} className={tileLink}>
              Review queue
            </Link>
          }
        />
        <Tile
          label="Overdue invoices"
          value={d.overdue_invoices.count}
          detail={d.overdue_invoices.count ? money(d.overdue_invoices.total, cur) : undefined}
          attention={d.overdue_invoices.count > 0}
          tone="red"
          link={
            <Link to="/o/$orgId/sales/invoices" params={{ orgId }} className={tileLink}>
              Invoices
            </Link>
          }
        />
        <Tile
          label={`Bills overdue or due in ${d.bills.due_soon.days} days`}
          value={d.bills.overdue.count + d.bills.due_soon.count}
          detail={
            d.bills.overdue.count + d.bills.due_soon.count
              ? `${money(d.bills.overdue.total + d.bills.due_soon.total, cur)}${
                  d.bills.overdue.count ? ` · ${d.bills.overdue.count} overdue` : ""
                }`
              : undefined
          }
          attention={d.bills.overdue.count > 0}
          tone="red"
          link={
            <Link to="/o/$orgId/expenses/bills" params={{ orgId }} className={tileLink}>
              Bills
            </Link>
          }
        />
        <Tile
          label="Bank connections needing attention"
          value={d.bank_connections.length}
          attention={d.bank_connections.length > 0}
          link={
            <Link to="/o/$orgId/banking/accounts" params={{ orgId }} className={tileLink}>
              Bank feeds
            </Link>
          }
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Cash"
          actions={
            <Link to="/o/$orgId/banking/accounts" params={{ orgId }} className={tileLink}>
              Bank accounts
            </Link>
          }
        >
          <p className="num text-2xl font-semibold tracking-tight" data-testid="cash-total">
            <Amount cents={d.cash.total} currency={cur} />
          </p>
          <p className="mb-3 text-xs text-zinc-500">Across bank and cash accounts</p>
          {d.cash.accounts.length === 0 && d.credit_cards.accounts.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No bank accounts yet.{" "}
              <Link to="/o/$orgId/banking/accounts" params={{ orgId }} className="underline">
                Add one
              </Link>
              .
            </p>
          ) : (
            <Table>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {d.cash.accounts.map((a) => (
                  <AccountRow key={a.id} a={a} cur={cur} />
                ))}
                {d.credit_cards.accounts.length > 0 && (
                  <>
                    <tr>
                      <th className={cx(th, "pt-4")} colSpan={2}>
                        Credit cards (owed)
                      </th>
                    </tr>
                    {d.credit_cards.accounts.map((a) => (
                      <AccountRow key={a.id} a={a} cur={cur} />
                    ))}
                    <tr className="font-medium">
                      <td className={td}>Total owed</td>
                      <td className={cx(td, "text-right")}>
                        <Amount cents={d.credit_cards.total} currency={cur} />
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Income and expense"
          actions={
            <Link
              to="/o/$orgId/reports"
              params={{ orgId }}
              search={{ report: "profit_and_loss" } as never}
              className={tileLink}
            >
              Profit and loss
            </Link>
          }
        >
          <Table>
            <thead>
              <tr>
                <th className={th}>
                  <span className="sr-only">Period</span>
                </th>
                <th className={cx(th, "text-right")}>Income</th>
                <th className={cx(th, "text-right")}>Expense</th>
                <th className={cx(th, "text-right")}>Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {(
                [
                  ["This month", d.month],
                  ["Year to date", d.year_to_date],
                ] as const
              ).map(([label, p]) => (
                <tr key={label}>
                  <td className={td}>
                    <div className="font-medium">{label}</div>
                    <div className="text-xs text-zinc-500">
                      {fmtDate(p.from)} to {fmtDate(p.to)}
                    </div>
                  </td>
                  <td className={cx(td, "text-right")}>
                    <Amount cents={p.income} currency={cur} />
                  </td>
                  <td className={cx(td, "text-right")}>
                    <Amount cents={p.expense} currency={cur} />
                  </td>
                  <td className={cx(td, "text-right font-medium")}>
                    <Amount cents={p.net} currency={cur} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {(d.overdue_invoices.count > 0 || d.bank_connections.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {d.overdue_invoices.count > 0 && (
            <Card
              title="Overdue invoices"
              actions={
                <Link to="/o/$orgId/sales/invoices" params={{ orgId }} className={tileLink}>
                  All invoices
                </Link>
              }
            >
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Invoice</th>
                    <th className={cx(th, "hidden sm:table-cell")}>Due</th>
                    <th className={cx(th, "text-right")}>Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {d.overdue_invoices.top.map((i) => (
                    <tr key={i.id}>
                      <td className={td}>
                        <Link
                          to="/o/$orgId/sales/invoices/$invoiceId"
                          params={{ orgId, invoiceId: i.id }}
                          className="font-medium hover:underline"
                        >
                          {i.number}
                        </Link>
                        <div className="text-xs text-zinc-500">{i.customer_name}</div>
                      </td>
                      <td className={cx(td, "hidden whitespace-nowrap sm:table-cell")}>
                        {fmtDate(i.due_date)}
                        <div className="text-xs text-red-700 dark:text-red-400">
                          {i.days_overdue} {i.days_overdue === 1 ? "day" : "days"} late
                        </div>
                      </td>
                      <td className={cx(td, "text-right")}>
                        <Amount cents={i.balance_due} currency={cur} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {d.overdue_invoices.count > d.overdue_invoices.top.length && (
                <p className="mt-2 text-xs text-zinc-500">
                  Showing the {d.overdue_invoices.top.length} largest of {d.overdue_invoices.count}.
                </p>
              )}
            </Card>
          )}
          {d.bank_connections.length > 0 && (
            <Card
              title="Bank connections"
              actions={
                <Link to="/o/$orgId/banking/accounts" params={{ orgId }} className={tileLink}>
                  Bank feeds
                </Link>
              }
            >
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {d.bank_connections.map((c) => {
                  const s = CONNECTION_STATUS[c.status] ?? { label: c.status, tone: "zinc" as const };
                  return (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <div className="font-medium">{c.institution_name ?? "Bank connection"}</div>
                        <div className="text-xs text-zinc-500">
                          {c.last_successful_sync_at
                            ? `Last synced ${fmtDateTime(c.last_successful_sync_at)}`
                            : "Never synced"}
                          {c.error_code ? ` · ${c.error_code}` : ""}
                        </div>
                      </div>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

const tileLink = "text-xs font-medium text-brand-700 hover:underline dark:text-gold-400";

function Tile({
  label,
  value,
  detail,
  attention,
  tone = "amber",
  link,
}: {
  label: string;
  value: number;
  detail?: string;
  attention: boolean;
  tone?: "amber" | "red";
  link: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex flex-col justify-between gap-2 rounded-lg bg-white p-3 ring-1 dark:bg-zinc-900",
        attention
          ? tone === "red"
            ? "ring-red-300 dark:ring-red-900"
            : "ring-amber-300 dark:ring-amber-800"
          : "ring-zinc-200 dark:ring-zinc-800",
      )}
    >
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p
          className={cx(
            "num mt-1 text-2xl font-semibold",
            attention &&
              (tone === "red" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400"),
          )}
        >
          {value}
        </p>
        {detail && <p className="num text-xs text-zinc-500">{detail}</p>}
      </div>
      <div>{link}</div>
    </div>
  );
}

function AccountRow({ a, cur }: { a: Dashboard["cash"]["accounts"][number]; cur: string }) {
  return (
    <tr>
      <td className={td}>
        <span className="font-medium">{a.name}</span>
        {a.mask && <span className="ml-1 text-xs text-zinc-500">··{a.mask}</span>}
        {a.unreviewed > 0 && (
          <span className="ml-2">
            <Badge tone="amber">{a.unreviewed} to categorize</Badge>
          </span>
        )}
        {a.pending > 0 && (
          <span className="ml-2">
            <Badge tone="zinc">{a.pending} pending</Badge>
          </span>
        )}
      </td>
      <td className={cx(td, "text-right")}>
        <Amount cents={a.balance} currency={cur} />
      </td>
    </tr>
  );
}
