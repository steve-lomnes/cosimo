import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ---------------------------------------------------------------------------
// Settings and structure
// ---------------------------------------------------------------------------

export const orgSettings = sqliteTable(
  "org_settings",
  {
    id: integer("id").primaryKey().default(1),
    orgId: text("org_id").notNull(),
    legalName: text("legal_name").notNull(),
    dba: text("dba"),
    entityType: text("entity_type").notNull().default("single_member_llc"),
    taxIdLast4: text("tax_id_last4"),
    addressJson: text("address_json"),
    baseCurrency: text("base_currency").notNull().default("USD"),
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    defaultBasis: text("default_basis", { enum: ["cash", "accrual"] })
      .notNull()
      .default("cash"),
    booksStartDate: text("books_start_date"),
    softLockDate: text("soft_lock_date"),
    hardLockDate: text("hard_lock_date"),
    invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
    nextInvoiceNumber: integer("next_invoice_number").notNull().default(1001),
    logoAttachmentId: text("logo_attachment_id"),
    /** Entries at or above this absolute amount (cents) require review from any actor. */
    reviewThreshold: integer("review_threshold").notNull().default(250000),
    invoiceColor: text("invoice_color").notNull().default("#1f3a5f"),
    paymentInstructions: text("payment_instructions"),
    defaultTerms: text("default_terms").notNull().default("Net 30"),
    remindersEnabled: integer("reminders_enabled", { mode: "boolean" }).notNull().default(false),
    plaidEnv: text("plaid_env"),
    plaidClientId: text("plaid_client_id"),
    plaidSecretEnc: text("plaid_secret_enc"),
    /** Online invoice payments: `off`, `manual_link` (a pasted URL per invoice), or `stripe`. */
    paymentProvider: text("payment_provider", { enum: ["off", "manual_link", "stripe"] })
      .notNull()
      .default("off"),
    /** Encrypted JSON of the provider's secrets (Stripe: secret key, webhook secret and endpoint ID). */
    paymentCredentialsEnc: text("payment_credentials_enc"),
    /** Provider options, validated per provider (Stripe: methods, account name, livemode). */
    paymentOptionsJson: text("payment_options_json"),
    paymentClearingAccountId: text("payment_clearing_account_id"),
    paymentFeeAccountId: text("payment_fee_account_id"),
    onlinePayDefault: integer("online_pay_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [check("org_settings_singleton", sql`${t.id} = 1`)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ["asset", "liability", "equity", "income", "expense"] }).notNull(),
    subtype: text("subtype").notNull().default("other"),
    parentId: text("parent_id"),
    taxLine: text("tax_line"),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /** stable key for system accounts, e.g. "ar", "ap", "retained_earnings" */
    systemKey: text("system_key"),
    currency: text("currency").notNull().default("USD"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("accounts_code_uq").on(t.code),
    uniqueIndex("accounts_system_key_uq").on(t.systemKey),
    check("accounts_type_ck", sql`${t.type} in ('asset','liability','equity','income','expense')`),
  ],
);

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    memo: text("memo"),
    status: text("status", { enum: ["draft", "pending_review", "posted", "rejected"] })
      .notNull()
      .default("draft"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceId: text("source_id"),
    reversesEntryId: text("reverses_entry_id"),
    reversedByEntryId: text("reversed_by_entry_id"),
    createdBy: text("created_by"),
    createdByActor: text("created_by_actor", {
      enum: ["user", "api_token", "mcp", "rule", "system", "integration"],
    })
      .notNull()
      .default("user"),
    createdAt: text("created_at").notNull().default(now),
    postedAt: text("posted_at"),
    postedBy: text("posted_by"),
    lockOverrideNote: text("lock_override_note"),
    chainSeq: integer("chain_seq"),
    prevHash: text("prev_hash"),
    entryHash: text("entry_hash"),
  },
  (t) => [
    uniqueIndex("journal_entries_chain_seq_uq").on(t.chainSeq),
    index("journal_entries_date_idx").on(t.date),
    index("journal_entries_status_idx").on(t.status),
    index("journal_entries_source_idx").on(t.sourceType, t.sourceId),
    check("journal_entries_status_ck", sql`${t.status} in ('draft','pending_review','posted','rejected')`),
  ],
);

export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => journalEntries.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    description: text("description"),
    contactId: text("contact_id"),
    lineOrder: integer("line_order").notNull().default(0),
  },
  (t) => [
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.accountId),
    check("journal_lines_amount_int", sql`typeof(${t.amount}) = 'integer'`),
  ],
);

