/**
 * Report queries (SPEC §9): load balances from posted lines and feed the pure builders in
 * @cosimo/core. Every report carries the ledger chain head so a printed copy can be checked later.
 */
import {
  type AccountInfo,
  type AgingDoc,
  aging,
  balanceSheet,
  cashFlow,
  type GlAccount,
  generalLedger,
  type Period,
  profitAndLoss,
  type Report,
  taxLineLabel,
  taxLineSummary,
  trialBalance,
} from "@cosimo/core";
import { type OrgDb, type OrgTx, org } from "@cosimo/db";
import {
  addDays,
  addMonths,
  centsToDecimal,
  diffDays,
  endOfMonth,
  fiscalYearStart,
  today,
} from "@cosimo/shared";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { renderReportPdf } from "../pdf/index.ts";
import { applyAdjustments, cashAdjustments } from "./cash-basis.ts";
import { recomputedLedgerHead } from "./chain.ts";
import { balances as accrualBalances, postedLines, settingsRow } from "./ledger.ts";

type Reader = OrgDb | OrgTx;
type Range = { from?: string | null; to?: string | null };

/** Posted balances for a range on the requested basis. */
export async function balancesOn(db: Reader, range: Range, basis: "accrual" | "cash" = "accrual") {
  const acc = await accrualBalances(db, range);
  return basis === "cash" ? applyAdjustments(acc, await cashAdjustments(db, range)) : acc;
}

