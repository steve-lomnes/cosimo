/**
 * Chart of accounts templates (SPEC §6.3), shipped as data. System accounts (SPEC §5.2) are shared
 * by every template and carry a stable `systemKey`.
 */
import type { AccountSubtype, AccountType, CoaTemplate } from "@cosimo/shared";

/** Accounts money can move through in a bill or invoice payment (same rule both directions). */
export function isPaymentAccount(a: { type: string; subtype: string | null }): boolean {
  if (a.type === "asset") return a.subtype === "bank" || a.subtype === "other_current_asset";
  if (a.type === "liability") return a.subtype === "credit_card" || a.subtype === "other_current_liability";
  if (a.type === "equity") return a.subtype === "owner_equity";
  return false;
}

export interface AccountTemplate {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  taxLine?: string;
  systemKey?: SystemAccountKey;
  description?: string;
}

export type SystemAccountKey =
  | "ar"
  | "ap"
  | "opening_balance_equity"
  | "owner_draw"
  | "retained_earnings"
  | "uncategorized_income"
  | "uncategorized_expense";

/** Tax line codes → human labels, used by the Tax Line Summary report and year-end package. */
export const TAX_LINES: Record<string, string> = {
  // Schedule C (Form 1040), Profit or Loss From Business
  "schc.1": "Schedule C line 1: Gross receipts or sales",
  "schc.2": "Schedule C line 2: Returns and allowances",
  "schc.4": "Schedule C line 4: Cost of goods sold",
  "schc.6": "Schedule C line 6: Other income",
  "schc.8": "Schedule C line 8: Advertising",
  "schc.9": "Schedule C line 9: Car and truck expenses",
  "schc.10": "Schedule C line 10: Commissions and fees",
  "schc.11": "Schedule C line 11: Contract labor",
  "schc.13": "Schedule C line 13: Depreciation and section 179",
  "schc.14": "Schedule C line 14: Employee benefit programs",
  "schc.15": "Schedule C line 15: Insurance (other than health)",
  "schc.16a": "Schedule C line 16a: Interest (mortgage)",
  "schc.16b": "Schedule C line 16b: Interest (other)",
  "schc.17": "Schedule C line 17: Legal and professional services",
  "schc.18": "Schedule C line 18: Office expense",
  "schc.19": "Schedule C line 19: Pension and profit-sharing plans",
  "schc.20a": "Schedule C line 20a: Rent or lease (vehicles, machinery, equipment)",
  "schc.20b": "Schedule C line 20b: Rent or lease (other business property)",
  "schc.21": "Schedule C line 21: Repairs and maintenance",
  "schc.22": "Schedule C line 22: Supplies",
  "schc.23": "Schedule C line 23: Taxes and licenses",
  "schc.24a": "Schedule C line 24a: Travel",
  "schc.24b": "Schedule C line 24b: Deductible meals",
  "schc.25": "Schedule C line 25: Utilities",
  "schc.26": "Schedule C line 26: Wages",
  "schc.27a": "Schedule C line 27a: Other expenses (Part V)",
  "schc.30": "Schedule C line 30: Business use of home",
  // Form 1065, U.S. Return of Partnership Income
  "f1065.1a": "Form 1065 line 1a: Gross receipts or sales",
  "f1065.1b": "Form 1065 line 1b: Returns and allowances",
  "f1065.2": "Form 1065 line 2: Cost of goods sold",
  "f1065.7": "Form 1065 line 7: Other income",
  "f1065.9": "Form 1065 line 9: Salaries and wages",
  "f1065.10": "Form 1065 line 10: Guaranteed payments to partners",
  "f1065.11": "Form 1065 line 11: Repairs and maintenance",
  "f1065.12": "Form 1065 line 12: Bad debts",
  "f1065.13": "Form 1065 line 13: Rent",
  "f1065.14": "Form 1065 line 14: Taxes and licenses",
  "f1065.15": "Form 1065 line 15: Interest",
  "f1065.16": "Form 1065 line 16: Depreciation",
  "f1065.18": "Form 1065 line 18: Retirement plans",
  "f1065.19": "Form 1065 line 19: Employee benefit programs",
  "f1065.21": "Form 1065 line 21: Other deductions",
  "f1065.k19": "Form 1065 Schedule K line 19: Distributions",
  // Form 1120-S, U.S. Income Tax Return for an S Corporation
  "f1120s.1a": "Form 1120-S line 1a: Gross receipts or sales",
  "f1120s.1b": "Form 1120-S line 1b: Returns and allowances",
  "f1120s.2": "Form 1120-S line 2: Cost of goods sold",
  "f1120s.5": "Form 1120-S line 5: Other income",
  "f1120s.7": "Form 1120-S line 7: Compensation of officers",
  "f1120s.8": "Form 1120-S line 8: Salaries and wages",
  "f1120s.9": "Form 1120-S line 9: Repairs and maintenance",
  "f1120s.10": "Form 1120-S line 10: Bad debts",
  "f1120s.11": "Form 1120-S line 11: Rents",
  "f1120s.12": "Form 1120-S line 12: Taxes and licenses",
  "f1120s.13": "Form 1120-S line 13: Interest",
  "f1120s.14": "Form 1120-S line 14: Depreciation",
  "f1120s.16": "Form 1120-S line 16: Advertising",
  "f1120s.17": "Form 1120-S line 17: Pension, profit-sharing plans",
  "f1120s.18": "Form 1120-S line 18: Employee benefit programs",
  "f1120s.20": "Form 1120-S line 20: Other deductions",
  "f1120s.k16d": "Form 1120-S Schedule K line 16d: Distributions",
};