/** Transient row written inside a posting transaction so triggers know who is posting. */
export const postingContext = sqliteTable("posting_context", {
  id: integer("id").primaryKey().default(1),
  actor: text("actor").notNull(),
  role: text("role").notNull(),
  note: text("note"),
});

// ---------------------------------------------------------------------------
// Contacts, receivables, payables
// ---------------------------------------------------------------------------

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["customer", "vendor", "both"] }).notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    addressJson: text("address_json"),
    taxIdLast4: text("tax_id_last4"),
    is1099Vendor: integer("is_1099_vendor", { mode: "boolean" }).notNull().default(false),
    defaultAccountId: text("default_account_id"),
    defaultTerms: text("default_terms"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(now),
    archivedAt: text("archived_at"),
  },
  (t) => [index("contacts_name_idx").on(t.name)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    number: text("number").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => contacts.id),
    issueDate: text("issue_date").notNull(),
    dueDate: text("due_date").notNull(),
    status: text("status", { enum: ["draft", "sent", "partial", "paid", "void"] })
      .notNull()
      .default("draft"),
    currency: text("currency").notNull().default("USD"),
    subtotal: integer("subtotal").notNull().default(0),
    total: integer("total").notNull().default(0),
    amountPaid: integer("amount_paid").notNull().default(0),
    memo: text("memo"),
    terms: text("terms"),
    entryId: text("entry_id"),
    recurringId: text("recurring_id"),
    createdBy: text("created_by"),
    createdByActor: text("created_by_actor").notNull().default("user"),
    createdAt: text("created_at").notNull().default(now),
    sentAt: text("sent_at"),
    lastReminderAt: text("last_reminder_at"),
    voidedAt: text("voided_at"),
    onlinePayEnabled: integer("online_pay_enabled", { mode: "boolean" }).notNull().default(false),
    manualPayUrl: text("manual_pay_url"),
    /**
     * The pay link is derived from the master key, the invoice, and this version (0 = no link yet);
     * only the SHA-256 of the token is stored, for lookup. Rotating bumps the version.
     */
    payTokenVersion: integer("pay_token_version").notNull().default(0),
    payTokenHash: text("pay_token_hash"),
    paySessionId: text("pay_session_id"),
    paySessionAmount: integer("pay_session_amount"),
    paySessionExpiresAt: text("pay_session_expires_at"),
    onlinePayStatus: text("online_pay_status", { enum: ["processing"] }),
    payLinkOpenedAt: text("pay_link_opened_at"),
    /** Failed checkout creates so far; part of the idempotency key, so a retry isn't Stripe's replay. */
    payAttempt: integer("pay_attempt").notNull().default(0),
    /** The last pay-link failure (provider message, IDs and URLs stripped), cleared on success. */
    payError: text("pay_error"),
    payErrorAt: text("pay_error_at"),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.number),
    index("invoices_customer_idx").on(t.customerId),
    uniqueIndex("invoices_pay_token_hash_uq").on(t.payTokenHash),
  ],
);

export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    description: text("description").notNull(),
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    unitPrice: integer("unit_price").notNull(),
    amount: integer("amount").notNull(),
    incomeAccountId: text("income_account_id")
      .notNull()
      .references(() => accounts.id),
    lineOrder: integer("line_order").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const bills = sqliteTable(
  "bills",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => contacts.id),
    billNumber: text("bill_number"),
    issueDate: text("issue_date").notNull(),
    dueDate: text("due_date").notNull(),
    status: text("status", { enum: ["draft", "open", "partial", "paid", "void"] })
      .notNull()
      .default("open"),
    currency: text("currency").notNull().default("USD"),
    total: integer("total").notNull().default(0),
    amountPaid: integer("amount_paid").notNull().default(0),
    memo: text("memo"),
    entryId: text("entry_id"),
    recurringId: text("recurring_id"),
    createdAt: text("created_at").notNull().default(now),
    voidedAt: text("voided_at"),
  },
  (t) => [index("bills_vendor_idx").on(t.vendorId)],
);