export const REPORT_KEYS = [
  "trial_balance",
  "profit_and_loss",
  "balance_sheet",
  "cash_flow",
  "tax_line_summary",
  "general_ledger",
  "ar_aging",
  "ap_aging",
  "vendor_1099",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
type Basis = "accrual" | "cash";

export interface ReportParams {
  from?: string;
  to?: string;
  as_of?: string;
  /** P&L: none | prior_period | prior_year | monthly. Balance sheet: none | prior_year. */
  compare?: "none" | "prior_period" | "prior_year" | "monthly";
  basis?: "accrual" | "cash";
  account_ids?: string[];
}

export interface ReportMeta {
  org_name: string;
  generated_at: string;
  basis: "accrual" | "cash";
  chain_head: { seq: number; hash: string };
  /** False when a stored ledger hash disagrees with the recomputed chain. */
  chain_intact: boolean;
}

export type ReportResult = Report & { meta: ReportMeta; gl?: GlAccount[] };

export async function accountInfos(db: Reader): Promise<AccountInfo[]> {
  return db
    .select({
      id: org.accounts.id,
      code: org.accounts.code,
      name: org.accounts.name,
      type: org.accounts.type,
      subtype: org.accounts.subtype,
      parentId: org.accounts.parentId,
      taxLine: org.accounts.taxLine,
      systemKey: org.accounts.systemKey,
    })
    .from(org.accounts)
    .all();
}

function fmtRange(from: string, to: string) {
  return `${from} to ${to}`;
}

/** Default period: fiscal year to date. */
function defaultRange(p: ReportParams, fyStartMonth: number) {
  const to = p.to ?? p.as_of ?? today();
  const from = p.from ?? fiscalYearStart(to, fyStartMonth);
  return { from, to };
}

function periodLength(from: string, to: string) {
  // Month-aligned ranges step by months so "prior period" of March is February.
  const fromDay = Number(from.slice(8, 10));
  if (fromDay === 1 && endOfMonth(to) === to) {
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
      1;
    return { months };
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { days };
}

async function pnlPeriods(
  db: Reader,
  from: string,
  to: string,
  compare: ReportParams["compare"],
  basis: Basis,
) {
  const ranges: { label: string; from: string; to: string }[] = [];
  if (compare === "monthly") {
    let start = from;
    while (start <= to && ranges.length < 24) {
      const end = endOfMonth(start) < to ? endOfMonth(start) : to;
      ranges.push({ label: start.slice(0, 7), from: start, to: end });
      start = addDays(end, 1);
    }
  } else {
    ranges.push({ label: fmtRange(from, to), from, to });
    if (compare === "prior_year") {
      ranges.push({
        label: fmtRange(addMonths(from, -12), addMonths(to, -12)),
        from: addMonths(from, -12),
        to: addMonths(to, -12),
      });
    } else if (compare === "prior_period") {
      const len = periodLength(from, to);
      const pf = "months" in len ? addMonths(from, -len.months!) : addDays(from, -len.days!);
      const pt = addDays(from, -1);
      ranges.push({ label: fmtRange(pf, pt), from: pf, to: pt });
    }
  }
  const periods: Period[] = [];
  for (const r of ranges)
    periods.push({ ...r, balances: await balancesOn(db, { from: r.from, to: r.to }, basis) });
  return periods;
}

/**
 * The profit and loss report's "Net Income" for a range, read the way the dashboard reads it, but
 * without the chain head a full report carries (reserves read it on every forecast).
 */
export async function netIncome(db: Reader, from: string, to: string, basis: Basis): Promise<number> {
  const r = profitAndLoss(await accountInfos(db), await pnlPeriods(db, from, to, undefined, basis));
  return r.lines.find((l) => l.depth === 0 && l.label === "Net Income")?.values[0] ?? 0;
}

async function bsColumn(db: Reader, asOf: string, fyStartMonth: number, basis: Basis) {
  const fyStart = fiscalYearStart(asOf, fyStartMonth);
  return {
    label: `As of ${asOf}`,
    asOf,
    balances: await balancesOn(db, { to: asOf }, basis),
    priorYears: await balancesOn(db, { to: addDays(fyStart, -1) }, basis),
  };
}

export async function runReport(
  db: Reader,
  orgId: string,
  orgName: string,
  key: ReportKey,
  p: ReportParams,
): Promise<ReportResult> {
  const s = await settingsRow(db);
  const accounts = await accountInfos(db);
  const fy = s.fiscalYearStartMonth;
  // The general ledger lists actual posted lines, so it is always accrual.
  const basis: Basis = key === "general_ledger" ? "accrual" : (p.basis ?? s.defaultBasis);
  let report: Report;
  let gl: GlAccount[] | undefined;
  switch (key) {
    case "ar_aging":
    case "ap_aging": {
      const asOf = p.as_of ?? p.to ?? today();
      report = aging(key, await agingDocs(db, key === "ar_aging" ? "invoice" : "bill", asOf), asOf, diffDays);
      break;
    }
    case "vendor_1099": {
      const year = Number((p.to ?? p.as_of ?? today()).slice(0, 4));
      report = await vendor1099(db, year);
      break;
    }
    case "trial_balance": {
      const asOf = p.as_of ?? p.to ?? today();
      report = trialBalance(accounts, await balancesOn(db, { to: asOf }, basis), asOf);
      break;
    }
    case "profit_and_loss": {
      const { from, to } = defaultRange(p, fy);
      report = profitAndLoss(accounts, await pnlPeriods(db, from, to, p.compare, basis));
      break;
    }
    case "balance_sheet": {
      const asOf = p.as_of ?? p.to ?? today();
      const cols = [await bsColumn(db, asOf, fy, basis)];
      if (p.compare === "prior_year") cols.push(await bsColumn(db, addMonths(asOf, -12), fy, basis));
      report = balanceSheet(accounts, cols);
      break;
    }
    case "cash_flow": {
      const { from, to } = defaultRange(p, fy);
      report = cashFlow(accounts, {
        label: fmtRange(from, to),
        from,
        to,
        start: await balancesOn(db, { to: addDays(from, -1) }, basis),
        end: await balancesOn(db, { to }, basis),
        period: await balancesOn(db, { from, to }, basis),
      });
      break;
    }
    case "tax_line_summary": {
      const { from, to } = defaultRange(p, fy);
      report = taxLineSummary(
        accounts,
        await balancesOn(db, { from, to }, basis),
        (c) => (c ? taxLineLabel(c) : "Not mapped to a tax line"),
        {
          from,
          to,
        },
      );
      break;
    }
    case "general_ledger": {
      const { from, to } = defaultRange(p, fy);
      const scoped = p.account_ids?.length ? accounts.filter((a) => p.account_ids!.includes(a.id)) : accounts;
      const opening = await balancesOn(db, { to: addDays(from, -1) }, basis);
      const lines = await postedLines(db, { from, to, accountIds: p.account_ids });
      gl = generalLedger(scoped, opening, lines);
      report = {
        key: "general_ledger",
        title: "General Ledger",
        columns: [
          { label: "Debit", from, to },
          { label: "Credit", from, to },
          { label: "Balance", from, to },
        ],
        lines: gl.flatMap((g) => [
          {
            kind: "header" as const,
            label: `${g.account.code} ${g.account.name}`,
            depth: 0,
            accountId: g.account.id,
            values: [0, 0, g.opening],
          },
          ...g.lines.map((l) => ({
            kind: "account" as const,
            label: `${l.date} ${l.memo ?? ""}${l.description ? ` (${l.description})` : ""}`.trim(),
            depth: 1,
            accountId: g.account.id,
            values: [l.debit, l.credit, l.balance],
          })),
          {
            kind: "subtotal" as const,
            label: `Total ${g.account.name}`,
            depth: 0,
            accountId: g.account.id,
            values: [g.totalDebit, g.totalCredit, g.closing],
          },
        ]),
        checks: {},
      };
      break;
    }
  }
  const { intact, ...head } = await recomputedLedgerHead(db, orgId);
  return {
    ...report,
    gl,
    meta: {
      org_name: orgName,
      generated_at: new Date().toISOString(),
      basis,
      chain_head: head,
      chain_intact: intact,
    },
  };
}

/** Quote for CSV and neutralize spreadsheet formulas (numbers are left alone). */
export function csvCell(v: string) {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV rendering of a report. Amounts are decimal strings; the footer carries the chain head. */
export function reportCsv(r: ReportResult): string {
  const rows: string[][] = [];
  rows.push([r.title, r.meta.org_name]);
  rows.push(["Code", "Account", ...r.columns.map((c) => c.label)]);
  for (const l of r.lines) {
    rows.push([
      l.code ?? "",
      `${"  ".repeat(l.depth)}${l.label}`,
      ...l.values.map((v) => (l.kind === "header" && v === 0 ? "" : centsToDecimal(v))),
    ]);
  }
  rows.push([]);
  rows.push([`Generated ${r.meta.generated_at}`, `Basis: ${r.meta.basis}`]);
  rows.push([`Ledger chain head: seq ${r.meta.chain_head.seq}`, r.meta.chain_head.hash]);
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// ----------------------------------------------------------------------------- aging and 1099

/** Documents open as of a date: issued and posted by then, not voided by then, less applications by then. */
export async function agingDocs(db: Reader, type: "invoice" | "bill", asOf: string): Promise<AgingDoc[]> {
  const t = type === "invoice" ? org.invoices : org.bills;
  const contactCol = type === "invoice" ? org.invoices.customerId : org.bills.vendorId;
  const rows = await db
    .select({
      id: t.id,
      contactId: contactCol,
      contactName: org.contacts.name,
      number: type === "invoice" ? org.invoices.number : org.bills.billNumber,
      issueDate: t.issueDate,
      dueDate: t.dueDate,
      total: t.total,
      voidedAt: t.voidedAt,
    })
    .from(t)
    .innerJoin(org.contacts, eq(org.contacts.id, contactCol))
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, t.entryId))
    .where(and(eq(org.journalEntries.status, "posted"), lte(t.issueDate, asOf)))
    .all();
  const live = rows.filter((r) => !r.voidedAt || r.voidedAt.slice(0, 10) > asOf);
  if (!live.length) return [];
  const appliedOn = sql<string>`coalesce(${org.paymentApplications.appliedDate}, ${org.payments.date})`;
  const apps = await db
    .select({
      docId: org.paymentApplications.documentId,
      total: sql<number>`sum(${org.paymentApplications.amount})`,
    })
    .from(org.paymentApplications)
    .innerJoin(org.payments, eq(org.payments.id, org.paymentApplications.paymentId))
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.payments.entryId))
    .where(
      and(
        eq(org.paymentApplications.documentType, type),
        inArray(
          org.paymentApplications.documentId,
          live.map((r) => r.id),
        ),
        isNull(org.payments.voidedAt),
        eq(org.journalEntries.status, "posted"),
        lte(appliedOn, asOf),
      ),
    )
    .groupBy(org.paymentApplications.documentId)
    .all();
  const paid = new Map(apps.map((a) => [a.docId, Number(a.total)]));
  return live.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.contactName,
    number: r.number ?? "",
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    open: r.total - (paid.get(r.id) ?? 0),
  }));
}