export function taxLineLabel(code: string | null | undefined): string {
  if (!code) return "Unmapped";
  return TAX_LINES[code] ?? code;
}

type Row = [
  code: string,
  name: string,
  type: AccountType,
  subtype: AccountSubtype,
  taxLine?: string,
  description?: string,
];

const row = ([code, name, type, subtype, taxLine, description]: Row): AccountTemplate => ({
  code,
  name,
  type,
  subtype,
  taxLine,
  description,
});

/**
 * Formation costs have their own tax treatment (IRC §195 startup costs, §709 / §248 organizational
 * costs): up to $5,000 deductible in the first year, the rest amortized over 180 months. Keeping them
 * apart from legal fees and licenses lets the preparer apply the limits.
 */
const ORGANIZATION_COSTS =
  "State filing fee, first-year registered agent, operating agreement legal fees and other costs of forming the business before it opened. Up to $5,000 is deductible in the first year; the rest is amortized over 180 months.";

function systemAccounts(t: CoaTemplate): AccountTemplate[] {
  const draw =
    t === "form_1120s"
      ? { name: "Shareholder Distributions", taxLine: "f1120s.k16d" }
      : t === "form_1065"
        ? { name: "Partner Distributions", taxLine: "f1065.k19" }
        : { name: "Owner's Draw", taxLine: undefined };
  return [
    {
      code: "1200",
      name: "Accounts Receivable",
      type: "asset",
      subtype: "accounts_receivable",
      systemKey: "ar",
    },
    {
      code: "2000",
      name: "Accounts Payable",
      type: "liability",
      subtype: "accounts_payable",
      systemKey: "ap",
    },
    {
      code: "3000",
      name: "Opening Balance Equity",
      type: "equity",
      subtype: "opening_balance",
      systemKey: "opening_balance_equity",
      description:
        "Offsets opening balances. Should be reclassified to owner's equity once opening balances are complete.",
    },
    {
      code: "3200",
      name: draw.name,
      type: "equity",
      subtype: "owner_draw",
      systemKey: "owner_draw",
      taxLine: draw.taxLine,
    },
    {
      code: "3900",
      name: "Retained Earnings",
      type: "equity",
      subtype: "retained_earnings",
      systemKey: "retained_earnings",
      description:
        "Prior years' net income is computed into this line on the balance sheet; no closing entries needed.",
    },
    {
      code: "4999",
      name: "Uncategorized Income",
      type: "income",
      subtype: "uncategorized",
      systemKey: "uncategorized_income",
    },
    {
      code: "6999",
      name: "Uncategorized Expense",
      type: "expense",
      subtype: "uncategorized",
      systemKey: "uncategorized_expense",
    },
  ];
}

/** Out-of-pocket business spending the business will pay back; a liability, not a contribution. */
const dueToOwners = (name: string, extra = ""): Row => [
  "2400",
  name,
  "liability",
  "other_current_liability",
  undefined,
  `Business expenses an owner paid personally and the business will pay back. Record the expense against this account, then the reimbursement from checking against it. Keep the receipts.${extra}`,
];

const COMMON_BALANCE_SHEET: Row[] = [
  ["1000", "Business Checking", "asset", "bank"],
  ["1010", "Business Savings", "asset", "bank"],
  ["1300", "Prepaid Expenses", "asset", "other_current_asset"],
  ["1500", "Equipment", "asset", "fixed_asset"],
  ["1590", "Accumulated Depreciation", "asset", "accumulated_depreciation"],
  ["2100", "Business Credit Card", "liability", "credit_card"],
  ["2200", "Sales Tax Payable", "liability", "other_current_liability"],
  ["2300", "Customer Deposits", "liability", "other_current_liability"],
  ["2700", "Loans Payable", "liability", "long_term_liability"],
];