export const billLines = sqliteTable(
  "bill_lines",
  {
    id: text("id").primaryKey(),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id),
    description: text("description").notNull(),
    amount: integer("amount").notNull(),
    expenseAccountId: text("expense_account_id")
      .notNull()
      .references(() => accounts.id),
    lineOrder: integer("line_order").notNull().default(0),
  },
  (t) => [index("bill_lines_bill_idx").on(t.billId)],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    direction: text("direction", { enum: ["received", "sent"] }).notNull(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    bankAccountId: text("bank_account_id")
      .notNull()
      .references(() => accounts.id),
    method: text("method"),
    reference: text("reference"),
    memo: text("memo"),
    entryId: text("entry_id"),
    createdAt: text("created_at").notNull().default(now),
    voidedAt: text("voided_at"),
  },
  (t) => [index("payments_contact_idx").on(t.contactId), check("payments_amount_pos", sql`${t.amount} > 0`)],
);

export const paymentApplications = sqliteTable(
  "payment_applications",
  {
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    documentType: text("document_type", { enum: ["invoice", "bill"] }).notNull(),
    documentId: text("document_id").notNull(),
    amount: integer("amount").notNull(),
    appliedDate: text("applied_date"),
  },
  (t) => [
    primaryKey({ columns: [t.paymentId, t.documentType, t.documentId] }),
    index("payment_applications_doc_idx").on(t.documentType, t.documentId),
    check("payment_applications_amount_pos", sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Online payments (payment providers such as Stripe)
// ---------------------------------------------------------------------------

/** The provider's customer object for a contact, created on the first checkout. */
export const providerCustomers = sqliteTable(
  "provider_customers",
  {
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    createdAt: text("created_at").notNull().default(now),
    /** Funds the provider holds for the customer that aren't applied to a payment (Stripe: bank transfers). */
    cashBalance: integer("cash_balance"),
    cashBalanceCheckedAt: text("cash_balance_checked_at"),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.provider] })],
);

/** Every webhook event received, once (a redelivery hits the unique key and is ignored). */
export const providerEvents = sqliteTable(
  "provider_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    receivedAt: text("received_at").notNull().default(now),
    processedAt: text("processed_at"),
    result: text("result", { enum: ["recorded", "ignored", "unhandled", "error"] }),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("provider_events_event_uq").on(t.provider, t.eventId),
    index("provider_events_pending_idx").on(t.processedAt),
  ],
);

/**
 * One row per provider payment recorded in the books. The unique (provider, payment) key is the
 * idempotency guard: the webhook, polling, and the customer's return all record through it.
 */
export const providerPayments = sqliteTable(
  "provider_payments",
  {
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    invoiceId: text("invoice_id"),
    gross: integer("gross").notNull(),
    fee: integer("fee"),
    feeEntryId: text("fee_entry_id"),
    methodType: text("method_type"),
    balanceTxnId: text("balance_txn_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("provider_payments_uq").on(t.provider, t.providerPaymentId),
    index("provider_payments_invoice_idx").on(t.invoiceId),
  ],
);

/**
 * One row per money movement the provider makes against a recorded payment: a refund, or a dispute
 * withdrawing or reinstating funds. The unique (provider, object) key is the idempotency guard, so
 * the webhook, polling, and the backfill propose each entry at most once. A rejected entry keeps its
 * row, so the movement isn't proposed again.
 */
export const providerAdjustments = sqliteTable(
  "provider_adjustments",
  {
    provider: text("provider").notNull(),
    /** Stripe: the refund ID, or the dispute's balance transaction ID. */
    providerObjectId: text("provider_object_id").notNull(),
    kind: text("kind", { enum: ["refund", "dispute_withdrawal", "dispute_reinstatement"] }).notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id),
    invoiceId: text("invoice_id"),
    /** Positive cents: refunded, withdrawn, or reinstated. */
    amount: integer("amount").notNull(),
    /** The provider's dispute fee: positive when charged, negative when returned, else 0. */
    fee: integer("fee").notNull().default(0),
    entryId: text("entry_id"),
    /** YYYY-MM-DD. */
    occurredOn: text("occurred_on").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("provider_adjustments_uq").on(t.provider, t.providerObjectId),
    index("provider_adjustments_payment_idx").on(t.provider, t.providerPaymentId),
    index("provider_adjustments_invoice_idx").on(t.invoiceId),
  ],
);

