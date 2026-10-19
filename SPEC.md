# Cosimo: Self-Hosted Double-Entry Bookkeeping

**Requirements Specification v0.2**
Product name: **Cosimo**, after Cosimo de' Medici, who built the Medici bank on disciplined double-entry books. The CLI binary, package, config prefix, and environment variables all use `cosimo` / `COSIMO_`. Domain and GitHub organization are still to be confirmed (see Open Decisions).

**Changes in v0.2:** product named Cosimo; added the tamper-evident ledger chain (Section 6.5), the review queue (Section 7.5), soft and hard lock dates (Section 6), business context for AI with a bundled agent skill (Section 10.3), and OAuth for MCP connections (Section 10.4).

---

## 0. How to Use This Document

This spec is written so a coding agent can build the complete system in one session.

- Treat every **MUST** as a requirement and every **SHOULD** as expected unless it conflicts with a MUST.
- The tech stack in Section 4 is pinned. Do not substitute alternatives.
- Build in the order given in Section 16. Each phase must leave the app runnable, tested, and committed.
- When something is ambiguous, choose the simplest option that preserves the invariants in Section 6, and record the choice in `DECISIONS.md`.
- Section 15 lists the acceptance tests that define "done."

---

## 1. Summary and Goals

Cosimo is an open-source, self-hosted bookkeeping application for freelancers, consultants, and small businesses. It replaces QuickBooks Online, Xero, and Wave for owners who want to own their data and pay nothing for software.

**Goals**

1. Correct double-entry accounting with invariants enforced in the database.
2. Multiple independent users, and multiple organizations per user.
3. Runs on local SQLite or on Turso (libSQL) with the same code.
4. Anyone can run their own instance, locally or on their own server, from a single command.
5. Setup works equally well for a human at a terminal and for an AI agent acting for that human.
6. Bank feeds through Plaid using the instance owner's own Plaid keys, with file import as an equal alternative.
7. Everything available in the UI is available through a documented API.
8. Output that a CPA accepts at year-end without rework.
9. Tamper-evident history: any change to posted records after the fact is detectable.
10. Safe AI assistance: anything proposed by an AI agent or an automated rule can be held for human review before it touches the books.

---

## 2. Non-Goals (v1)

- Payroll
- Inventory and cost of goods tracking
- Sales tax calculation or filing
- Tax return preparation or e-filing
- Multi-currency (every amount carries a currency field so this can be added later; v1 rejects any currency other than the org base currency)
- A hosted SaaS offering run by the project
- Native mobile apps (the web UI MUST be usable on a phone)

---

## 3. Users, Organizations, and Roles

### 3.1 Concepts

- **User**: a person with a login. A user can belong to any number of organizations.
- **Organization (org)**: one set of books for one business entity. All accounting data belongs to exactly one org.
- **Membership**: links a user to an org with a role.
- **Instance**: one running deployment of Cosimo. An instance hosts many users and many orgs.
- **Instance admin**: a user flag, separate from org roles, allowing instance settings, user management, and org creation limits.

### 3.2 Roles (per org)

| Role | Permissions |
|---|---|
| Owner | Everything, including archiving the org, managing members, managing bank connections, and changing lock dates. At least one owner MUST always exist. The web UI's Danger zone lets an owner archive a real org (data kept; CLI-restorable) or permanently delete a demo org (`is_sample`); permanent deletion of real books stays CLI-only. |
| Bookkeeper | Create and edit transactions, invoices, bills, rules, and reconciliations. Approve or reject items in the review queue. Cannot manage members, delete the org, or move lock dates. |
| Accountant | Read everything, run and export all reports, add comments. Cannot change data. Intended for a CPA. |
| Viewer | Read dashboards and reports only. |

### 3.3 Instance Modes

- **Single-user mode** (default for local installs): one instance admin is created during setup and no public signup exists.
- **Invite-only mode** (default for server installs): users join only through an invitation from an org owner or instance admin.
- **Open signup mode**: anyone can register. Off by default. MUST display a warning when enabled.

### 3.4 Authentication

- Email and password, hashed with argon2id (`Bun.password`).
- Optional TOTP two-factor authentication with recovery codes.
- Sessions in HTTP-only, Secure, SameSite=Lax cookies. Session lifetime configurable, default 30 days with idle timeout of 7 days.
- Personal API tokens scoped to one org and one role no higher than the user's own role. Tokens are shown once and stored hashed.
- Password reset by email when SMTP is configured. When SMTP is not configured, the CLI command `cosimo user reset-password` MUST work.
- One-time **claim links** (see Section 13.4) so an agent can set up an instance without ever handling the human's password.
- An OAuth 2.1 authorization server for MCP clients (Section 10.3).

---

## 4. Architecture and Pinned Stack

