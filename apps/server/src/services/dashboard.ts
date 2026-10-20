/**
 * Dashboard (SPEC §9.2): cash position, month and year-to-date income and expense, work waiting
 * (review queue, Categorize, receipts left in the inbox), overdue invoices, bills coming due, and
 * bank connections that need attention. All amounts are integer cents.
 */
import { org } from "@cosimo/db";
import { addDays, diffDays, fiscalYearStart, today } from "@cosimo/shared";
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { type SyncStatusView, syncStatusView } from "./bank-sync.ts";
import { listBankAccounts } from "./banking.ts";
import { accountMap, settingsRow } from "./ledger.ts";
import { staleReceiptCount } from "./receipts.ts";
import { runReport } from "./reports.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgHandle["db"];

export const BILLS_DUE_SOON_DAYS = 7;

/** A cash or card account, with its bank feed's sync status (null fields when it has none). */
export interface DashboardAccount extends SyncStatusView {
  id: string;
  name: string;
  kind: string;
  mask: string | null;
  ledger_account_id: string;
  /** Normal sign: money in the account, or amount owed on a card. */
  balance: number;
  unreviewed: number;
  pending: number;
}

export interface PnlSummary {
  from: string;
  to: string;
  income: number;
  expense: number;
  net: number;
}

export interface DashboardData {
  as_of: string;
  basis: "cash" | "accrual";
  currency: string;
  cash: { total: number; accounts: DashboardAccount[] };
  credit_cards: { total: number; accounts: DashboardAccount[] };
  month: PnlSummary;
  year_to_date: PnlSummary;
  review_pending: number;
  bank_needs_review: number;
  bank_pending: { count: number; total: number };
  /** Receipts in the inbox for more than 30 days with no bank transaction matched. */
  stale_receipts: { count: number };
  overdue_invoices: {
    count: number;
    total: number;
    top: {
      id: string;
      number: string;
      customer_name: string;
      due_date: string;
      days_overdue: number;
      balance_due: number;
    }[];
  };
  bills: {
    overdue: { count: number; total: number };
    due_soon: { count: number; total: number; days: number };
  };
  bank_connections: ({
    id: string;
    institution_name: string | null;
    status: string;
    error_code: string | null;
  } & SyncStatusView)[];
}

async function pnl(db: Reader, orgId: string, from: string, to: string, basis: "cash" | "accrual") {
  const r = await runReport(db, orgId, "", "profit_and_loss", { from, to, basis });
  // Section totals sit at depth 0, so an account named "Income" can't shadow them.
  const val = (label: string) => r.lines.find((l) => l.depth === 0 && l.label === label)?.values[0] ?? 0;
  const income = val("Total Income");
  const net = val("Net Income");
  // Expense includes cost of goods sold: everything between income and net income.
  return { from, to, income, expense: income - net, net };
}