/** Threshold above which a vendor generally needs a 1099-NEC (informational). */
export const REPORTABLE_1099 = 60_000;

/**
 * Payments to 1099 vendors in a calendar year (SPEC §8.2): bill payments and bank-categorized
 * expenses tagged with the vendor. Card payments are excluded (reported by the card processor on 1099-K).
 */
export async function vendor1099(db: Reader, year: number): Promise<Report> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const vendors = await db.select().from(org.contacts).where(eq(org.contacts.is1099Vendor, true)).all();
  const totals = new Map<string, number>();
  if (vendors.length) {
    const ids = vendors.map((v) => v.id);
    const cardAccounts = new Set(
      (
        await db
          .select({ id: org.accounts.id })
          .from(org.accounts)
          .where(eq(org.accounts.subtype, "credit_card"))
          .all()
      ).map((a) => a.id),
    );
    const pays = await db
      .select({
        contactId: org.payments.contactId,
        amount: org.payments.amount,
        account: org.payments.bankAccountId,
      })
      .from(org.payments)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.payments.entryId))
      .where(
        and(
          eq(org.payments.direction, "sent"),
          isNull(org.payments.voidedAt),
          eq(org.journalEntries.status, "posted"),
          inArray(org.payments.contactId, ids),
          gte(org.payments.date, from),
          lte(org.payments.date, to),
        ),
      )
      .all();
    for (const p of pays)
      if (!cardAccounts.has(p.account)) totals.set(p.contactId, (totals.get(p.contactId) ?? 0) + p.amount);
    // Direct expenses categorized from the bank, tagged with the vendor, paid from a bank (not card) account.
    const direct = await db
      .select({
        entryId: org.journalEntries.id,
        contactId: org.journalLines.contactId,
        amount: org.journalLines.amount,
        accountId: org.journalLines.accountId,
      })
      .from(org.journalLines)
      .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
      .where(
        and(
          eq(org.journalEntries.status, "posted"),
          inArray(org.journalEntries.sourceType, ["bank_transaction", "manual"]),
          gte(org.journalEntries.date, from),
          lte(org.journalEntries.date, to),
        ),
      )
      .all();
    const types = new Map(
      (await db.select({ id: org.accounts.id, type: org.accounts.type }).from(org.accounts).all()).map(
        (a) => [a.id, a.type],
      ),
    );
    const byEntry = new Map<string, typeof direct>();
    for (const l of direct) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
    const vendorSet = new Set(ids);
    for (const ls of byEntry.values()) {
      const paidFromBank = ls.some((l) => l.amount < 0 && types.get(l.accountId) === "asset");
      const paidByCard = ls.some((l) => l.amount < 0 && cardAccounts.has(l.accountId));
      if (!paidFromBank || paidByCard) continue;
      for (const l of ls) {
        if (l.contactId && vendorSet.has(l.contactId) && types.get(l.accountId) === "expense") {
          totals.set(l.contactId, (totals.get(l.contactId) ?? 0) + l.amount);
        }
      }
    }
  }
  const lines = vendors
    .map((v) => ({ v, total: totals.get(v.id) ?? 0 }))
    .sort((a, b) => a.v.name.localeCompare(b.v.name))
    .map(({ v, total }) => ({
      kind: "account" as const,
      label: `${v.name}${total >= REPORTABLE_1099 ? "" : " (under $600)"}`,
      code: v.taxIdLast4 ? `***-**-${v.taxIdLast4}` : "",
      depth: 0,
      accountId: v.id,
      values: [total],
    }));
  const sum = lines.reduce((s, l) => s + l.values[0]!, 0);
  return {
    key: "vendor_1099",
    title: `1099 Vendor Summary ${year}`,
    columns: [{ label: "Paid", from, to }],
    lines: [...lines, { kind: "total", label: "Total", depth: 0, values: [sum] }],
    checks: {},
  };
}