const SCHEDULE_C: Row[] = [
  ...COMMON_BALANCE_SHEET,
  dueToOwners("Due to Owner"),
  ["3100", "Owner's Contributions", "equity", "owner_equity"],
  ["4000", "Sales", "income", "other", "schc.1"],
  ["4010", "Consulting Income", "income", "other", "schc.1"],
  ["4050", "Refunds and Allowances", "income", "other", "schc.2"],
  ["4900", "Other Income", "income", "other_income", "schc.6"],
  ["4950", "Interest Income", "income", "other_income", "schc.6"],
  ["5000", "Cost of Goods Sold", "expense", "cost_of_goods", "schc.4"],
  ["6000", "Advertising and Marketing", "expense", "other", "schc.8"],
  ["6010", "Car and Truck Expenses", "expense", "other", "schc.9"],
  ["6020", "Commissions and Fees", "expense", "other", "schc.10"],
  ["6030", "Contract Labor", "expense", "other", "schc.11"],
  ["6040", "Depreciation", "expense", "other", "schc.13"],
  ["6050", "Employee Benefit Programs", "expense", "other", "schc.14"],
  ["6060", "Insurance", "expense", "other", "schc.15"],
  ["6070", "Interest Expense", "expense", "other", "schc.16b"],
  ["6080", "Legal and Professional Fees", "expense", "other", "schc.17"],
  ["6090", "Office Expenses", "expense", "other", "schc.18"],
  ["6100", "Software and Subscriptions", "expense", "other", "schc.18"],
  ["6110", "Retirement Plan Contributions", "expense", "other", "schc.19"],
  ["6120", "Equipment Rental", "expense", "other", "schc.20a"],
  ["6130", "Rent", "expense", "other", "schc.20b"],
  ["6140", "Repairs and Maintenance", "expense", "other", "schc.21"],
  ["6150", "Supplies", "expense", "other", "schc.22"],
  ["6160", "Taxes and Licenses", "expense", "other", "schc.23"],
  ["6170", "Travel", "expense", "other", "schc.24a"],
  ["6180", "Meals", "expense", "other", "schc.24b"],
  ["6190", "Utilities", "expense", "other", "schc.25"],
  ["6195", "Telephone and Internet", "expense", "other", "schc.25"],
  ["6200", "Wages", "expense", "other", "schc.26"],
  ["6300", "Bank and Merchant Fees", "expense", "other", "schc.27a"],
  ["6310", "Education and Training", "expense", "other", "schc.27a"],
  ["6320", "Dues and Memberships", "expense", "other", "schc.27a"],
  ["6330", "Postage and Shipping", "expense", "other", "schc.27a"],
  ["6340", "Organization and Startup Costs", "expense", "other", "schc.27a", ORGANIZATION_COSTS],
  ["6400", "Business Use of Home", "expense", "other", "schc.30"],
  ["6900", "Other Expenses", "expense", "other_expense", "schc.27a"],
];

const FORM_1065: Row[] = [
  ...COMMON_BALANCE_SHEET,
  dueToOwners("Due to Partners"),
  ["3100", "Partner Contributions", "equity", "owner_equity"],
  ["3110", "Partner Capital", "equity", "owner_equity"],
  ["4000", "Sales", "income", "other", "f1065.1a"],
  ["4010", "Service Revenue", "income", "other", "f1065.1a"],
  ["4050", "Refunds and Allowances", "income", "other", "f1065.1b"],
  ["4900", "Other Income", "income", "other_income", "f1065.7"],
  ["4950", "Interest Income", "income", "other_income", "f1065.7"],
  ["5000", "Cost of Goods Sold", "expense", "cost_of_goods", "f1065.2"],
  ["6000", "Advertising and Marketing", "expense", "other", "f1065.21"],
  ["6020", "Commissions and Fees", "expense", "other", "f1065.21"],
  ["6030", "Contract Labor", "expense", "other", "f1065.21"],
  ["6040", "Depreciation", "expense", "other", "f1065.16"],
  ["6050", "Employee Benefit Programs", "expense", "other", "f1065.19"],
  ["6060", "Insurance", "expense", "other", "f1065.21"],
  ["6070", "Interest Expense", "expense", "other", "f1065.15"],
  ["6080", "Legal and Professional Fees", "expense", "other", "f1065.21"],
  ["6090", "Office Expenses", "expense", "other", "f1065.21"],
  ["6100", "Software and Subscriptions", "expense", "other", "f1065.21"],
  ["6110", "Retirement Plans", "expense", "other", "f1065.18"],
  ["6130", "Rent", "expense", "other", "f1065.13"],
  ["6140", "Repairs and Maintenance", "expense", "other", "f1065.11"],
  ["6150", "Supplies", "expense", "other", "f1065.21"],
  ["6160", "Taxes and Licenses", "expense", "other", "f1065.14"],
  ["6170", "Travel", "expense", "other", "f1065.21"],
  ["6180", "Meals", "expense", "other", "f1065.21"],
  ["6190", "Utilities", "expense", "other", "f1065.21"],
  ["6200", "Salaries and Wages", "expense", "other", "f1065.9"],
  ["6210", "Guaranteed Payments to Partners", "expense", "other", "f1065.10"],
  ["6250", "Bad Debts", "expense", "other", "f1065.12"],
  ["6300", "Bank and Merchant Fees", "expense", "other", "f1065.21"],
  ["6340", "Organization and Startup Costs", "expense", "other", "f1065.21", ORGANIZATION_COSTS],
  ["6900", "Other Expenses", "expense", "other_expense", "f1065.21"],
];