/** Payouts from the provider to the bank, suggested as matches for bank deposits on Categorize. */
export const providerPayouts = sqliteTable(
  "provider_payouts",
  {
    provider: text("provider").notNull(),
    payoutId: text("payout_id").notNull(),
    amount: integer("amount").notNull(),
    /** YYYY-MM-DD. */
    arrivalDate: text("arrival_date").notNull(),
    status: text("status").notNull(),
    /** Set when the owner accepts the suggestion: the deposit and its transfer entry. */
    bankTxnId: text("bank_txn_id"),
    entryId: text("entry_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("provider_payouts_uq").on(t.provider, t.payoutId),
    index("provider_payouts_amount_idx").on(t.amount),
  ],
);

// ---------------------------------------------------------------------------
// Recurring templates
// ---------------------------------------------------------------------------

/**
 * A template that creates an invoice, bill, or journal entry on a schedule. Occurrence n's date is
 * computed from `start_date` and n (packages/core/src/recurrence.ts), never from the previous date,
 * so a template anchored on the 31st doesn't drift to the 28th. `next_date` is a stored copy of
 * occurrence `next_index`, null once the template has ended.
 */
export const recurringTemplates = sqliteTable(
  "recurring_templates",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["invoice", "bill", "entry"] }).notNull(),
    name: text("name").notNull(),
    contactId: text("contact_id").references(() => contacts.id),
    runMode: text("run_mode", { enum: ["draft", "post", "post_and_send"] })
      .notNull()
      .default("draft"),
    status: text("status", { enum: ["proposed", "active", "paused", "ended", "archived"] })
      .notNull()
      .default("active"),
    unit: text("unit", { enum: ["day", "week", "month", "year"] }).notNull(),
    interval: integer("interval").notNull().default(1),
    /** Day of the month (1-31, clamped to short months) or -1 for the last day; month and year units only. */
    anchorDay: integer("anchor_day"),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    maxOccurrences: integer("max_occurrences"),
    nextIndex: integer("next_index").notNull().default(0),
    nextDate: text("next_date"),
    lastRunDate: text("last_run_date"),
    lastError: text("last_error"),
    lastErrorAt: text("last_error_at"),
    templateJson: text("template_json").notNull(),
    createdByActor: text("created_by_actor").notNull().default("user"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("recurring_templates_due_idx").on(t.status, t.nextDate)],
);

/**
 * One row per schedule slot a template has used: the idempotency key (one run per template and
 * date), the run history, the link from a generated document back to its template, and the email
 * outbox for templates that send invoices.
 */
export const recurringRuns = sqliteTable(
  "recurring_runs",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => recurringTemplates.id),
    occurrenceIndex: integer("occurrence_index").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    status: text("status", { enum: ["created", "skipped"] }).notNull(),
    docType: text("doc_type", { enum: ["invoice", "bill", "entry"] }),
    docId: text("doc_id"),
    sendStatus: text("send_status", { enum: ["pending", "sent", "failed", "not_needed"] })
      .notNull()
      .default("not_needed"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("recurring_runs_template_date_uq").on(t.templateId, t.scheduledDate),
    index("recurring_runs_doc_idx").on(t.docType, t.docId),
    index("recurring_runs_send_idx").on(t.sendStatus),
  ],
);

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

