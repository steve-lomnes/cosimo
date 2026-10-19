# Decisions

Choices made during the build. SPEC.md is the source of truth for requirements; this file records how ambiguities were resolved.

## Resolved before the build

| Topic | Decision |
|---|---|
| Repo | `github.com/steve-lomnes/cosimo`, public (private during the build, made public in September 2026). Never commit secrets. |
| License | MIT, copyright 2026 Stephen Lomnes |
| Scope | All 8 phases of SPEC §16, in order. Commit and push after each phase. Anything left unfinished goes into an issue with a spec reference. |
| Domain / install URL | Install from GitHub Releases of `steve-lomnes/cosimo` (`install.sh`/`install.ps1` as release assets); a short `get.` domain is a future option, not required. Base URLs live in one constant file (`packages/shared/src/distribution.ts`, mirrored as variables at the top of the scripts). |
| npm | Don't publish. Package names are `@cosimo/*` in the workspace. Leave `bunx cosimo` documented but unreleased. |
| Turso | Test the libSQL server path against the locally installed `sqld` (0.24.x) and in CI via the `ghcr.io/tursodatabase/libsql-server` container. Turso Platform API provisioning is mocked, and live tests are gated behind `COSIMO_TEST_TURSO=1`. |
| Plaid | Sandbox keys come from the gitignored `.env.local` (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`). Sandbox tests are gated behind `COSIMO_TEST_PLAID=1` and run locally. CI runs only the mocked tests. |
| CI | GitHub Actions on every push: lint, typecheck, `bun test` (SQLite and sqld matrix), `bun audit`/`osv-scanner`, and web build. Playwright e2e runs on ubuntu only. Canonical-hash test runs on ubuntu, macos, and windows as a small separate job. The release workflow (cross-compiled binaries, checksums, GHCR image) is written but only triggered manually or by tag. |
| Multi-currency, Stripe, OCR, Windows server | Out (spec defaults) |
| Recurring invoices | Build it if Phase 4 has room, otherwise log it as an issue |

## Build-time decisions

### Phase 1: Foundation

- **Compiled binary and libsql native addon.** `@libsql/client` loads its native addon with a computed `require(\`@libsql/${target}\`)` that `bun build --compile` cannot follow. `apps/server/scripts/build-binary.ts` uses a Bun build plugin that rewrites that one line to a static `require("@libsql/<target-package>")`, which embeds the `.node` file in the executable. Verified: the binary opens `file:` databases after being moved. The fallback (shipping the `.node` next to the binary) was not needed. Cross-compiling needs the target's `@libsql/*` package installed; the release workflow and Dockerfile install all of them with `bun install --os=… --cpu='*'` and cross-compile every target from one Linux runner (updated in Phase 6).
- **Embedded web assets.** The build script generates `apps/server/src/web/assets.gen.ts` (one `import … with { type: "file" }` per file in `apps/web/dist`), compiles, and then restores the committed placeholder. In dev and tests, assets come from `apps/web/dist` on disk.
- **Migrations are embedded.** `packages/db/scripts/gen-migrations.ts` bundles the Drizzle SQL into `src/migrations.gen.ts` (committed). The migrator is our own: it splits on `--> statement-breakpoint` (trigger bodies contain semicolons), runs one write transaction per migration, and records applied migrations in `_cosimo_migrations`.
- **Write serialization.** Every write to one database goes through `DbHandle.write()`, which takes an in-process mutex keyed by the DB URL and then runs a libSQL `transaction("write")` (`BEGIN IMMEDIATE` locally, an interactive transaction over sqld/Turso). This is the per-org posting lock, and it also serializes audit chain extension. SQLITE_BUSY from other processes (for example the CLI while the server runs) is retried with backoff.
- **Chain enforcement split.** SQLite has no SHA-256, so hashes are computed in the app (`packages/core/src/chain.ts`). Triggers enforce `seq = max+1` and `prev_hash = current head` (genesis values live in immutable `schema_meta` rows), so nothing can be inserted into the middle of a chain.
- **Soft-lock actor.** The posting service writes a single `posting_context` row (actor, role, note) inside the posting transaction and deletes it before commit. The soft-lock trigger allows a post on or before the soft lock only when that row says `actor='user' AND role='owner'` with a non-empty note. Owner-role API tokens are treated as API tokens, so they are blocked by the soft lock.
- **libSQL server mode.** Besides `sqlite` and `turso`, `database.mode = "libsql"` targets a self-hosted `sqld --enable-namespaces`: each org is a namespace created through the admin API and reached at `http://<ns>.<host>:<port>`. This is how the test suite exercises the libSQL server path (locally with `sqld`, in CI with the `ghcr.io/tursodatabase/libsql-server` container).
- **Audit placement.** Org-related events (including membership and token changes) go to that org's chained `audit_log`. Instance-level events (user created, instance settings) go to the system DB's `instance_audit` table, which is not chained.
- **Runtime settings vs config file.** The TOML config holds bootstrap settings (server, database, master key, storage, backups). Settings editable from the UI (signup mode, dynamic client registration, SMTP, Plaid keys) live in `instance_settings` in the system DB, with secret fields encrypted by the master key. `COSIMO_SMTP_*` and `COSIMO_PLAID_*` environment variables override them.
- **Config location.** Local: `<data_dir>/config.toml` (default `~/.cosimo/config.toml`), with databases under `<data_dir>/data/`. Server targets: `/etc/cosimo/config.toml` in the container. Precedence is `--config`, then `COSIMO_CONFIG`, then `~/.cosimo/config.toml`, then `/etc/cosimo/config.toml`. Secrets stored in the config file (Turso and S3) are encrypted with the master key. The master key itself is plaintext in the 0600 file, or supplied through `COSIMO_MASTER_KEY`.
- **Sessions.** The cookie holds a random token; the DB stores its SHA-256 as `sessions.id`. CSRF uses a synchronizer token: `HMAC(master key, "csrf:" + session hash)`, returned by `GET /auth/session`, mirrored in a readable `cosimo_csrf` cookie, and required as `x-csrf-token` on cookie-authenticated unsafe methods. Bearer requests are exempt.
- **Passwords.** Minimum 10 characters. Login always runs an argon2id verification, against a dummy hash when the user doesn't exist, so response timing doesn't reveal whether an email is registered.
- **OAuth principals.** OAuth access tokens (used by AI clients) always act as `actor = mcp` with `proposeOnly = true`, including on REST routes, so an AI client can't bypass the review queue by calling REST.
- **Token role changes.** When a member's role is lowered, their API tokens for that org are capped to the new role. Removing a member revokes their tokens for that org.
- **Hidden init answers.** Beyond the published questions, `admin_password`, `host`, `port`, and `public_url` are accepted (file, stdin, or `COSIMO_INIT_*`) for automation and tests. `init --questions` does not list them.
- **TypeScript.** The root uses TypeScript 7 (`tsc`, native) for typechecking. `apps/web` pins TypeScript 5 only because `openapi-typescript` needs the TS 5 JS API.
- **Lint and format.** Biome, 2-space indent, width 110.

### Phase 2: Ledger

- **One posting pipeline.** Every entry (UI, API, rules, MCP, documents) goes through
  `submitEntryTx`: validate → `decide()` → post or hold. Document flows can pass `forcePost` once
  their own decision is made. Services throw `ApiError` directly (pragmatic; keeps HTTP mapping trivial).
- **Threshold applies to humans too** (SPEC §7.5 "any actor"). Policy amount = sum of debits.
  Threshold 0 disables it. Humans may approve their own held entries; MCP never can (Phase 3).
- **Poster vs creator.** `created_by_actor` is the proposer; `posted_by` and the lock check use whoever
  causes the post (the approver for reviewed items). An owner approving an MCP entry dated in a
  soft-locked period must give a note.
- **Owner API tokens may move lock dates**; MCP cannot. Hard lock must be ≤ soft lock.
- **Reversal date** defaults to the original entry's date; the caller may choose another. A reversal
  goes through the review policy like any entry. Only one live reversal per entry.
- **Document entries** (invoice, bill, payments) cannot be edited or reversed through the entry API.
- **Opening balances** accept balance sheet accounts only; the difference goes to Opening Balance
  Equity; `books_start_date` moves back to the opening date if earlier.
- **Accounts**: deactivation requires a zero balance; system accounts cannot be deactivated, retyped,
  or deleted; cycles rejected. Renaming and renumbering are always allowed (the ledger hash uses the
  account id). Deleting needs an account with no journal lines and no sub-accounts.
- **Sub-accounts** (#18): a sub-account always carries its parent's type, detail type (subtype), and
  tax line; the API rejects explicit values that differ. Changing a parent, or moving an account under
  a new one, cascades those three to the whole subtree with one `account.update` audit entry per
  account; a change that would retype any account in the subtree with posted lines is refused (409
  `account_in_use`, naming the account), while detail type and tax line changes restate past tax
  summaries. Moving back to top level keeps the current values. System accounts can be parents but
  never sub-accounts. Deactivating a parent deactivates its subtree (all must be zero); a child cannot
  be reactivated under an inactive parent. Posting to a parent is allowed: the P&L and Balance Sheet
  show a parent with shown sub-accounts as a header, its sub-accounts, "<name> (Other)" for its own
  postings when nonzero, and "Total <name>"; Trial Balance and General Ledger stay flat. Migration
  `0002_account_hierarchy` detached mismatched, dangling, and system sub-accounts and copied each
  top-level account's subtype and tax line down.
- **Reports** are pure builders in core fed by SQL sums. Negative zero is normalized. Monthly P&L is
  capped at 24 columns. CSV neutralizes formula-leading text (numbers untouched).
- **Verify** also flags chained entries no longer posted and posted entries outside the chain.
  `--tail N` checks the last N links from the stored prev_hash. `cosimo verify` exits 6 on failure.
- **Scheduler** is in-process, ticks each minute, records runs in `job_runs`; jobs are due based on
  their last successful run so restarts neither skip nor double-run.
- **DB errors**: drizzle wraps driver errors; `fromDbError` walks `cause` to map trigger messages.
- **Web** depends on `@cosimo/core/coa` for tax line labels (pure module, no node APIs).

### Phase 3: Banking

- **Parsers in core** (`packages/core/src/import/`), built by a subagent against a fixed interface.
  Dedupe hash = `sha256(JSON.stringify([bank_account_id, date, amount, normalized_description,
  occurrence]))`. OFX rows are also deduped by FITID. Batches are only recorded when something new was
  imported, so a repeated file leaves no trace but the (no-op) response.
- **Upload format**: JSON `{filename, content}` (text), 10 MB cap. Simpler for the API, MCP and the web
  (which reads the file with `File.text()`); multipart isn't needed for text statements.
- **Bank sign**: `bank_transactions.amount` positive = money into the account. Categorize splits are
  positive portions that must sum to |amount|.
- **Categorizations are entries** with `source_type = bank_transaction` (transfers: `transfer`),
  submitted through the same pipeline with `itemType = bank_categorization`. A held categorization
  leaves the bank txn `new` with `review_item_id` + `matched_entry_id` set; approval flips it to
  `categorized`, rejection clears both.
- **Transfers** pair with an unreviewed opposite-amount txn in the other account within ±5 days
  (closest date wins). When the other side arrives later, import auto-links it to the existing
  transfer entry (`pairImportedTransfersTx`).
- **Rules**: first match by priority. Auto-post rules post as actor `rule` (threshold and locks still
  apply; lock/validation problems are pre-checked so one bad row never aborts an import). Suggest
  rules create review-queue proposals, as SPEC §7.5 lists. With no rule, a history suggestion
  (last posted categorization of the same normalized payee) is stored for the review screen only.
  User regexes: ≤200 chars, nested quantifiers rejected.
- **AI assistants** may propose rules (inactive until approved) but cannot edit/delete rules, approve
  or reject anything, or undo categorizations (undo posts an unreviewed reversal).
- **Review item handlers** are registered per item type so later phases (invoice drafts, import
  batches) plug in. Expired items can be discarded (rejected), not approved.
- **Reconciliation** balances use the statement sign (card = amount owed). Beginning balance = last
  completed reconciliation's ending balance. Undo is owner-only and must go latest-first.
- **E2E**: Playwright spec files are `*.e2e.ts` so `bun test` doesn't pick them up; the e2e server is
  started through the real `cosimo init --answers` + `serve`.

### Phase 4: Receivables and payables

- **Documents post through the same pipeline** (`submitEntryTx`), so the review threshold, lock dates
  and hash chain apply to invoices, bills and payments exactly as to manual entries. A held invoice
  stays `draft` with a pending review item; approval flips it via `onEntryPosted` hooks keyed by
  `source_type`, rejection via `onEntryRejected`. Reversals keep the original source type and hooks
  skip them.
- **Voids by humans use `forcePost`** for the reversal (undoing is never held for review); AI
  assistants cannot void.
- **Document totals** are computed from lines: `qty` in thousandths × unit price, rounded half away
  from zero per line. Income/expense credits are grouped by account on the entry.
- **Paid amounts** come only from live applications (payment not voided, entry posted), recomputed
  on every change, so status (`sent`/`partial`/`paid`, bills `open`/`partial`/`paid`) never drifts.
  Unapplied payment amounts sit as customer credit / vendor prepayment and can be applied later.
- **Cash basis** (`services/cash-basis.ts`) is derived, not stored: remove invoice/bill entries in
  range, then recognize each live application on its applied date, allocated across the document's
  revenue/expense lines with exact BigInt proportional allocation (largest remainder). Every
  adjustment balances. The general ledger itself is always accrual. Reports default to the org's
  `default_basis`; aging, GL and 1099 ignore basis.
- **1099 summary** counts payments to 1099 vendors, excluding card payments (reported by the card
  processor on 1099-K); `REPORTABLE_1099 = $600`.
- **Attachments** are multipart (binary), 20 MB, content-sniffed; only raster images and PDFs are
  served inline, everything else as download, always with `nosniff` and a CSP sandbox. Storage is
  local (`data_dir/files`) or S3 via `Bun.S3Client`, content-addressed by SHA-256.
- **PDFs** are generated with pdf-lib (no headless browser), WinAnsi text only (unsupported
  characters are replaced).
- **Email**: nodemailer over the instance SMTP settings; nothing is sent unless SMTP is complete.
  Reminders go weekly for overdue invoices that were sent; recurring invoices are built (templates,
  schedule, auto-send optional). Weekly chain-verification failures email the org owners.
- **Bank review** can record a payment against open invoices/bills straight from a transaction
  (oldest first prefill) and attach a contact to a categorization.

### Phase 5: Plaid

- **In-house fetch client** (`services/plaid-client.ts`) instead of the `plaid` npm package: we use
  ten endpoints, it avoids pulling axios into the compiled binary, and the `PlaidApi` interface makes
  the mocked tests (`setPlaidFactory`) straightforward.
- **Keys**: org-level keys (owner, Settings → Bank feeds) override instance keys; env vars override
  stored instance keys. Secrets and access tokens are AES-256-GCM encrypted; disconnect wipes the
  access token. Only owners (not AI assistants) manage connections; writers can "Sync now".
- **Sign**: Plaid amounts are money-out positive; stored as `-round(amount × 100)`.
- **Dedupe**: `(bank_account_id, provider_transaction_id)` plus `dedupe_hash =
  sha256(["plaid", transaction_id])` (a namespace separate from statement hashes).
- **Overlap with statement imports**: linking a feed to a bank account that already has file imports
  skips feed rows dated on or before the latest file-imported row (computed per sync), instead of
  fuzzy matching.
- **Sync** fetches all pages first (restarting from the original cursor on
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, up to 3 times), then applies removed → added →
  modified plus the new cursor in one write. Concurrent syncs of a connection share one run. New
  posted rows go through transfer pairing and rules like imports; pending rows don't.
- **Pending**: stored with `is_pending`, not categorizable or excludable. The posted version arrives
  as `added` with `pending_transaction_id` and the pending row is deleted (it can never have an entry).
- **Provider changes to booked rows** (modified/removed after categorization) never touch the ledger:
  the row is kept and a `bank_txn.provider_modified` / `provider_removed` audit event is written.
- **Errors**: reauth-type codes (`ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`, …) → `needs_reauth`
  (polling skips it until the owner reconnects via Link update mode); others → `error` (retried).
- **Webhooks** go to `/api/v1/webhooks/plaid/{orgId}` (org in the path, since items live in per-org
  databases). Verification: ES256 JWT, key by `kid` from `/webhook_verification_key/get` (cached
  24 h), `iat` ≤ 5 minutes, constant-time compare of `request_body_sha256`. The handler answers
  immediately; syncs run in the background. Registered only when the public URL is HTTPS.
- **OAuth institutions**: optional `plaid.redirect_uri` setting; the web app keeps the link token in
  `sessionStorage` across the bank redirect and resumes Link at `/plaid/oauth`.
- **Polling**: `plaid.sync` job every 6 hours per org.

### Phase 6: Setup and deployment

- **Server targets bootstrap inside the container.** Init on the host writes the deployment files,
  then runs `cosimo init --in-container --answers -` in the container (`docker compose run` /
  `fly ssh console`) with the answers on stdin. The container creates the admin, the org and the
  settings in its own volume and prints the claim link JSON, which the host merges into its result.
  Turso/S3 credentials and other host-only answers never enter the container through answers.
- **Master key for server targets** lives in `cosimo/.env` (0600), which compose passes as
  environment and which `fly secrets import` reads through stdin. `config.toml` then holds no
  plaintext secrets (Turso/S3 values are encrypted with the master key). It is 0644 so the non-root
  container user (uid 10001) can read the read-only mount. Reconfigure reuses the key from `.env`.
- **Preflight before any write**: Docker/Compose or flyctl login checks exit 3 with the install or
  login command and leave nothing behind, so a retry isn't blocked by exit 5.
- **`--no-deploy`** writes the files and lists the commands instead of running them.
- **DNS check** compares the domain's addresses with this machine's interface addresses. There is no
  third-party "what is my IP" call. A mismatch only warns (NAT and load balancers are normal).
- **Fly**: configured through `[env]` in fly.toml plus secrets (no config file in the machine).
  `auto_stop_machines = "off"` and one machine, because the scheduler is in-process.
- **Local service**: launchd agent `dev.cosimo.server`, systemd user unit (with the
  `enable-linger` hint), or a Windows scheduled task at logon. If installation fails (for example
  no systemd in a container), init warns and still succeeds. Interactive local init opens the
  browser at the claim link.
- **Doctor** is read-only (never migrates). It verifies the last 200 chain links by default (`--full`
  for all). The server check probes the local port and the TLS check probes the public URL, so
  running it inside a container gives a useful answer. It exits 1 on any failure.
- **Image**: distroless `cc-debian12` runtime (glibc for the libsql addon, CA certs), non-root uid
  10001, `/data` volume. It is cross-compiled per arch on the build platform, so no QEMU is needed.
- **Release**: cross-compiles all five binaries on one runner, writes `checksums.txt` signed with
  cosign keyless as one Sigstore bundle (`checksums.txt.sigstore.json`, cosign v3) and adds
  provenance attestations, then pushes a multi-arch GHCR image signed by digest. Bun is pinned by
  `.bun-version`, which CI keeps equal to the Dockerfile's `oven/bun` tag.
- **Deploy** ships that signed image by digest, never a rebuild: it verifies the signature, copies
  the image to Fly's registry (GHCR is private), checks the digest is unchanged, and deploys it. The tag must equal `VERSION` in
  `packages/shared/src/distribution.ts`.
- **Installers** verify SHA-256 always and the cosign signature when `cosign` is installed.
  `install.sh` prefers the bundle and falls back to `.sig` + `.pem` for v0.1.0 and v0.1.1.
  `install.ps1` avoids `exit` under `irm | iex`, since it would close the user's shell.

### Phase 7: operations
- **Backups snapshot each database consistently.** Local files use `VACUUM INTO`. libsql (sqld or
  Turso) is copied table by table inside one read transaction, with foreign keys off. The ZIP is
  streamed with fflate and `manifest.json` goes last, with a SHA-256 per file.
- **Backups never contain plaintext secrets.** The config is written with secret values blanked.
  `secrets.enc` (scrypt and AES-256-GCM) is added only when `backups.include_secrets` is set and
  `COSIMO_BACKUP_PASSPHRASE` is provided. Otherwise the master key must be kept separately, and
  the CLI and UI say so.
- **Every backup is a chain anchor.** It records a checkpoint (reason `backup`, with `exported_to`)
  for each org, so the backup file independently records the chain heads.
- **Retention keeps** the newest N daily backups, the newest per ISO week for W weeks, and the
  newest per month for M months.
- **`serve` backs up before migrating**, and only when migrations are pending and backups are on.
  `serve` itself no longer migrates on context creation.
- **Restore is SQLite-only and moves data aside instead of overwriting it.** The current `data/`
  becomes `data.before-restore-<stamp>`, and restore refuses while the server responds on its
  port. libsql instances restore per org through `cosimo import`.
- **Export keeps the org ID.** The chains commit to it, so an imported org verifies byte for byte.
  Import refuses when that ID already exists (`org_exists`), drops triggers only for the bulk
  insert, recreates them, verifies both chains and the manifest heads, and drops the new database
  if anything fails.
- **Product imports (QBO, Xero, Wave) are reviewed as one batch** (SPEC §7.5). Commit creates
  accounts and contacts, then holds every entry as `pending_review` under a single `import_batch`
  review item. Approving it posts the entries in date order; rejecting it rejects them all.
  Starting an import is owner only; the batch can be decided like any other review item.
  `cosimo import --approve` approves it right away for operators. Entries carry `source_type: import`
  and a source ID (the product's transaction ID, or a content hash plus an occurrence number). Pending
  and posted entries count as already imported, and rejected ones don't, so a rejected batch can be
  imported again. Accounts match system accounts by subtype (A/R, A/P, opening balance, retained
  earnings, uncategorized), then by code with the same name, then by name. A new account without a
  free code gets the next code from x900 in its type's range. Any entry dated on or before a lock
  date blocks the whole commit.
- **The org import endpoint is `POST /api/v1/imports/org`**, not `/orgs/import`, because the
  `/orgs/:orgId/*` membership middleware would treat `import` as an org ID.
- **`cosimo upgrade`** verifies the checksum before touching anything, backs up, then probes the
  new binary (`version --json`) before swapping. The old binary is kept as `<path>.old`. Migrations
  run with the new binary. Docker and fly instances get pull or deploy instructions, and
  source checkouts are refused. `COSIMO_RELEASES_API` and `COSIMO_DOWNLOAD_BASE` override the
  release URLs for testing and mirrors.

### Phase 8: API and MCP
- **MCP is stateless streamable HTTP.** Each `POST /mcp` is one JSON-RPC message answered with
  `application/json`; `GET` and `DELETE` return 405 (no server-initiated stream, no sessions).
  Bearer only: cookies are ignored and a foreign `Origin` gets 403 (DNS rebinding).
- **OAuth 2.1 is built in, not a library.** Authorization code with PKCE (S256 only), public
  clients through dynamic registration (admin can turn it off and register confidential clients by
  hand). Codes last 10 minutes, access tokens 1 hour, refresh tokens 30 days. Codes, tokens and
  client secrets are stored as SHA-256 hashes. Redirect URIs match exactly, except that loopback
  redirects (`localhost`, `127.0.0.1`, `[::1]`) may use any port (RFC 8252); `http` is loopback only.
- **Refresh rotates in place.** The token row gets new hashes on every refresh, so the old refresh
  token stops working and a grant never piles up rows.
- **Replaying a code revokes what it produced.** The revocation commits first and the error is
  raised after the transaction, so it can't be rolled back with it.
- **A connection is one user × one client × a set of orgs, each with its own role** (#87), capped
  at the user's own role there. Claude won't take the same `/mcp` URL twice, so a second connector
  per org wasn't an option. The token pair stays one row; `oauth_token_orgs` holds each org's role
  and its own `revoked_at`, so one org can be dropped without disconnecting the rest. The stateless
  transport can't remember a current org, so every tool takes an optional `org_id` and falls back
  to a default the user picks on consent (never pre-selected) and can change only from Account. A
  removed default with several orgs left leaves no default rather than guessing one. Refresh drops
  orgs the user left. API tokens stay single-org. OAuth principals act as `mcp` and are always
  propose-only.
- **OAuth tokens are read-only on the REST API.** Anything but GET/HEAD/OPTIONS gets 403, so an
  assistant can't reach void, reverse, approve or lock endpoints outside the MCP tool set.
- **Idempotency keys** are stored per principal (user, API token or OAuth token) for 24 hours with
  a hash of method, path and body. A retry replays the stored response (`idempotent-replayed:
  true`); a different request with the same key gets 422, one still running gets 409. 5xx and
  non-JSON responses aren't stored, so they can be retried. A daily job prunes expired keys.
- **API docs use Scalar from the jsDelivr CDN**, pinned to a version with an SRI hash. The npm
  package pulled in about 250 dependencies, including a vulnerable AI SDK.
- **AI invoice drafts are held for review** (`invoice_draft`). Approving finalizes the invoice
  (numbering and posting); sending stays with a person. Rejecting deletes the draft.
- **Notes and the profile refuse likely secrets**: private keys, Plaid, Stripe, AWS and GitHub
  tokens, Cosimo tokens, long account-number-like digit runs, and Luhn-valid card numbers.
  Propose-only principals may append notes without review, because notes never touch the books;
  each note records its author.
- **The year-end package** covers the fiscal year ending in the requested year (fiscal year start
  from org settings), records a `year_end` checkpoint, and includes `chain.json` with the heads.
- **Dashboard figures** use the org's report basis (cash or accrual). Cash position is the bank
  accounts' ledger balances, with credit cards listed separately. Year-to-date starts at the fiscal
  year start. Work-waiting counts link to the review queue and bank review.

### End of build
- **Report footers show the recomputed ledger head**, not the stored one (acceptance #9). Every
  report replays the chain from genesis, so a row edited in the database changes the footer hash
  and it stops matching earlier reports and the last checkpoint. `meta.chain_intact` is false when
  any stored hash disagrees, and the web footer shows a warning. Replaying costs one pass over the
  posted lines, which reports already read.
- **`sample_data: true` adds a separate demo org**, "Demo Studio (sample data)", next to the
  real one. It holds three months of checking and card activity with auto-posting rules, an owner
  contribution, a customer invoice, and a few uncategorized transactions for bank review. It goes
  through the normal services, so it is chained and audited. The owner-entered contribution and
  invoice post directly instead of waiting behind the review threshold. Running init again does not add a second copy.

### After the build
- **"Bank review" is now "Categorize"** (Banking → Categorize, `/banking/categorize`; the old URL
  redirects). "Review" had two meanings, categorizing bank transactions and approving held entries
  in the review queue. "Review" now means only the approval queue, and "Reconcile" only matching the
  books to a statement. API paths and fields (`status: "new"`, `unreviewed`) are unchanged, because
  they are a stable interface.
- **Account and contact pickers are searchable comboboxes** (`SearchSelect`), not native selects.
  Every typed word must match the start of a word in the label, a keyword, or text inside the label.
  Keywords are the account type, subtype, description, and a short built-in synonym list keyed on
  common account names ("coffee" finds Meals, "adobe" finds Software). Code searches keep chart
  order; word searches rank closer names first. Enter or Tab picks, and Enter on a closed list still
  submits the form, so Categorize stays keyboard-only. The list is `position: fixed` so tables,
  rows and dialogs don't clip it; it isn't portaled, because modals are native `<dialog>`s in the
  top layer.
- **Formation costs get their own account**: 6340 Organization and Startup Costs in the Schedule C,
  1065 and 1120-S templates, mapped to the other-expenses line. Startup and organizational costs
  have their own rule (up to $5,000 deductible in the first year, the rest amortized over 180
  months), so they stay apart from legal fees and licenses for the preparer. Books expense them as
  incurred, as GAAP does; amortization is left to the return. Existing orgs don't get the account
  automatically.
- **Owner reimbursements are a liability**: 2400 Due to Owner / Due to Partners / Due to
  Shareholders (current liability) in the three tax templates. Out-of-pocket spending the business
  pays back isn't a contribution: in a partnership a contribution shifts capital accounts, and an S
  corp shareholder-employee can deduct such expenses only through an accountable-plan
  reimbursement. Long-term owner loans are left to a separate account the org adds itself.
- **Customers and vendors are created from the picker**: typing a name that isn't there offers
  "+ New customer "…"" as the last row, which creates the contact with just that name and selects
  it. Details are filled in later on the Customers and Vendors pages, so the separate New button and
  form are gone from the picker. Enter creates only when that row is highlighted, which happens by
  default only when nothing else matches; Tab never creates.
- **Plaid keys are checked when saved**: both the org and instance forms make one authenticated
  call to Plaid before storing keys, and a rejection says which environment it was checked against,
  since a secret from the other environment is the usual mistake. Nothing is saved when the check
  fails. The instance form re-sends every field on each save, so the check runs only when the keys,
  environment, or switch change, and pasted instance keys are trimmed like the org ones.
- **Every green push to `main` cuts a release** (#12): a GitHub Release, signed binaries and a GHCR
  image, tagged with a patch bump by default. A PR label `release:minor` or `release:major` bumps
  higher; `release:skip`, or a change touching only docs/config files, skips the release entirely.
  The Fly deploy runs after the Release workflow succeeds, not after CI directly, so a red release
  blocks the deploy. **The running version comes from the build, not the source**: `VERSION` is a
  build-time global (`__COSIMO_VERSION__`/`__COSIMO_COMMIT__`, injected via `--version`/`--commit`
  on `build-binary.ts` and `COSIMO_VERSION`/`COSIMO_COMMIT` Docker build args), so a source run
  always reports `0.0.0-dev` and never calls out for updates. The admin-only update check
  (`updates.check`, `updates.github_token`) asks GitHub Releases directly, cached in memory per
  request context rather than through the scheduler, since it only needs to run when an admin is
  looking and doesn't need to survive a restart.
- **Demo org deletion is permanent; real orgs are archive-only in the web UI** (#40): the demo org
  ("Demo Studio (sample data)") is marked `is_sample` in the system DB, so it can be found and
  ordered without relying on its name. An owner gets a permanent Delete button for it in Settings'
  Danger zone, since there's nothing worth keeping. A real org only gets Archive there (data kept,
  restorable only via the CLI); permanent deletion of real books stays a CLI-only operation
  (`cosimo org delete`). Any signed-in user can load their own copy of the demo from `/orgs`
  (`POST /sample-org`), which is why `loadSampleData` is idempotent per user rather than a
  once-per-instance seed.
- **2026-09-28**: GitHub account renamed to steve-lomnes; repo, image and signing identity moved;
  installers accept both identities for older releases.
- **Online invoice payments go through a provider interface, Stripe first** (#55, changes SPEC §17):
  `services/payment-providers/` defines a small `PaymentProvider` (test connection, customer,
  Checkout session, session state, webhook verification, webhook registration) with normalized
  results, and `stripe.ts` implements it over plain `fetch` (no SDK, no Stripe.js; the pay link
  redirects to hosted Checkout, so the CSP is unchanged). Settings are stored provider-agnostically:
  a mode (`off`, `manual_link`, `stripe`), an encrypted credentials blob, and options. **The pay
  token is derived, not stored**: `hmac(master key, "pay:org:invoice:version")`, with only its
  SHA-256 kept for lookup, so a database copy alone yields no working links (like Plaid tokens, links
  depend on the master key). Finalizing runs without the app context, so it only bumps the link
  version; the hash is filled in by code holding the key, and a lookup miss fills any missing hashes
  before giving up. **Idempotency uses a new `provider_payments` table** with a unique (provider,
  payment ID) key, written in the same transaction as the payment, rather than a unique index on
  `payments(method, reference)`: hand-entered payments may already repeat `method = "stripe"`
  references, and the table also links each payment to its fee entry. The webhook, polling, and
  the customer's return all call one `reconcileSession`, which re-reads the session from Stripe.
  **A new `integration` actor** records these payments: it auto-approves by default, still subject
  to the review threshold and owner policies, and `SubmitOptions.requireReview` forces anything that
  doesn't match an open invoice into review. Fees use a new `payment_fee` source type linked to the
  payment, not `invoice_payment`, so rejecting a fee doesn't void the payment.
- **Stripe refunds and disputes are review-only journal entries, not negative payments** (#55):
  payments and applications can't be negative, and a "sent" payment would go through accounts
  payable, so a refund is Dr Refunds and Allowances (4050, income: contra-revenue) / Cr Stripe
  Clearing, and the invoice stays paid. A dispute is Dr a Chargebacks expense and Dr the fee account
  for Stripe's dispute fee / Cr Stripe Clearing, using each dispute balance transaction's own amount
  and fee, so funds reinstated reverse it exactly. Every one requires review whatever the policy says:
  the money has already moved in Stripe, and the owner decides how it's booked. A new
  `provider_adjustments` table keyed on the refund or balance transaction ID makes the webhook,
  polling, and the backfill of older events propose each once; a rejected entry keeps its row, so it
  isn't proposed again. Payouts are suggest-only on Categorize (a transfer from Stripe Clearing),
  because the owner already books payouts that way and a wrong automatic match would be worse than
  one click.
- **Invoice terms describe the due date; conflicts are rejected** (#66): the due date is
  authoritative (it drives aging, overdue status, and reminders) and the terms only describe it, as in
  QuickBooks, Xero, and Zoho. A preset ("Net 30", "Due end of month") is a rule that computes the due
  date; a due date given without terms derives the terms (the matching preset, else "On due date");
  "On due date" needs a due date; a due date can't precede the issue date. Terms and a due date that
  disagree are **rejected (422 `terms_conflict`), not warned about**, because an MCP agent can't
  delete drafts or reject proposals, so a bad invoice would sit in the queue for a person to clean
  up. Discount terms such as "2/10 Net 30" follow their net days. Other custom text ("Pay when paid")
  is kept and never conflict-checked; without a due date it falls back to 30 days, as before. A
  customer's `default_terms` come before the org default, which applies only when neither terms nor
  a due date is given. Recurring templates get the same check on terms and `due_days` when saved; a
  run doesn't re-check, so a template saved before this still runs, and its due days win over
  disagreeing terms. The web form likewise re-derives the terms of an older draft that disagrees with
  its due date, so saving it isn't blocked. Discount accounting is out of scope.
  The shared rules live in `packages/shared/src/terms.ts`.
- **Every MCP amount is labeled integer cents** (#67): zod's `.describe()` replaces a schema's
  description, so `cents(extra)` builds the label into each amount field. Each tool declares
  `money: boolean` (required, so a new tool can't skip it) and `tool()` appends one standard sentence
  to the description when it's true; the server instructions say it too, and a `tools/list` test
  checks both.
- **Public timestamps instead of emailed checkpoints** (#11): a checkpoint in the same database can be
  rewritten along with the chains, and an emailed one only helps if SMTP is set up, someone keeps the
  mail, and a third party believes an inbox the owner controls. The goal is books a third party can
  check without trusting the owner, so the digest of both chain heads is timestamped by services
  outside the owner's control. **OpenTimestamps and RFC 3161 together**: OpenTimestamps anchors in
  Bitcoin with no trusted party and no account, but takes hours to confirm and is unfamiliar to
  auditors; an RFC 3161 token (FreeTSA by default) is immediate, recognized, and checkable with
  openssl, but rests on trusting the authority. Each covers the other's gap. **On by default**,
  because a timeline only proves something if it starts early: books first timestamped the day
  someone asks are only evidence from that day. Only a digest leaves the server (OpenTimestamps adds
  a nonce), nothing needs a key, and `anchoring.enabled = false` turns it off. **No new
  dependencies**: the server ships as one compiled binary and keeps its dependencies few, so the
  `.ots` format and a minimal DER reader and writer are written in `@cosimo/core`, and signatures and
  certificates use `node:crypto`. Tokens must chain to a trusted root (FreeTSA's is built in, others
  via `anchoring.tsa_ca_file`): a token signed by any key its own embedded certificate names would
  let whoever rewrote the books sign an earlier date. Anchoring never blocks posting, checkpoints,
  backups, or the year-end package; a chain whose recent links don't verify is never timestamped; an
  anchor that no longer matches fails verification, while coverage gaps (deleted anchors, late
  timestamps) are reported but don't, since deleting proofs is exactly what a rewrite can do and the
  earliest-timestamp date is what a verifier should weigh. A failed service is retried after a
  3-hour back-off, on the next daily run in practice, rather than every scheduler tick, because
  failed attempts are append-only rows.