const FORM_1120S: Row[] = [
  ...COMMON_BALANCE_SHEET,
  dueToOwners(
    "Due to Shareholders",
    " Reimburse under a written accountable plan, or the expenses are taxable wages.",
  ),
  ["3100", "Common Stock", "equity", "owner_equity"],
  ["3110", "Additional Paid-in Capital", "equity", "owner_equity"],
  ["4000", "Sales", "income", "other", "f1120s.1a"],
  ["4010", "Service Revenue", "income", "other", "f1120s.1a"],
  ["4050", "Refunds and Allowances", "income", "other", "f1120s.1b"],
  ["4900", "Other Income", "income", "other_income", "f1120s.5"],
  ["4950", "Interest Income", "income", "other_income", "f1120s.5"],
  ["5000", "Cost of Goods Sold", "expense", "cost_of_goods", "f1120s.2"],
  ["6000", "Advertising and Marketing", "expense", "other", "f1120s.16"],
  ["6020", "Commissions and Fees", "expense", "other", "f1120s.20"],
  ["6030", "Contract Labor", "expense", "other", "f1120s.20"],
  ["6040", "Depreciation", "expense", "other", "f1120s.14"],
  ["6050", "Employee Benefit Programs", "expense", "other", "f1120s.18"],
  ["6060", "Insurance", "expense", "other", "f1120s.20"],
  ["6070", "Interest Expense", "expense", "other", "f1120s.13"],
  ["6080", "Legal and Professional Fees", "expense", "other", "f1120s.20"],
  ["6090", "Office Expenses", "expense", "other", "f1120s.20"],
  ["6100", "Software and Subscriptions", "expense", "other", "f1120s.20"],
  ["6110", "Pension and Profit-Sharing", "expense", "other", "f1120s.17"],
  ["6130", "Rent", "expense", "other", "f1120s.11"],
  ["6140", "Repairs and Maintenance", "expense", "other", "f1120s.9"],
  ["6150", "Supplies", "expense", "other", "f1120s.20"],
  ["6160", "Taxes and Licenses", "expense", "other", "f1120s.12"],
  ["6170", "Travel", "expense", "other", "f1120s.20"],
  ["6180", "Meals", "expense", "other", "f1120s.20"],
  ["6190", "Utilities", "expense", "other", "f1120s.20"],
  ["6200", "Salaries and Wages", "expense", "other", "f1120s.8"],
  ["6205", "Officer Compensation", "expense", "other", "f1120s.7"],
  ["6250", "Bad Debts", "expense", "other", "f1120s.10"],
  ["6300", "Bank and Merchant Fees", "expense", "other", "f1120s.20"],
  ["6340", "Organization and Startup Costs", "expense", "other", "f1120s.20", ORGANIZATION_COSTS],
  ["6900", "Other Expenses", "expense", "other_expense", "f1120s.20"],
];

const MINIMAL: Row[] = [
  ["1000", "Checking", "asset", "bank"],
  ["2100", "Credit Card", "liability", "credit_card"],
  ["3100", "Owner's Contributions", "equity", "owner_equity"],
  ["4000", "Income", "income", "other"],
  ["6000", "Expenses", "expense", "other"],
];

const TEMPLATES: Record<CoaTemplate, Row[]> = {
  schedule_c: SCHEDULE_C,
  form_1065: FORM_1065,
  form_1120s: FORM_1120S,
  minimal: MINIMAL,
};

export function chartOfAccounts(t: CoaTemplate): AccountTemplate[] {
  const all = [...systemAccounts(t), ...TEMPLATES[t].map(row)];
  return all.sort((a, b) => a.code.localeCompare(b.code));
}

export const SYSTEM_ACCOUNT_KEYS: SystemAccountKey[] = [
  "ar",
  "ap",
  "opening_balance_equity",
  "owner_draw",
  "retained_earnings",
  "uncategorized_income",
  "uncategorized_expense",
];