export const bankConnections = sqliteTable("bank_connections", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["plaid"] })
    .notNull()
    .default("plaid"),
  itemId: text("item_id").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  institutionName: text("institution_name"),
  institutionId: text("institution_id"),
  status: text("status", { enum: ["active", "needs_reauth", "error", "disconnected"] })
    .notNull()
    .default("active"),
  errorCode: text("error_code"),
  /** Plaid's message from the last failed sync; cleared with `errorCode`. */
  errorMessage: text("error_message"),
  syncCursor: text("sync_cursor"),
  /** Last successful sync. */
  lastSyncedAt: text("last_synced_at"),
  /** Last completed sync, successful or not. */
  lastSyncAttemptAt: text("last_sync_attempt_at"),
  /** Counts from the last successful sync. */
  lastSyncAdded: integer("last_sync_added"),
  lastSyncModified: integer("last_sync_modified"),
  lastSyncRemoved: integer("last_sync_removed"),
  /** Plaid reported accounts at this login that aren't linked yet (NEW_ACCOUNTS_AVAILABLE). */
  newAccountsAvailable: integer("new_accounts_available", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
});

export const bankAccounts = sqliteTable(
  "bank_accounts",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id"),
    ledgerAccountId: text("ledger_account_id")
      .notNull()
      .references(() => accounts.id),
    providerAccountId: text("provider_account_id"),
    name: text("name").notNull(),
    mask: text("mask"),
    kind: text("kind", { enum: ["checking", "savings", "credit_card", "other"] })
      .notNull()
      .default("checking"),
    currency: text("currency").notNull().default("USD"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("bank_accounts_ledger_uq").on(t.ledgerAccountId)],
);

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  bankAccountId: text("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  source: text("source", { enum: ["plaid", "csv", "ofx", "qfx"] }).notNull(),
  filename: text("filename"),
  fileHash: text("file_hash"),
  rowCount: integer("row_count").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull().default(now),
});

export const bankTransactions = sqliteTable(
  "bank_transactions",
  {
    id: text("id").primaryKey(),
    bankAccountId: text("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    providerTransactionId: text("provider_transaction_id"),
    pendingTransactionId: text("pending_transaction_id"),
    batchId: text("batch_id"),
    date: text("date").notNull(),
    /** Signed from the org's perspective: positive = money into the account. */
    amount: integer("amount").notNull(),
    description: text("description").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    payee: text("payee"),
    isPending: integer("is_pending", { mode: "boolean" }).notNull().default(false),
    dedupeHash: text("dedupe_hash").notNull(),
    status: text("status", { enum: ["new", "categorized", "matched", "excluded"] })
      .notNull()
      .default("new"),
    matchedEntryId: text("matched_entry_id"),
    ruleId: text("rule_id"),
    suggestionJson: text("suggestion_json"),
    reviewItemId: text("review_item_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("bank_tx_provider_uq")
      .on(t.bankAccountId, t.providerTransactionId)
      .where(sql`${t.providerTransactionId} is not null`),
    uniqueIndex("bank_tx_dedupe_uq").on(t.bankAccountId, t.dedupeHash),
    index("bank_tx_status_idx").on(t.status, t.date),
    index("bank_tx_account_date_idx").on(t.bankAccountId, t.date),
  ],
);

/**
 * Receipt inbox (#89): a receipt captured when someone pays, before its bank transaction exists.
 * Matched to the card charge once the feed brings it (`matched_bank_txn_id`, at most one receipt
 * per transaction), or suggested on one (`suggested_bank_txn_id`), or booked on its own as a bill
 * or entry. Not a ledger record: changes apply at once and are audited.
 */
export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: ["inbox", "matched", "booked", "dismissed"] })
      .notNull()
      .default("inbox"),
    merchant: text("merchant"),
    /** YYYY-MM-DD, and HH:MM when known. */
    receiptDate: text("receipt_date").notNull(),
    receiptTime: text("receipt_time"),
    /** What the card is charged, tip included (positive cents). */
    amount: integer("amount"),
    /** The total before the tip, for matching a charge that includes a tip added later. */
    preTipAmount: integer("pre_tip_amount"),
    taxAmount: integer("tax_amount"),
    tipAmount: integer("tip_amount"),
    /** "Paid with": the bank or card account the charge should show up on. */
    bankAccountId: text("bank_account_id").references(() => bankAccounts.id),
    /** The expense account it should be categorized to. */
    accountId: text("account_id").references(() => accounts.id),
    contactId: text("contact_id").references(() => contacts.id),
    memo: text("memo"),
    businessPurpose: text("business_purpose"),
    attendees: text("attendees"),
    location: text("location"),
    attachmentId: text("attachment_id").references(() => attachments.id),
    extractionSource: text("extraction_source", { enum: ["manual", "assistant"] })
      .notNull()
      .default("manual"),
    matchedBankTxnId: text("matched_bank_txn_id").references(() => bankTransactions.id),
    matchMethod: text("match_method", { enum: ["auto", "manual", "confirmed"] }),
    matchedAt: text("matched_at"),
    suggestedBankTxnId: text("suggested_bank_txn_id").references(() => bankTransactions.id),
    /** Transactions a person said are not this receipt; never matched or suggested again. */
    rejectedTxnIdsJson: text("rejected_txn_ids_json").notNull().default("[]"),
    bookedTargetType: text("booked_target_type", { enum: ["bill", "journal_entry"] }),
    bookedTargetId: text("booked_target_id"),
    dismissedReason: text("dismissed_reason"),
    createdBy: text("created_by"),
    createdByActor: text("created_by_actor").notNull().default("user"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("receipts_status_idx").on(t.status),
    index("receipts_amount_date_idx").on(t.amount, t.receiptDate),
    index("receipts_suggested_idx").on(t.suggestedBankTxnId),
    uniqueIndex("receipts_matched_txn_uq")
      .on(t.matchedBankTxnId)
      .where(sql`${t.matchedBankTxnId} is not null`),
    check("receipts_status_ck", sql`${t.status} in ('inbox','matched','booked','dismissed')`),
    check("receipts_extraction_source_ck", sql`${t.extractionSource} in ('manual','assistant')`),
    check(
      "receipts_match_method_ck",
      sql`${t.matchMethod} is null or ${t.matchMethod} in ('auto','manual','confirmed')`,
    ),
    check("receipts_amount_pos", sql`${t.amount} is null or ${t.amount} > 0`),
  ],
);