| Concern | Choice |
|---|---|
| Runtime | Bun (latest stable) |
| Distribution | Single executable per platform via `bun build --compile`, with web assets embedded. Also a Docker image. |
| HTTP framework | Hono |
| Validation and OpenAPI | Zod with `@hono/zod-openapi` |
| Database driver | `@libsql/client` (supports local SQLite files and Turso URLs with identical code) |
| ORM and migrations | Drizzle ORM and Drizzle Kit |
| Web UI | React, Vite, TanStack Query, TanStack Router, Tailwind CSS. Built to static assets and served by the same Hono process. |
| PDF generation | `pdf-lib` (pure JavaScript, no headless browser) |
| Email | `nodemailer` with user-supplied SMTP |
| Object storage | Local filesystem by default; S3-compatible storage optional (Bun's built-in S3 client) |
| Scheduler | In-process scheduler for Plaid sync, backups, and reminders |
| Tests | `bun test` for unit and integration; Playwright for end-to-end |

### 4.1 Process Model

One process serves the API, the web UI, the MCP endpoint, webhooks, and scheduled jobs. No separate worker, queue, or cache is required. The design MUST NOT require Redis, Postgres, or any other service.

### 4.2 Database Topology

- **System database**: users, sessions, API tokens, organizations registry, memberships, invitations, instance settings.
- **One database per organization**: all accounting data for that org.

Rationale: strong isolation, trivial per-org export and deletion, and cheap on Turso.

Storage modes:

| Mode | System DB | Org DBs |
|---|---|---|
| Local | `data/system.db` | `data/orgs/<org_id>.db` |
| Turso | A Turso database URL | Created per org through the Turso Platform API using an API token supplied at setup |

The org registry stores each org's connection URL. Turso auth tokens MUST be encrypted at rest (Section 12).

A single data access layer MUST hide which mode is active. Application code never branches on storage mode except in the connection factory and the org provisioning service.

### 4.3 Repository Layout

```
/apps/server        Hono app, services, jobs, CLI
/apps/web           React UI
/packages/core      Accounting domain logic, pure and fully unit tested
/packages/db        Drizzle schemas, migrations, connection factory
/packages/shared    Zod schemas and types shared by server and web
/scripts            install.sh, install.ps1, release tooling
/deploy             Dockerfile, docker-compose.yml, Caddyfile, fly.toml templates, systemd and launchd units
/docs               User and operator documentation
/skills             Agent skill for bookkeeping workflows (Section 10.3)
AGENTS.md           Instructions for AI agents installing or operating Cosimo
SPEC.md             This document
DECISIONS.md        Choices made during the build
```

---

## 5. Data Model

All IDs are ULIDs stored as TEXT. All timestamps are UTC ISO 8601 TEXT. All money is INTEGER minor units (cents). Floats MUST NOT be used for money anywhere, including the UI and API.

### 5.1 System Database

- `users` (id, email unique, password_hash, name, is_instance_admin, totp_secret_enc, totp_enabled, created_at, disabled_at)
- `sessions` (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
- `api_tokens` (id, user_id, org_id, name, token_hash, role, last_used_at, created_at, revoked_at)
- `organizations` (id, name, db_url, db_token_enc, created_by, created_at, archived_at)
- `memberships` (user_id, org_id, role, created_at) primary key (user_id, org_id)
- `invitations` (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at)
- `claim_links` (id, user_id, token_hash, expires_at, used_at)
- `oauth_clients` (id, client_name, redirect_uris_json, registered_via, created_by, created_at, revoked_at)
  - `registered_via`: dynamic, manual
- `oauth_codes` (code_hash, client_id, user_id, org_id, scope, code_challenge, redirect_uri, expires_at, used_at)
- `oauth_tokens` (id, client_id, user_id, org_id, scope, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at, revoked_at)
- `instance_settings` (key, value_json)

### 5.2 Organization Database

**Settings and structure**

- `org_settings` (legal_name, dba, entity_type, tax_id_last4, address_json, base_currency, fiscal_year_start_month, default_basis, soft_lock_date, hard_lock_date, invoice_prefix, next_invoice_number, logo_attachment_id)
- `accounts` (id, code, name, type, subtype, parent_id, tax_line, is_active, is_system, currency, created_at)
  - `type` is one of: asset, liability, equity, income, expense
  - `subtype` examples: bank, credit_card, accounts_receivable, accounts_payable, owner_equity, owner_draw, retained_earnings, other
  - `tax_line` maps to a Schedule C line or other tax form line for the year-end package
  - System accounts (AR, AP, Retained Earnings, Owner Draw, Uncategorized Income, Uncategorized Expense, Opening Balance Equity) are created automatically, cannot be deleted, and are marked `is_system`
  - Sub-accounts: `parent_id` nests an account under another. A sub-account always has its parent's `type`, `subtype`, and `tax_line`, and changes to the parent cascade down the subtree; a change that would retype an account with posted lines is refused. Entries can post to a parent as well as its sub-accounts. The P&L, Balance Sheet, and chart of accounts roll sub-accounts up into the parent (the parent's own postings appear as "<name> (Other)"); the Trial Balance and General Ledger list every account flat. System accounts can be parents but not sub-accounts. Deactivating a parent deactivates its subtree.

**Ledger**

- `journal_entries` (id, date, memo, status, source_type, source_id, reverses_entry_id, reversed_by_entry_id, created_by, created_by_actor, created_at, posted_at, chain_seq, prev_hash, entry_hash)
  - `status`: draft, pending_review, posted, rejected
  - `created_by_actor`: user, api_token, mcp, rule, system
  - `chain_seq`, `prev_hash`, `entry_hash` are set at posting (Section 6.5)
  - `source_type`: manual, bank_transaction, invoice, invoice_payment, bill, bill_payment, transfer, opening_balance, import, reversal
- `journal_lines` (id, entry_id, account_id, amount, currency, description, contact_id, line_order)
  - `amount` is signed: positive is a debit, negative is a credit

**Contacts, receivables, payables**

- `contacts` (id, kind, name, email, phone, address_json, tax_id_last4, is_1099_vendor, default_account_id, default_terms, notes, archived_at)
  - `kind`: customer, vendor, both
- `invoices` (id, number unique, customer_id, issue_date, due_date, status, currency, subtotal, total, amount_paid, memo, terms, entry_id, sent_at, voided_at)
  - `status`: draft, sent, partial, paid, void
- `invoice_lines` (id, invoice_id, description, quantity_milli, unit_price, amount, income_account_id)
  - Quantities are stored as integer thousandths to avoid floats
- `bills` (id, vendor_id, bill_number, issue_date, due_date, status, total, amount_paid, entry_id, voided_at)
- `bill_lines` (id, bill_id, description, amount, expense_account_id)
- `payments` (id, direction, contact_id, date, amount, bank_account_id, method, reference, entry_id)
  - `direction`: received, sent
- `payment_applications` (payment_id, document_type, document_id, amount)

**Banking**

- `bank_connections` (id, provider, item_id, access_token_enc, institution_name, status, error_code, sync_cursor, last_synced_at, created_at)
  - `provider`: plaid
  - `status`: active, needs_reauth, error, disconnected
- `bank_accounts` (id, connection_id nullable, ledger_account_id, provider_account_id, name, mask, kind, currency, is_active)
- `import_batches` (id, bank_account_id, source, filename, file_hash, row_count, imported_count, duplicate_count, created_by, created_at)
  - `source`: plaid, csv, ofx, qfx
- `bank_transactions` (id, bank_account_id, provider_transaction_id, batch_id, date, amount, description, normalized_description, payee, is_pending, dedupe_hash, status, matched_entry_id, rule_id, created_at)
  - `status`: new, categorized, matched, excluded
  - Unique index on (bank_account_id, provider_transaction_id) where not null
  - Unique index on (bank_account_id, dedupe_hash)
- `csv_profiles` (id, bank_account_id, column_map_json, date_format, amount_mode, sign_convention, skip_rows)
- `rules` (id, name, priority, conditions_json, actions_json, is_active, times_applied)
- `review_items` (id, item_type, item_id, proposed_by_actor, proposed_by_id, reason, rationale, status, decided_by, decided_at, decision_note, created_at)
  - `item_type`: journal_entry, bank_categorization, rule, invoice_draft
  - `status`: pending, approved, rejected, expired
- `review_policy` (id, actor, condition_json, action, priority)
  - `action`: auto_approve, require_review
- `reconciliations` (id, bank_account_id, statement_end_date, statement_ending_balance, cleared_balance, status, completed_by, completed_at)
- `reconciliation_items` (reconciliation_id, journal_line_id)

**Documents and history**

- `attachments` (id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by, created_at)
- `attachment_links` (attachment_id, target_type, target_id)
- `audit_log` (id, seq, at, user_id, api_token_id, oauth_client_id, actor, action, target_type, target_id, before_json, after_json, ip, prev_hash, hash)
- `chain_checkpoints` (id, chain, seq, head_hash, created_at, exported_to)
  - `chain`: ledger, audit
- `comments` (id, target_type, target_id, user_id, body, created_at)
- `org_notes` (id, kind, body_md, author_actor, author_id, created_at, updated_at)
  - `kind`: profile, note
- `schema_meta` (key, value)

---

## 6. Accounting Rules and Invariants

These MUST be enforced in the database (constraints and triggers) and also in `packages/core`. Tests MUST prove each one cannot be violated through the API or by direct SQL through the app's connection.

1. **Balanced entries.** A journal entry cannot move to `posted` unless its lines sum to exactly zero and it has at least two lines.
2. **Immutability.** Posted entries and their lines cannot be updated or deleted. Corrections use reversal: a new entry with every line negated, linked through `reverses_entry_id`, followed by a new correct entry. The UI presents this as "Edit" but performs reverse and replace.
3. **Lock dates.** Two lock dates per org. The **soft lock** blocks bookkeepers, API tokens, rules, and MCP from posting on or before it, while owners can still post with a required note. The **hard lock** blocks everyone. Only owners can move either, and every change is audit logged and checkpointed. A typical pattern is to soft lock each month after reconciling and hard lock the year once the CPA has filed.
4. **Single currency in v1.** Every line's currency equals the org base currency.
5. **Account type integrity.** An account's type cannot change once it has posted lines.
6. **Idempotent imports.** Importing the same file or syncing the same Plaid transactions twice creates no new rows.
7. **Transfers are one entry.** Moving money between two of the org's own accounts produces one entry with two lines and no income or expense.
8. **Documents drive entries.** Invoices, bills, and payments create and reverse their own journal entries. Users cannot edit those entries directly.
9. **Reports tie out.** For any date: the trial balance sums to zero; assets equal liabilities plus equity, including current-year net income; net income on the P&L equals the change in equity from operations.
10. **Audit everything.** Every create, post, reverse, void, delete, settings change, membership change, bank connection change, and review decision writes an audit log row.
11. **Hash chains are unbroken.** Every posted entry and every audit row extends its chain as described in Section 6.5. Rows cannot be inserted into the middle of a chain.
12. **Review before posting.** An entry in `pending_review` cannot affect any balance or report until approved. Rejected entries never post.

### 6.1 Year-End

Closing is virtual. Reports compute retained earnings as the sum of all prior-fiscal-year income and expense. No closing entries are required. Setting the hard lock date to the fiscal year end is the "close."

### 6.2 Cash and Accrual Basis

The ledger is recorded on an accrual basis. Cash-basis reports are derived: revenue and expense from invoices and bills are recognized on the dates payments are applied, allocated proportionally across the document's lines. Entries with no source document appear identically on both bases.

### 6.3 Chart of Accounts Templates

Shipped as data files, selectable at org creation:

- **Sole proprietor / single-member LLC (Schedule C)**: default. Accounts carry Schedule C `tax_line` mappings.
- **Multi-member LLC / partnership (Form 1065)**
- **S corporation (Form 1120-S)**
- **Minimal**: a short list for people who want to build their own

### 6.4 Opening Balances

A guided flow creates one `opening_balance` entry against Opening Balance Equity as of a chosen start date, typically from the last balance sheet of a prior system.

### 6.5 Tamper-Evident Ledger Chain

Each org maintains two append-only hash chains: the **ledger chain** (posted journal entries) and the **audit chain** (audit log rows).

- On posting, an entry receives the next `chain_seq` and `entry_hash = SHA-256(prev_hash || canonical_json(entry and its lines))`. The first entry uses a genesis hash derived from the org ID.
- Canonical JSON is defined precisely in `/docs/chain-format.md`: sorted keys, no insignificant whitespace, integer amounts, and dates as `YYYY-MM-DD`. The same record MUST always hash identically on every platform.
- Reversals are new chain entries. Nothing in the chain is ever rewritten.
- Posting is serialized per org so two entries can never claim the same sequence number.
- **Checkpoints**: after each day with activity and at every lock date change, record the chain head in `chain_checkpoints`. The head hash also appears on every report footer and in the year-end package, so a CPA holding an old report can later confirm the books haven't changed underneath it.
- **Verification**: `cosimo verify <org>` and a button in Settings recompute both chains and report the first broken link, if any. `cosimo doctor` runs a fast check of the last 1,000 links. A full verification runs weekly by default.
- **Public timestamps (anchoring)**: on by default (`anchoring.enabled`). Once a day, when either chain moved, the SHA-256 of a small text naming both chain heads (the anchor preimage, `/docs/chain-format.md`) is timestamped publicly: by OpenTimestamps calendars, whose proofs complete in the Bitcoin blockchain within hours, and by an RFC 3161 timestamp authority (default FreeTSA), whose signed token is immediate. Only that digest leaves the server; OpenTimestamps submissions add a random nonce. Proofs are stored in `chain_anchors`, included in exports, backups, and the year-end package, and downloadable from Settings. Anchoring never blocks posting, checkpoints, backups, or the year-end package, and a chain whose recent links don't verify is never timestamped.
- **The claim**: a proof says "the books through ledger link N existed in this form by time T", and anyone can check it with standard tools (`ots verify`, `openssl ts -verify`) and an export, without trusting Cosimo or its database. Verification fails when a stored anchor's heads no longer match the chains or its proof doesn't commit to its digest (and, with network access, when a Bitcoin attestation doesn't match its block). **Coverage** is reported but never fails verification: how far the ledger is timestamped (`anchored_through`), when the first timestamp was made, links not yet timestamped, and entries first timestamped more than 48 hours after posting.
- This makes tampering detectable, not impossible. Someone with full database access could rewrite the whole chain, but the rewrite can't obtain a proof dated before the rewrite, so it shows up as a timestamp mismatch or as a gap in coverage, and against any checkpoint or report held elsewhere. Documentation MUST say this plainly.

---

## 7. Bank Data

### 7.1 Plaid (Bring Your Own Keys)

- The instance owner supplies their own Plaid `client_id`, `secret`, and environment (`sandbox` or `production`). Keys are set during setup or later in instance settings. An org owner MAY override with org-level keys.
- Plaid secrets and access tokens MUST be encrypted at rest (Section 12) and never returned by any API.
- Use Plaid Link for connecting, `/transactions/sync` with a stored cursor for data, and update mode for reauthentication.
- Handle `added`, `modified`, and `removed` from sync. Pending transactions are stored with `is_pending` and cannot be categorized into posted entries until they post. When a pending transaction is replaced by its posted version, the pending row is removed.
- **Webhooks**: when the instance has a public HTTPS URL, register a webhook and verify Plaid webhook signatures. Sync on `SYNC_UPDATES_AVAILABLE`.
- **Polling**: always run a scheduled sync (default every 6 hours) so local instances without a public URL still work.
- Surface connection errors clearly with a one-click reconnect.
- Documentation MUST explain that Plaid production access requires the user to complete Plaid's own onboarding, that some institutions require an OAuth redirect URI registered in the Plaid dashboard, and that everything works in Sandbox and through file import in the meantime.

### 7.2 File Import

Equal in importance to Plaid.

- Formats: CSV, OFX, QFX.
- CSV import has a column mapper with preview. Mappings are saved per bank account as a `csv_profile` and reused automatically.
- Amount modes: single signed column, separate debit and credit columns, or amount plus type column. Sign convention is configurable per profile.
- **Deduplication hash**: SHA-256 of (bank_account_id, date, amount, normalized description, occurrence index), where occurrence index distinguishes identical transactions on the same day in the same file.
- Show a summary before committing: rows read, new, duplicates, errors.

### 7.3 Categorization

The Categorize screen (Banking → Categorize) is the main daily workflow. For each new bank transaction a user can:

- **Categorize**: pick an account (and optional contact and memo). Creates an entry.
- **Split**: divide across multiple accounts.
- **Match**: link to an existing entry, such as an invoice payment or bill payment already recorded.
- **Transfer**: mark as a transfer to another org account. If the matching side already exists as a bank transaction, pair them into one entry.
- **Exclude**: ignore, for example a duplicate the bank itself produced.

**Rules** apply automatically to new transactions in priority order. Conditions: description contains or matches regex, amount equals or in range, direction, bank account. Actions: set account, set contact, set memo, mark as transfer to an account, or auto-post. Auto-post is off by default per rule. A "create rule from this" action is available on every categorization.

**Suggestions**: when no rule matches, suggest an account based on the most recent categorization of the same normalized payee.

### 7.4 Reconciliation

- Start from a bank or credit card account, enter statement end date and ending balance.
- Check off cleared lines until the difference is zero, then complete.
- Completed reconciliations are locked. Undoing requires an owner and is audit logged.
- Show unreconciled items and a reconciliation report.

### 7.5 Review Queue

A single queue where proposed changes wait for a human decision before they affect the books.

**What lands in the queue**

- Anything proposed through MCP (Section 10.2), unless a review policy auto-approves it.
- Categorizations produced by rules marked "suggest" rather than "auto-post."
- Entries created by API tokens configured as `propose_only`.
- Imported history from other products (Section 14.2), reviewed as one batch.
- Any entry above an org-configurable amount threshold, whatever its source.

**Review policies** decide what is auto-approved. Defaults:

| Actor | Default |
|---|---|
| Human user in the UI | Auto-approve |
| API token | Auto-approve unless the token is `propose_only` |
| Rule with auto-post on | Auto-approve |
| Rule with auto-post off | Require review |
| MCP / AI agent | Require review |
| Any actor, amount over threshold (default $2,500) | Require review |

Owners can change policies. For example: "auto-approve MCP categorizations under $100 to accounts used for this payee before."

**Review screen**

- Shows each item with who proposed it, when, the proposed accounts and amounts, and the proposer's rationale. MCP tools MUST accept a short `rationale` string and the UI displays it.
- Approve, reject with a note, or edit and approve. Edit and approve records both the original proposal and the change.
- Bulk approve for items the user has filtered and reviewed.
- Keyboard-first, like Categorize.
- Dashboard shows the pending count. Items pending more than 30 days expire and are listed for cleanup.

---

## 8. Receivables and Payables

### 8.1 Invoices

- Create, edit (while draft), send, record payment, void. Voiding reverses the entry.
- Numbering from `invoice_prefix` and `next_invoice_number`, unique per org.
- Terms and due date agree. The due date is authoritative and the terms describe it. Terms are a preset (Due on receipt, Net 7/10/15/30/45/60/90, Due end of month, Due end of next month, On due date) or custom text. A preset computes the due date; a due date without terms derives them (the matching preset, else "On due date"). Terms and a due date that disagree are rejected (`terms_conflict`), "On due date" needs a due date, and a due date can't be before the issue date. With neither given, the customer's `default_terms`, then the org's `default_terms`, apply. Changing only the issue date of a draft moves a preset's due date. Custom text is kept and not checked.
- PDF generated with org name, logo, address, invoice lines, terms, and payment instructions. Template is simple and professional. Custom colors and logo are configurable.
- Send by email through the instance's SMTP settings, with the PDF attached. Record `sent_at`.
- Optional reminder emails for overdue invoices, off by default.
- Partial payments and overpayments supported. Overpayment creates a customer credit applicable to future invoices.
- Recurring invoice templates are a SHOULD for v1.
- Online payments (#55), behind a payment provider interface with Stripe first (see `docs/stripe.md`). An owner adds their own Stripe key and chooses card, ACH Direct Debit, and US bank transfer for the org. Each invoice can offer a "Pay online" link, printed and linked on the PDF and in the email. The link redirects to a Stripe Checkout session for the balance due; paid, processing, draft, and void invoices get a small status page instead. The link's token is derived from the master key and only its SHA-256 is stored. Payments are recorded by the `integration` actor into a clearing account, with Stripe's fee posted against it, and never twice (unique provider payment ID). They auto-approve by default, subject to the threshold and review policies; a payment that doesn't match an open invoice (unknown, void, already paid, or overpaid) always goes to review. A `manual_link` mode prints a pasted payment URL instead. Refunds and disputes (chargebacks) of recorded payments are proposed as journal entries that always go to review: a refund debits Refunds and Allowances, a dispute debits a Chargebacks expense and the fee account from the dispute's balance transactions, and funds returned are proposed as the reversal; each is proposed once (unique provider object ID in `provider_adjustments`). Payouts are stored and suggested on Categorize as a transfer from the clearing account to a matching deposit, and linked when accepted. Customers' unapplied cash balances (bank transfers) are shown on the invoice and the admin status page.

### 8.2 Bills and Vendors

- Enter bills with lines, due dates, and attachments. Record payments against them.
- `is_1099_vendor` flag on contacts, with a 1099 summary report of payments by vendor and year.

### 8.3 Payments

- A received payment can apply to multiple invoices. A sent payment can apply to multiple bills.
- Payments can be matched to bank transactions from the Categorize screen.

---

## 9. Reports

All reports take a date range (or as-of date), basis (cash or accrual), and optional comparison period (prior period, prior year). All export to CSV and PDF. All drill down to the underlying entries.

- Profit and Loss
- Balance Sheet
- Trial Balance
- General Ledger detail (all lines for one or all accounts)
- Cash Flow (indirect method)
- AR Aging and AP Aging (current, 1 to 30, 31 to 60, 61 to 90, over 90 days)
- 1099 Vendor Summary
- Tax Line Summary: totals by `tax_line`, for example Schedule C lines
- Reconciliation reports
- Audit log report

### 9.1 Year-End Package

One action produces a ZIP containing: P&L, Balance Sheet, Trial Balance, General Ledger, Tax Line Summary, 1099 Summary, AR and AP aging as of year end, and reconciliation reports for the final month. Both PDF and CSV versions. Named `<org>-<year>-year-end.zip`.

### 9.2 Dashboard

Cash balance across bank accounts, income and expense for the current month and year to date, count of transactions needing review, overdue invoices, and bank connections needing attention.

---

## 10. API and MCP

### 10.1 REST API

- Base path `/api/v1`. JSON only. OpenAPI 3.1 document at `/api/v1/openapi.json` and an interactive reference at `/api/docs`.
- Org-scoped routes: `/api/v1/orgs/{orgId}/...`
- Authentication by session cookie (browser, with CSRF protection) or `Authorization: Bearer <token>`.
- The web UI MUST use only this API. No UI-only endpoints.
- Money in the API is integer cents plus an ISO currency code. Dates are `YYYY-MM-DD`.
- List endpoints use cursor pagination.
- Mutating endpoints accept an `Idempotency-Key` header.
- Errors use a consistent shape: `{ "error": { "code": "...", "message": "...", "details": {...} } }`.

### 10.2 MCP Server

Expose a Model Context Protocol endpoint at `/mcp` (streamable HTTP), authenticated with an API token. It lets an AI assistant work with the books under the token's role.

Tools, at minimum:

- `list_orgs`, `get_account_balances`, `run_report`, `get_cash_snapshot`
- `list_uncategorized_transactions`, `categorize_transaction`, `create_rule`
- `search_transactions`, `get_entry`, `list_entries`, `create_manual_entry` (draft only unless the token role allows posting)
- `list_contacts`, `create_contact`, `update_contact`, `list_invoices`, `create_invoice_draft`
- `list_bills`, `list_bill_payments`, `list_invoice_payments`, `create_bill_draft`, `record_invoice_payment`, `record_bill_payment`
- `propose_reversal`, `propose_replacement`, `propose_payment_date_change`, `withdraw_proposal`

`get_entry` and `list_entries` fill in each line's account code/name and, when set, contact name, and whether the entry has an attachment; the REST `EntryView` itself carries only IDs.

Corrections to posted entries go through the review queue like any other write. `propose_reversal` creates a pending reversal entry. `propose_replacement` creates one `entry_replacement` review item: approving it posts the reversal and the corrected entry together, and rejecting it posts neither. `propose_payment_date_change` creates one `payment_redate` review item: approving it reverses the payment's entry on its original date, posts the same lines on the new date, and moves the payment, its applications, and any matched bank transaction to the new entry. `record_invoice_payment` proposes a customer payment applied to one or more invoices (optionally from a bank deposit); `record_bill_payment` proposes a vendor payment applied to bills. Payments in either direction move through a bank, other current asset, credit card, other current liability, or owner's equity account (so an owner-paid bill settles Dr Accounts Payable / Cr the liability or equity account), never accounts payable or receivable; the tool counts payments already waiting in review against each invoice's open balance, and approving any invoice or bill payment from the review queue is refused (409 `over_applied`) if its documents no longer have that much open. Entries created by documents (invoices, bills, payments) can't be reversed or replaced through MCP; a payment's date is the one correction allowed. An assistant may withdraw its own pending proposals with `withdraw_proposal` (the item ends rejected with a note, and every side effect unwinds as on rejection); it can't withdraw anyone else's, and it never approves or rejects. Void, delete, and changing lock dates are not exposed through MCP.

`create_contact` and `update_contact` apply directly, without a review item, because contacts don't touch the books; the audit log records them.

MCP tools that change the books MUST accept a `rationale` string. Every MCP write to the books lands in the review queue (Section 7.5) unless a review policy auto-approves it. Write tools return the review item ID and its status so the assistant can tell the human what is waiting. Additional tools: `list_pending_reviews` and `get_review_item`. Approving is not exposed through MCP in v1, so an AI cannot approve its own proposals.

### 10.3 Business Context for AI

Each org has a **business profile** (structured: what the business does, how it bills, typical customers and vendors, which accounts to use for recurring items) and a **bookkeeping notes** document (free-form markdown).

- Both are editable in Settings and exposed to MCP as resources (`org://profile`, `org://notes`).
- The MCP tool `append_note` lets an assistant record what it learns, such as "Payments from Acme are retainer billing, account 4010." Appended notes are attributed and dated, and owners can edit or delete any note.
- Notes are included in export and backup. They never contain secrets or bank credentials.

**Follow-on suggestions.** When an assistant categorizes or posts something that usually implies a related entry, it can propose that entry into the review queue with a rationale. Examples: a prepaid annual software subscription suggests monthly amortization entries; an invoice paid late with a fee suggests the fee entry. These always go through review.

**Bundled skill.** The repository ships an agent skill at `/skills/cosimo-bookkeeping/SKILL.md` that teaches an AI assistant the standard workflows: monthly close (import, categorize, reconcile, review, soft lock), invoice follow-up, and year-end package preparation. It references MCP tool names and reads the business profile first. Installing it is described in `AGENTS.md`.

### 10.4 Connecting AI Clients (OAuth)

The MCP endpoint MUST support OAuth 2.1 per the MCP authorization specification, so connecting Claude or another client works as a normal "add connector" flow with only the server URL.

- Publish OAuth protected resource metadata and authorization server metadata at the standard well-known paths.
- Support dynamic client registration so a client can register itself. Instance admins can disable dynamic registration and instead pre-register clients manually from Settings, which issues a client ID and secret.
- Authorization code flow with PKCE (S256 only). Short-lived access tokens (1 hour) and rotating refresh tokens (30 days).
- The consent screen shows the client name, asks the user to pick one org, and shows the role granted, capped at the user's own role. The default grant for AI clients is Bookkeeper with all writes routed through the review queue.
- Users can see and revoke connected clients under Settings, and owners can see all clients connected to their org.
- Static API tokens remain supported for scripts and for clients that lack OAuth support.
- Redirect URIs are validated exactly. `localhost` redirect URIs are allowed only for loopback clients.

---

## 11. Web UI

- Navigation: Dashboard, Banking (review, rules, reconcile, connections, import), Sales (invoices, customers), Expenses (bills, vendors), Accounting (chart of accounts, journal entries), Reports, Settings.
- Org switcher in the header for users with more than one org.
- Keyboard-first Categorize screen: arrow keys to move, a shortcut to accept suggestion, typeahead account picker.
- Responsive layout usable on a phone for Categorize, receipt upload from the camera, and dashboard.
- Light and dark themes.
- All amounts right-aligned in tabular numerals. Negative amounts shown in parentheses in reports.
- Accessibility: keyboard navigable, labeled inputs, sufficient contrast.

---

## 12. Security

- A **master key** (32 random bytes) is generated at setup and stored in the instance config file with mode 0600, or supplied through the `COSIMO_MASTER_KEY` environment variable. It encrypts Plaid secrets, Plaid access tokens, Stripe keys and webhook signing secrets, Turso tokens, TOTP secrets, and SMTP passwords using AES-256-GCM.
- Setup MUST tell the user plainly that losing the master key makes stored bank connections unrecoverable, and MUST print where it is stored.
- CSRF protection for cookie-authenticated requests.
- Rate limiting on login, password reset, claim links, and invitation acceptance.
- Security headers: CSP, HSTS when served over HTTPS, frame denial, no sniffing.
- Webhook signature verification for Plaid and for Stripe (`Stripe-Signature` HMAC-SHA256 with the endpoint's signing secret, 5-minute tolerance). Each Stripe event is stored once by its ID.
- OAuth tokens, codes, and client secrets are stored hashed. Rate limiting also covers dynamic client registration and token endpoints.
- Secrets never appear in logs, API responses, error messages, or exports. Export files include a flag noting secrets were omitted.
- Uploaded attachments are served with `Content-Disposition: attachment` unless they are images or PDFs, and are never executed.
- Dependency audit in CI.

---

## 13. Setup and Deployment

This section defines the primary adoption path. The target experience: a person, or an AI agent acting for them, goes from nothing to a running, secured instance with one command and a short Q&A.

### 13.1 The One Command

macOS and Linux:

```sh
curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/steve-lomnes/cosimo/releases/latest/download/install.ps1 | iex
```

Alternatives, documented alongside:

```sh
docker run -it --rm -v cosimo:/data ghcr.io/<org>/cosimo init
bunx cosimo init
```

### 13.2 What the Installer Does

`install.sh` MUST be short, readable, and POSIX `sh` compatible. It:

1. Detects OS and architecture (macOS and Linux, x64 and arm64).
2. Downloads the matching release binary from GitHub Releases.
3. Verifies the SHA-256 checksum against the signed checksums file for that release. Aborts on mismatch.
4. Installs to `~/.local/bin/cosimo` (or `/usr/local/bin` when run as root) and advises on PATH if needed.
5. Runs `cosimo init`, passing through any arguments given after `sh -s --`.

It MUST NOT use `sudo` unless the user passes `--system`. It MUST print every action it takes. The script source is also published in the repository so it can be reviewed before running.

Fully non-interactive form, for agents and automation:

```sh
curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --answers ./cosimo-answers.json --yes --json
```

### 13.3 `cosimo init` Questions

Each question has an ID, a default, and conditions. The interactive prompt asks only what is relevant given earlier answers, and a user who presses Enter through every question gets a working local instance.

| ID | Question | Type | Default | Asked when |
|---|---|---|---|---|
| `target` | Where will this run? | choice: `local`, `docker` (any Linux server), `fly` | `local` | always |
| `domain` | Domain name for this instance (DNS must point to this server) | string | none | target is `docker` |
| `fly_app_name` | Fly.io app name | string | generated | target is `fly` |
| `database` | Database | choice: `sqlite`, `turso` | `sqlite` | always |
| `turso_org` | Turso organization slug | string | from `turso` CLI if logged in | database is `turso` |
| `turso_api_token` | Turso Platform API token (used to create one database per organization) | secret | from `turso` CLI if logged in | database is `turso` |
| `data_dir` | Data directory | path | `~/.cosimo` (local), `/data` (docker, fly) | database is `sqlite` |
| `admin_email` | Your email address | email | none, required | always |
| `admin_name` | Your name | string | none | always |
| `admin_auth` | How should you set your password? | choice: `claim_link`, `prompt` | `claim_link` when `--json`, otherwise `prompt` | always |
| `signup_mode` | Who can create accounts? | choice: `single_user`, `invite_only`, `open` | `single_user` (local), `invite_only` (server) | always |
| `org_name` | Name of your first business | string | none, required | always |
| `entity_type` | Business type | choice: `single_member_llc`, `sole_prop`, `multi_member_llc`, `s_corp`, `other` | `single_member_llc` | always |
| `coa_template` | Chart of accounts | choice: `schedule_c`, `form_1065`, `form_1120s`, `minimal` | derived from `entity_type` | always |
| `fiscal_year_start_month` | First month of fiscal year | 1 to 12 | 1 | always |
| `basis` | Default reporting basis | choice: `cash`, `accrual` | `cash` | always |
| `books_start_date` | First date for these books | date | first day of current year | always |
| `plaid_enabled` | Connect bank feeds with your own Plaid keys now? | boolean | false | always |
| `plaid_env` | Plaid environment | choice: `sandbox`, `production` | `sandbox` | plaid_enabled |
| `plaid_client_id` | Plaid client ID | string | none | plaid_enabled |
| `plaid_secret` | Plaid secret | secret | none | plaid_enabled |
| `smtp_enabled` | Configure email for invoices and password resets? | boolean | false | always |
| `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_from` | SMTP settings | mixed | none | smtp_enabled |
| `storage` | Where to store receipts and attachments | choice: `local`, `s3` | `local` | always |
| `s3_endpoint`, `s3_bucket`, `s3_region`, `s3_access_key`, `s3_secret_key` | S3-compatible storage settings (any provider: AWS, GCS, R2, B2, MinIO; see docs/object-storage.md) | mixed | none | storage is `s3` or backups is `s3` |
| `backups` | Automatic daily backups | choice: `local`, `s3`, `off` | `local` | always |
| `service` | Start automatically at login or boot? | boolean | true | target is `local` |
| `sample_data` | Load a demo organization with sample data? | boolean | false | always |

The demo org (named "Demo Studio (sample data)") is marked `is_sample` in the organizations table so it
sorts last in the org switcher and can be found without relying on its name. Any signed-in user can load
their own copy later from the `/orgs` page (`POST /sample-org`), and an owner can permanently delete it
from its Settings > Members > Danger zone (`DELETE /orgs/{orgId}?permanent=true`). Real organizations are
archive-only from the web UI; permanent deletion of real books stays CLI-only (`cosimo org delete`).

Secrets (`type: secret`) are never echoed, never written to logs, and never included in `--json` output.

### 13.4 Agent Contract

These commands and formats are a stable public interface. Changes require a major version bump.

**Discover questions**

```sh
cosimo init --questions --json
```

Returns a JSON document with a `schema_version` and an array of question objects: `id`, `prompt`, `help`, `type`, `choices`, `default`, `required`, `secret`, and `ask_when` (a simple condition expression over other answer IDs). An agent uses this to run the Q&A conversationally with its human.

**Apply answers**

```sh
cosimo init --answers answers.json --yes --json
```

- `--answers -` reads from stdin, so secrets need not touch disk.
- Any answer may also come from an environment variable named `COSIMO_INIT_<ID>` in upper case, which takes precedence over the file.
- Missing required answers fail with a JSON error listing the missing IDs. Nothing is changed when validation fails.

**Result**

On success, stdout contains exactly one JSON object:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "url": "https://books.example.com",
  "target": "docker",
  "database": "sqlite",
  "config_path": "/etc/cosimo/config.toml",
  "master_key_location": "/etc/cosimo/config.toml",
  "claim_link": "https://books.example.com/claim/abc123",
  "claim_link_expires_at": "2026-09-26T12:00:00Z",
  "org_id": "01J...",
  "next_steps": [
    "Open the claim link to set your password.",
    "Back up /etc/cosimo/config.toml somewhere safe. It contains your master key."
  ],
  "warnings": []
}
```

Human-readable progress goes to stderr so stdout stays parseable.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | Invalid or missing answers |
| 3 | Environment problem (port in use, missing Docker, DNS not pointing here) |
| 4 | External service error (Turso, Plaid, Fly, SMTP test failed) |
| 5 | Existing instance found and `--reconfigure` not given |
| 1 | Anything else |

**Claim links**

With `admin_auth: claim_link`, setup creates the admin user with no password and returns a single-use link valid for 24 hours. The human opens it and sets their password and optional 2FA. The agent never learns the password. `cosimo user claim-link <email>` issues a new link.

**Verification**

```sh
cosimo doctor --json
```

Checks: config readable, master key present, databases reachable, ledger and audit chains intact (recent links), migrations current, server responding, TLS valid (server targets), Plaid credentials valid (if set), SMTP reachable (if set), storage writable, backups recent, disk space. Returns a JSON list of checks with `status` of `pass`, `warn`, or `fail` and a remediation message for each non-pass.

**Idempotency**

Running `init` again on a machine with an existing instance exits with code 5 unless `--reconfigure` is given. Reconfiguration changes only the answers supplied and never deletes data.

### 13.5 `AGENTS.md`

The repository root and `https://raw.githubusercontent.com/steve-lomnes/cosimo/main/AGENTS.md` MUST publish an `AGENTS.md` that tells an AI agent, in plain terms:

1. The one command to install.
2. How to fetch the question schema and run a short Q&A with the human, asking only required questions plus those whose default doesn't fit.
3. To prefer `claim_link` so the agent never handles the human's password.
4. To pass secrets through stdin or environment variables, not files, when possible.
5. How to read the JSON result and what to tell the human afterward: the URL, the claim link, and the master key backup warning.
6. How to run `cosimo doctor --json` and act on failures.
7. How to connect to the MCP endpoint for ongoing work: through OAuth using only the server URL (preferred), or with an API token. How to install the bundled bookkeeping skill.
8. That the agent's bookkeeping writes go to the review queue, and it should tell the human when items are waiting.

Example agent flow the documentation MUST illustrate:

> Human: "Set me up with a bookkeeping system for my consulting LLC on my VPS."
> Agent: fetches questions, asks for the domain, email, business name, and whether to connect Plaid now. Uses defaults for everything else, runs the non-interactive install over SSH, runs doctor, and replies with the URL and claim link.

### 13.6 Deployment Targets (v1)

**Local**

- Runs the server on `http://localhost:8787` (configurable), opens the browser on first run.
- With `service: true`, installs a launchd agent (macOS), a systemd user unit (Linux), or a scheduled task (Windows).
- Plaid works through polling. Documentation explains that webhooks and some OAuth institutions need a public HTTPS URL.

**Docker on any Linux server**

- Requires Docker with the compose plugin. If missing, init prints the official install command and exits with code 3. It does not install Docker itself.
- Generates `docker-compose.yml` with the Cosimo container and Caddy for automatic HTTPS, plus a `Caddyfile` for the given domain.
- Verifies the domain resolves to the server's public IP before requesting certificates. Warns and continues if the check fails.
- Data in a named volume, config in a mounted directory.

**Fly.io**

- Requires `flyctl` installed and logged in. Generates `fly.toml`, creates the app and a volume, sets secrets with `fly secrets set`, and deploys.
- Works with SQLite on the Fly volume or with Turso.

Additional targets (Railway, Render, Coolify, bare systemd server) are documented recipes, not v1 init targets.

### 13.7 Configuration

- A single TOML config file created by init. Every key can be overridden by an environment variable `COSIMO_<SECTION>_<KEY>`.
- `cosimo config get|set|list` edits config safely. Secrets display as `********`.

### 13.8 CLI Summary

```
cosimo init               Set up a new instance (interactive or --answers)
cosimo serve              Run the server
cosimo doctor             Check health
cosimo upgrade            Download the latest release, back up, migrate, restart
cosimo backup             Create a backup now (or `backup list`, `backup download <name>`)
cosimo restore <file>     Restore from a backup
cosimo move-attachments   Copy local attachments into the configured S3 bucket
cosimo verify <org>       Verify the ledger and audit hash chains
cosimo export <org>       Export one org to the open format
cosimo import <file>      Import an org from the open format or a supported product export
cosimo user ...           create, list, disable, reset-password, claim-link, make-admin
cosimo org ...            create, list, archive
cosimo token ...          create, list, revoke API tokens (including propose_only)
cosimo oauth ...          list and revoke OAuth clients, toggle dynamic registration
cosimo config ...         get, set, list
cosimo version
```

Every command supports `--json`.

---

## 14. Operations

### 14.1 Backups

- Daily automatic backup (configurable time) of the system database, every org database, config (excluding secrets unless the user opts in to an encrypted backup), and attachments.
- SQLite backups use the online backup API or `VACUUM INTO`, never a raw file copy of a live database.
- Turso mode exports each database to a SQLite file for the backup.
- Retention: 14 daily, 8 weekly, 12 monthly by default. In bucket mode, a delete a provider refuses
  (for example under a retention lock) is a warning, not a failure; the backup still succeeds.
- Destinations: local directory or any S3-compatible bucket (`docs/object-storage.md` covers the
  providers). `cosimo backup list` and Admin → Backups work against either; `cosimo backup download`
  fetches a bucket backup locally.
- `cosimo restore` always restores from a local file; download a bucket backup first.
- `cosimo doctor` checks the bucket itself in bucket mode (write, list, delete), since retention
  depends on all three and providers differ most on list.
- `cosimo move-attachments` copies existing local attachments into a bucket before switching
  `storage.kind` to `s3`, without deleting the originals.

### 14.2 Export and Import

- **Open format**: a ZIP containing one JSON Lines file per table, attachments, and a `manifest.json` with schema version and checksums. Documented in `/docs/export-format.md`. Round-trip export then import MUST reproduce identical reports.
- **Importers from other products**: QuickBooks Online, Xero, and Wave exports of chart of accounts, contacts, and general ledger or journal detail. Imported history arrives as posted entries with `source_type: import`. Importers produce a dry-run report before committing.
- Plain CSV export of any report or list.

### 14.3 Migrations and Upgrades

- Drizzle migrations for system and org databases, versioned and forward-only.
- On startup, the server checks migration state. `cosimo upgrade` backs up, applies migrations to the system database and then each org database, and restarts. A failure on any org stops the upgrade and leaves a clear message; already-migrated databases remain valid because each migration is transactional.
- Releases follow semantic versioning. The agent contract (Section 13.4), API v1, and the export format are stable within a major version.
- The admin page checks GitHub Releases for a newer version, for instance admins only, cached in memory for a few hours. `updates.check` (or `COSIMO_UPDATES_CHECK=false`) turns it off; `updates.github_token` (or `COSIMO_UPDATES_GITHUB_TOKEN`) is an optional token for release lookups, for a private fork or to raise GitHub's unauthenticated rate limit.

### 14.4 Observability

- Structured JSON logs to stdout with levels.
- `/healthz` (liveness) and `/readyz` (databases reachable, migrations current).
- Admin page showing version, storage mode, org count, last backup, last Plaid sync per connection, and recent errors.

---

## 15. Testing and Acceptance

### 15.1 Required Automated Tests

- **Core unit tests** for every invariant in Section 6, including attempts to bypass them with direct SQL through the app's connection.
- **Property tests** generating random valid transactions and asserting reports always tie out.
- **Import tests**: the same CSV imported twice yields zero new rows; OFX and QFX samples parse correctly; transfers between two imported accounts pair into one entry.
- **Plaid tests** against Plaid Sandbox, gated behind an environment flag, plus mocked tests for added, modified, removed, and pending-to-posted transitions.
- **Storage mode tests**: the full integration suite runs against local SQLite and against a libSQL server (the `sqld` container or Turso dev) in CI.
- **Permission tests**: each role attempts every mutating endpoint and gets the expected result.
- **Setup tests**: `init --questions --json` output validates against its schema; `init --answers` succeeds in a clean container for `local` and `docker` targets; rerunning without `--reconfigure` exits 5; missing answers exit 2 with the missing IDs.
- **Chain tests**: altering any posted entry, line, or audit row through direct SQL is detected by `cosimo verify`, which names the first broken link; canonical hashing produces identical results on macOS, Linux, and Windows; concurrent posting never duplicates a sequence number.
- **Review queue tests**: MCP writes create pending items that don't affect reports; approval posts them; rejection never posts; an MCP client cannot approve; threshold policy catches large entries from every actor.
- **OAuth tests**: dynamic registration, PKCE authorization code flow, refresh rotation, revocation, role capping, org scoping, and rejection of mismatched redirect URIs.
- **End-to-end tests** (Playwright): claim link, create org, import CSV, categorize with a rule, reconcile, create and pay an invoice, run the year-end package.

### 15.2 Acceptance Criteria

1. On a clean Ubuntu 24.04 server with a DNS record pointing to it, the non-interactive one-liner produces a working HTTPS instance in under 5 minutes.
2. On a clean macOS machine, the interactive one-liner with all defaults produces a running local instance in under 2 minutes.
3. An AI agent following only `AGENTS.md` can complete setup for a human without asking for the human's password.
4. A user can import a year of bank CSVs for two accounts plus a credit card, categorize them with rules, reconcile each month, and produce a year-end package whose balance sheet ties to the bank statements.
5. Two users with separate orgs on one instance cannot see each other's data through the UI, the API, or MCP.
6. Export, delete, then import an org, and every report matches the original exactly.
7. With Plaid Sandbox keys, a user connects a test bank, receives transactions, and sees updates after a sync.
8. A user adds the instance to Claude as a connector using only its URL, Claude categorizes a month of transactions, the proposals appear in the review queue with rationales, and after approval the P&L reflects them.
9. Editing a posted amount directly in the database is flagged by `cosimo verify` and by the report footer hash no longer matching the last checkpoint.

---

## 16. Build Phases

Each phase ends with passing tests and a runnable app.

1. **Foundation**: repository layout, stack, system and org databases, connection factory for SQLite and Turso, migrations, auth, orgs and memberships, audit log, `cosimo serve`, and a basic `cosimo init` for the local target.
2. **Ledger**: chart of accounts templates, manual journal entries with all invariants, ledger and audit hash chains with `cosimo verify`, reversal flow, soft and hard lock dates, opening balances, trial balance, P&L, balance sheet, general ledger.
3. **Banking without Plaid**: bank accounts, CSV/OFX/QFX import, dedupe, the Categorize screen (categorize, split, transfer matching), rules, suggestions, reconciliation, review queue and review policies.
4. **Receivables and payables**: contacts, invoices with PDF and email, bills, payments and applications, aging reports, 1099 summary, cash-basis derivation.
5. **Plaid**: BYO keys, Link, sync, pending handling, webhooks, polling, reauth.
6. **Setup and deployment**: complete `init` question set, agent contract, claim links, `doctor`, docker and fly targets, `install.sh` and `install.ps1`, service installation, `AGENTS.md`.
7. **Operations**: backups and restore, open-format export and import, QBO/Xero/Wave importers, upgrade command, admin page.
8. **API polish and MCP**: OpenAPI completeness, business profile and notes, bundled skill, idempotency keys, MCP server wired to the review queue, OAuth 2.1 with dynamic client registration, API docs page, year-end package with chain head hash, dashboard.

---

## 17. Open Decisions

Resolve these before or at the start of the build session. Defaults apply if not resolved.

| Decision | Default |
|---|---|
| Domain for the `get.` install address, and GitHub organization | Resolved: `github.com/steve-lomnes/cosimo`, with the install scripts served as release assets rather than from a placeholder `get.cosimo.dev` domain. A short install domain (`curl -fsSL https://get.cosimo.dev \| sh`) is a future option, not required. The unscoped npm name `cosimo` was unpublished in January 2026; if it can't be claimed, publish as `@<org>/cosimo` with the binary still named `cosimo`. |
| License | MIT for maximum adoption. AGPL-3.0 is the alternative if you want hosted forks to share changes. |
| Multi-currency in v1 | Out |
| Recurring invoices in v1 | Included as a SHOULD |
| Online invoice payments (Stripe or similar) | Added after v1 (#55): the org's own Stripe account through Checkout, behind a provider interface, plus a pasted payment link mode. See §8.1. |
| Receipt OCR | Out of v1. Attachments only. |
| Windows as a server target | Local only in v1 |