export async function dashboard(db: Reader, orgId: string, asOf = today()): Promise<DashboardData> {
  const s = await settingsRow(db);
  const basis = s.defaultBasis;
  const types = await accountMap(db);

  const cash: DashboardAccount[] = [];
  const cards: DashboardAccount[] = [];
  const banks = await listBankAccounts(db);
  for (const b of banks) {
    if (!b.is_active && b.balance === 0) continue;
    const a: DashboardAccount = {
      id: b.id,
      name: b.name,
      kind: b.kind,
      mask: b.mask,
      ledger_account_id: b.ledger_account_id,
      balance: b.balance,
      unreviewed: b.unreviewed,
      pending: b.pending,
      last_synced_at: b.last_synced_at,
      last_successful_sync_at: b.last_successful_sync_at,
      last_sync_status: b.last_sync_status,
      last_sync_error: b.last_sync_error,
      last_sync_added: b.last_sync_added,
      last_sync_modified: b.last_sync_modified,
      last_sync_removed: b.last_sync_removed,
      connection_status: b.connection_status,
      new_accounts_available: b.new_accounts_available,
    };
    const isLiability = b.kind === "credit_card" || types.get(b.ledger_account_id)?.type === "liability";
    (isLiability ? cards : cash).push(a);
  }
  const sum = (xs: DashboardAccount[]) => xs.reduce((t, x) => t + x.balance, 0);
  // Categorize counts only rows someone can act on now: not pending, and not already waiting in
  // the review queue. Pending rows are reported separately in bank_pending.
  const bankNeedsReview = banks.reduce((t, b) => t + b.unreviewed, 0);
  const bankPending = {
    count: banks.reduce((t, b) => t + b.pending, 0),
    total: banks.reduce((t, b) => t + b.pending_amount, 0),
  };

  const month = await pnl(db, orgId, `${asOf.slice(0, 7)}-01`, asOf, basis);
  const ytd = await pnl(db, orgId, fiscalYearStart(asOf, s.fiscalYearStartMonth), asOf, basis);

  const pending = await db
    .select({ n: count() })
    .from(org.reviewItems)
    .where(eq(org.reviewItems.status, "pending"))
    .get();

  const invoices = await db
    .select({
      id: org.invoices.id,
      number: org.invoices.number,
      customerName: org.contacts.name,
      dueDate: org.invoices.dueDate,
      total: org.invoices.total,
      amountPaid: org.invoices.amountPaid,
    })
    .from(org.invoices)
    .innerJoin(org.contacts, eq(org.contacts.id, org.invoices.customerId))
    .where(and(inArray(org.invoices.status, ["sent", "partial"]), isNull(org.invoices.voidedAt)))
    .orderBy(asc(org.invoices.dueDate), asc(org.invoices.number))
    .all();
  const overdue = invoices
    .filter((i) => i.dueDate < asOf && i.total - i.amountPaid > 0)
    .map((i) => ({
      id: i.id,
      number: i.number,
      customer_name: i.customerName,
      due_date: i.dueDate,
      days_overdue: diffDays(asOf, i.dueDate),
      balance_due: i.total - i.amountPaid,
    }));
  const topOverdue = [...overdue]
    .sort((a, b) => b.balance_due - a.balance_due || a.due_date.localeCompare(b.due_date))
    .slice(0, 5);

  const bills = await db
    .select({ dueDate: org.bills.dueDate, total: org.bills.total, amountPaid: org.bills.amountPaid })
    .from(org.bills)
    .where(and(inArray(org.bills.status, ["open", "partial"]), isNull(org.bills.voidedAt)))
    .all();
  const soonEnd = addDays(asOf, BILLS_DUE_SOON_DAYS);
  const billOverdue = { count: 0, total: 0 };
  const billSoon = { count: 0, total: 0, days: BILLS_DUE_SOON_DAYS };
  for (const b of bills) {
    const open = b.total - b.amountPaid;
    if (open <= 0) continue;
    const bucket = b.dueDate < asOf ? billOverdue : b.dueDate <= soonEnd ? billSoon : null;
    if (!bucket) continue;
    bucket.count++;
    bucket.total += open;
  }

  const conns = await db
    .select()
    .from(org.bankConnections)
    .where(ne(org.bankConnections.status, "active"))
    .orderBy(asc(org.bankConnections.createdAt))
    .all();

  return {
    as_of: asOf,
    basis,
    currency: s.baseCurrency,
    cash: { total: sum(cash), accounts: cash },
    credit_cards: { total: sum(cards), accounts: cards },
    month,
    year_to_date: ytd,
    review_pending: Number(pending?.n ?? 0),
    bank_needs_review: bankNeedsReview,
    bank_pending: bankPending,
    stale_receipts: { count: await staleReceiptCount(db, asOf) },
    overdue_invoices: {
      count: overdue.length,
      total: overdue.reduce((t, i) => t + i.balance_due, 0),
      top: topOverdue,
    },
    bills: { overdue: billOverdue, due_soon: billSoon },
    bank_connections: conns.map((c) => ({
      id: c.id,
      institution_name: c.institutionName,
      status: c.status,
      error_code: c.errorCode,
      ...syncStatusView(c),
    })),
  };
}