export const csvProfiles = sqliteTable("csv_profiles", {
  id: text("id").primaryKey(),
  bankAccountId: text("bank_account_id")
    .notNull()
    .unique()
    .references(() => bankAccounts.id),
  columnMapJson: text("column_map_json").notNull(),
  dateFormat: text("date_format").notNull(),
  amountMode: text("amount_mode", { enum: ["signed", "debit_credit", "amount_type"] }).notNull(),
  signConvention: text("sign_convention", { enum: ["positive_is_deposit", "positive_is_withdrawal"] })
    .notNull()
    .default("positive_is_deposit"),
  skipRows: integer("skip_rows").notNull().default(0),
});

export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(100),
  conditionsJson: text("conditions_json").notNull(),
  actionsJson: text("actions_json").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  timesApplied: integer("times_applied").notNull().default(0),
  createdByActor: text("created_by_actor").notNull().default("user"),
  createdAt: text("created_at").notNull().default(now),
});

export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    itemType: text("item_type", {
      enum: [
        "journal_entry",
        "bank_categorization",
        "rule",
        "invoice_draft",
        "bill_draft",
        "entry_replacement",
        "payment_redate",
        "import_batch",
        "recurring_template",
      ],
    }).notNull(),
    itemId: text("item_id").notNull(),
    proposedByActor: text("proposed_by_actor").notNull(),
    proposedById: text("proposed_by_id"),
    reason: text("reason").notNull(),
    rationale: text("rationale"),
    payloadJson: text("payload_json"),
    originalPayloadJson: text("original_payload_json"),
    amount: integer("amount"),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("review_items_status_idx").on(t.status, t.createdAt)],
);

export const reviewPolicy = sqliteTable("review_policy", {
  id: text("id").primaryKey(),
  name: text("name"),
  actor: text("actor").notNull(),
  conditionJson: text("condition_json").notNull().default("{}"),
  action: text("action", { enum: ["auto_approve", "require_review"] }).notNull(),
  priority: integer("priority").notNull().default(100),
});