// ----------------------------------------------------------------------------- PDF

export async function reportPdf(r: ReportResult, currency = "USD"): Promise<Uint8Array> {
  const c0 = r.columns[0];
  const range = c0?.from && c0?.to ? `${c0.from} to ${c0.to}` : c0?.asOf ? `As of ${c0.asOf}` : "";
  const subtitle = [
    range,
    r.key === "vendor_1099" || r.key.endsWith("aging")
      ? null
      : `${r.meta.basis[0]!.toUpperCase()}${r.meta.basis.slice(1)} basis`,
  ]
    .filter(Boolean)
    .join(" · ");
  return renderReportPdf({
    title: r.title,
    orgName: r.meta.org_name,
    subtitle,
    currency,
    columns: [
      { label: r.key.endsWith("aging") ? "Contact" : r.key === "vendor_1099" ? "Vendor" : "Account" },
      ...r.columns.map((c) => ({ label: c.label, align: "right" as const })),
    ],
    rows: r.lines.map((l) => ({
      kind: l.kind,
      depth: l.depth,
      cells: [
        `${l.code ? `${l.code}  ` : ""}${l.label}`,
        ...l.values.map((v) => (l.kind === "header" && v === 0 ? null : v)),
      ],
    })),
    footer: [
      `Generated ${r.meta.generated_at}`,
      `Ledger chain head #${r.meta.chain_head.seq}: ${r.meta.chain_head.hash}`,
    ],
  });
}
