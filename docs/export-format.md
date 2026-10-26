# Open export format

Cosimo can export one organization's books to a single ZIP file in an open format. The format is
documented so that the data can be read without Cosimo, by a spreadsheet, a script, or another
bookkeeping product. The same file can be imported into any Cosimo instance, where it keeps the
organization's ID and its hash chains verify exactly as they did before export.

- Web: Settings → Import & export → **Download export** (owners only).
- CLI: `cosimo export <org_id> [--out books.zip]`.
- API: `GET /api/v1/orgs/{orgId}/export` (owner).

Importing:

- Web: the Organizations page → **Import an organization**.
- CLI: `cosimo import books.zip [--user <email>] [--name "New name"]`.
- API: `POST /api/v1/imports/org` (multipart, field `file`).

An import is refused with `org_exists` (CLI exit 5, HTTP 409) when an organization with the same ID
is already on the instance. Delete that organization first to replace it.

## Layout

```
manifest.json          format, versions, chain heads, per-file SHA-256
org.json               { id, name, created_at }
members.json           [{ email, name, role }]
tables/<table>.jsonl   one file per table in the organization database
attachments/<key>      the stored bytes of each attachment (receipts, bills, logos)
```

`manifest.json` is written last and lists every other file with its SHA-256 and size.

```json
{
  "format": "cosimo-export",
  "format_version": 1,
  "exported_at": "2026-09-25T12:00:00.000Z",
  "cosimo_version": "0.1.0",
  "schema": ["0000_init", "…"],
  "org": { "id": "01J…", "name": "Northwind Studio LLC" },
  "secrets_omitted": true,
  "chain_heads": {
    "ledger": { "seq": 412, "hash": "4fd7…" },
    "audit": { "seq": 1033, "hash": "69a9…" }
  },
  "tables": { "journal_entries": { "rows": 412 }, "…": {} },
  "files": { "tables/accounts.jsonl": { "sha256": "…", "bytes": 5120 }, "…": {} }
}
```

- `format_version` changes only when the layout changes in a way that older readers can't handle.
  Cosimo refuses to import an export with a newer `format_version` than it supports.
- `schema` lists the database migrations applied when the export was made. An import into a newer
  Cosimo migrates the data forward. An import into an older Cosimo is refused (`export_too_new`).
- `chain_heads` are the last ledger and audit links at export time. After import, Cosimo verifies
  both chains from genesis and checks that they end at these heads (`chain_broken` otherwise). See
  [chain-format.md](chain-format.md).

## Tables

Each line of `tables/<table>.jsonl` is one row as a JSON object, with keys equal to the database
column names (snake_case). Rows are in insertion order. Conventions:

| Kind | Encoding |
|---|---|
| Money | Signed integer **cents**. On `journal_lines.amount`, debits are positive and credits negative. Every posted entry's lines sum to zero. |
| Dates | `YYYY-MM-DD` strings (entry, invoice, bill, transaction dates) |
| Timestamps | ISO 8601 UTC strings |
| Booleans | `0` or `1` |
| IDs | ULID strings |
| JSON columns | Strings containing JSON (columns ending `_json`) |
| Binary | `{ "$base64": "…" }` |
| Missing value | `null` |

The tables most readers want:

| Table | Contents |
|---|---|
| `org_settings` | One row: entity type, fiscal year start, base currency, basis, lock dates, invoice settings |
| `accounts` | Chart of accounts: `code`, `name`, `type` (asset, liability, equity, income, expense), `subtype`, `parent_id`, `tax_line` |
| `journal_entries` | Entries: `date`, `memo`, `status` (only `posted` affects balances), `source_type`, `chain_seq`, `entry_hash`, `prev_hash` |
| `journal_lines` | Lines: `entry_id`, `account_id`, `amount`, `description`, `contact_id` |
| `contacts` | Customers and vendors |
| `invoices`, `invoice_lines` | Receivables; `entry_id` links the posted entry |
| `bills`, `bill_lines` | Payables |
| `payments`, `payment_applications` | Payments received and made, and which documents they settle |
| `provider_payments`, `provider_events`, `provider_customers` | Online payments: each Stripe payment recorded (with its fee entry), webhook events received, and each contact's Stripe customer (with the cash balance Stripe last reported for it) |
| `provider_adjustments`, `provider_payouts` | Stripe refunds and dispute movements against recorded payments (with the entry proposed for each), and Stripe payouts (with the bank transaction and transfer entry they were matched to) |
| `bank_accounts`, `bank_transactions` | Bank and card accounts and their imported or synced transactions |
| `receipts` | The receipt inbox: each receipt's fields (`paid_with_note` says how it was paid when not from a bank account), `status` (inbox, matched, booked, dismissed), the bank transaction it is matched to (`matched_bank_txn_id`) or suggested for, and the bill or entry it was booked to. Its files are the `attachment_links` rows with `target_type = "receipt"`. Exports from before schema `0011_owner_paid_receipts` carry one file in `receipts.attachment_id`; importing them moves it into the links |
| `reconciliations`, `reconciliation_items` | Completed and in-progress reconciliations |
| `rules`, `review_items`, `review_policy` | Categorization rules and the review queue |
| `attachments`, `attachment_links` | Attachment metadata; the bytes are in `attachments/<storage_key>` |
| `audit_log`, `chain_checkpoints` | The audit chain and recorded chain heads |
| `chain_anchors` | Public timestamps of the chain heads: OpenTimestamps proofs and RFC 3161 tokens, base64 in `proof` ([chain-format.md](chain-format.md#anchors-public-timestamps)) |

Other tables (`posting_context`, `recurring_templates`, `recurring_runs`, `import_batches`,
`csv_profiles`, `bank_connections`, `comments`, `org_notes`, `schema_meta`) are exported too, so an
import is complete.

A trial balance, for example, is the sum of `journal_lines.amount` per `account_id`, over lines
whose entry has `status = "posted"`.

## What is left out

- **Secrets.** `bank_connections.access_token_enc` is exported as an empty string, and
  `org_settings.plaid_secret_enc` and `org_settings.payment_credentials_enc` (the Stripe key and
  webhook secret) as `null`; the manifest says `"secrets_omitted": true`. After an import, reconnect
  each bank feed (Settings → Bank feeds) and re-enter any per-organization Plaid keys and the Stripe
  key (Settings → Online payments). Invoice pay links are derived from the master key, so on another
  instance they change; only their hashes (`invoices.pay_token_hash`) are exported.
- **Users.** `members.json` lists members by email and role only. On import, members whose email
  already has an account on the new instance are added with their role; the others are listed as
  skipped. The importing user becomes an owner.
- **Instance data.** Sessions, API tokens, OAuth clients, and instance settings aren't part of an
  organization export. Use `cosimo backup` for the whole instance.

## Integrity

- Every file's SHA-256 is in the manifest. Import rejects a damaged archive (`checksum_mismatch`).
- The ledger and audit chains commit to the organization ID and to every posted entry and audit
  event. Changing a row in `tables/` makes the chains fail to verify, so the import is refused
  (`chain_broken`) and nothing is created. Editing the manifest's checksums to match doesn't help,
  because the chains are checked independently.
- This makes changes **detectable, not impossible**: someone with full access could rebuild every
  hash. Keep an independent copy of the chain heads, such as the year-end package or a checkpoint
  sent elsewhere, to prove the books haven't been rewritten since.