export const reconciliations = sqliteTable("reconciliations", {
  id: text("id").primaryKey(),
  bankAccountId: text("bank_account_id")
    .notNull()
    .references(() => accounts.id),
  statementEndDate: text("statement_end_date").notNull(),
  statementEndingBalance: integer("statement_ending_balance").notNull(),
  beginningBalance: integer("beginning_balance").notNull().default(0),
  clearedBalance: integer("cleared_balance").notNull().default(0),
  status: text("status", { enum: ["in_progress", "completed", "undone"] })
    .notNull()
    .default("in_progress"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull().default(now),
  completedBy: text("completed_by"),
  completedAt: text("completed_at"),
  undoneBy: text("undone_by"),
  undoneAt: text("undone_at"),
});

export const reconciliationItems = sqliteTable(
  "reconciliation_items",
  {
    reconciliationId: text("reconciliation_id")
      .notNull()
      .references(() => reconciliations.id),
    journalLineId: text("journal_line_id")
      .notNull()
      .references(() => journalLines.id),
  },
  (t) => [
    primaryKey({ columns: [t.reconciliationId, t.journalLineId] }),
    index("reconciliation_items_line_idx").on(t.journalLineId),
  ],
);

// ---------------------------------------------------------------------------
// Documents and history
// ---------------------------------------------------------------------------

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  uploadedBy: text("uploaded_by"),
  createdAt: text("created_at").notNull().default(now),
});

export const attachmentLinks = sqliteTable(
  "attachment_links",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attachmentId, t.targetType, t.targetId] }),
    index("attachment_links_target_idx").on(t.targetType, t.targetId),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    userId: text("user_id"),
    apiTokenId: text("api_token_id"),
    oauthClientId: text("oauth_client_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    ip: text("ip"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_log_seq_uq").on(t.seq),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_at_idx").on(t.at),
  ],
);

export const chainCheckpoints = sqliteTable(
  "chain_checkpoints",
  {
    id: text("id").primaryKey(),
    chain: text("chain", { enum: ["ledger", "audit"] }).notNull(),
    seq: integer("seq").notNull(),
    headHash: text("head_hash").notNull(),
    reason: text("reason"),
    createdAt: text("created_at").notNull().default(now),
    exportedTo: text("exported_to"),
  },
  (t) => [index("chain_checkpoints_chain_idx").on(t.chain, t.seq)],
);

/**
 * Public timestamps of the chain heads (SPEC §6.5, #11): one row per service (OpenTimestamps
 * calendar or RFC 3161 authority) per digest. Append-only apart from a pending proof being
 * completed or failed (triggers in migration 0009).
 */
export const chainAnchors = sqliteTable(
  "chain_anchors",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["ots", "rfc3161"] }).notNull(),
    /** Calendar or TSA URL. */
    service: text("service").notNull(),
    ledgerSeq: integer("ledger_seq").notNull(),
    ledgerHash: text("ledger_hash").notNull(),
    auditSeq: integer("audit_seq").notNull(),
    auditHash: text("audit_hash").notNull(),
    /** SHA-256 of the anchor preimage (docs/chain-format.md), hex. */
    digest: text("digest").notNull(),
    status: text("status", { enum: ["pending", "complete", "failed"] }).notNull(),
    /** Base64 of the .ots file or the DER TimeStampResp (.tsr); null when the request failed. */
    proof: text("proof"),
    /** TSA genTime, or the Bitcoin block time. */
    attestedAt: text("attested_at"),
    blockHeight: integer("block_height"),
    /** What asked for it: daily, manual, year_end. */
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("chain_anchors_ledger_idx").on(t.ledgerSeq),
    index("chain_anchors_digest_idx").on(t.digest),
    check("chain_anchors_kind_ck", sql`${t.kind} in ('ots','rfc3161')`),
    check("chain_anchors_status_ck", sql`${t.status} in ('pending','complete','failed')`),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("comments_target_idx").on(t.targetType, t.targetId)],
);

export const orgNotes = sqliteTable("org_notes", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["profile", "note"] }).notNull(),
  bodyMd: text("body_md").notNull(),
  authorActor: text("author_actor").notNull(),
  authorId: text("author_id"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const schemaMeta = sqliteTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
