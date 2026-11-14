export const ROLES = ["owner", "bookkeeper", "accountant", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, accountant: 1, bookkeeper: 2, owner: 3 };
export function roleRank(r: Role): number {
  return ROLE_RANK[r];
}
export function minRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
}
export function roleAtLeast(r: Role, min: Role): boolean {
  return roleRank(r) >= roleRank(min);
}
/** Roles that can change books data. */
export function canWrite(r: Role): boolean {
  return r === "owner" || r === "bookkeeper";
}

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  "bank",
  "credit_card",
  "accounts_receivable",
  "accounts_payable",
  "owner_equity",
  "owner_draw",
  "retained_earnings",
  "opening_balance",
  "fixed_asset",
  "accumulated_depreciation",
  "other_current_asset",
  "other_current_liability",
  "long_term_liability",
  "cost_of_goods",
  "other_income",
  "other_expense",
  "uncategorized",
  "other",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const ENTRY_STATUSES = ["draft", "pending_review", "posted", "rejected"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ACTORS = ["user", "api_token", "mcp", "rule", "system", "integration"] as const;
export type Actor = (typeof ACTORS)[number];

export const SOURCE_TYPES = [
  "manual",
  "bank_transaction",
  "invoice",
  "invoice_payment",
  "payment_fee",
  "payment_refund",
  "payment_dispute",
  "bill",
  "bill_payment",
  "transfer",
  "opening_balance",
  "import",
  "reversal",
  "owner_draw",
  "reserve_true_up",
  "reserve_payment",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SIGNUP_MODES = ["single_user", "invite_only", "open"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const ENTITY_TYPES = [
  "single_member_llc",
  "sole_prop",
  "multi_member_llc",
  "s_corp",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const COA_TEMPLATES = ["schedule_c", "form_1065", "form_1120s", "minimal"] as const;
export type CoaTemplate = (typeof COA_TEMPLATES)[number];

export const BASES = ["cash", "accrual"] as const;
export type Basis = (typeof BASES)[number];

export function defaultTemplateForEntity(e: EntityType): CoaTemplate {
  switch (e) {
    case "multi_member_llc":
      return "form_1065";
    case "s_corp":
      return "form_1120s";
    default:
      return "schedule_c";
  }
}
