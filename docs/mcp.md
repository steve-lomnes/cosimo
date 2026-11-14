# AI assistants: MCP and OAuth

Cosimo serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`<your instance>/mcp`. An assistant such as Claude can read your books through it and propose
changes. It can't change the books on its own: everything it writes to them waits in the review
queue until a person approves it. Only notes and contacts, which don't touch the books, apply
directly.

## Connecting

**With OAuth (recommended).** In your AI client, add a connector (custom MCP server) with the URL
`https://books.example.com/mcp`. The client finds the sign-in page by itself. You sign in to
Cosimo, check each organization the assistant may use, choose its access level in each, pick which
of them is the default, and approve. An access level can't be higher than your own role in that
organization, and it starts at Bookkeeper. Custom connectors in claude.ai need only
the URL. If dynamic client registration is turned off, an admin registers a client with the
redirect URI `https://claude.ai/api/mcp/auth_callback`, and you enter its client ID and secret in
the connector's advanced settings.

**With an API token.** For scripts and clients without OAuth, create a token under Account →
Personal API tokens, or with `cosimo token create`. Send it as `Authorization: Bearer <token>`.

One connection can work with several organizations, with its own access level in each. Every tool
except `list_orgs` takes an optional `org_id`; a call without one works in the connection's
default organization, and a call naming an organization the connection doesn't cover is refused
with a list of the ones it does. The assistant can't add organizations or change the default.

See your apps under Account → Connected AI apps: disconnect one, remove a single organization from
it (the others keep working), or change its default organization. Owners see every app connected
to their organization under Settings → AI connections, and disconnecting one there removes only
that organization. If you leave an organization, connections drop it and keep the rest. An API
token still works with exactly one organization.

## What an assistant can do

Read:

| Tool | What it returns |
|---|---|
| `list_orgs` | The organizations the connection covers: each one's ID, name, currency, the connection's role there, and which is the default (`is_default`) |
| `get_org_profile`, `get_org_notes` | The business profile and the bookkeeping notes, as markdown (the same as the resources below) |
| `get_account_balances` | Chart of accounts with balances as of a date |
| `run_report` | Any report (P&L, balance sheet, trial balance, cash flow, tax lines, general ledger, AR/AP aging, 1099) |
| `get_cash_snapshot` | Cash and card balances, month/YTD P&L, review and categorize counts, overdue invoices, bills due soon, and each bank feed's sync status |
| `list_uncategorized_transactions`, `search_transactions` | Bank and card transactions; `list_uncategorized_transactions` also lists the bank accounts with their feed's sync status |
| `get_entry`, `list_entries` | Journal entries, with account and contact names filled in and whether each has an attachment |
| `list_contacts` | Customers and vendors; pass `include_archived` to see archived ones too |
| `list_invoices`, `list_bills`, `list_bill_payments`, `list_invoice_payments` | Invoices to customers (with the online pay link and whether a bank payment is processing), bills from vendors, payments sent to vendors, and payments received from customers (including any waiting in review and unapplied customer credit) |
| `list_pending_reviews`, `get_review_item` | The review queue |
| `list_recurring_templates` | Recurring invoices, bills, and journal entries: schedule, next and upcoming dates, run mode, total, last error, and any change waiting for review |
| `list_receipts`, `get_receipt` | The receipt inbox (by default receipts with no bank transaction matched yet; `no_bank_account` lists those paid personally or in cash). `get_receipt` adds the bank transactions that could be the receipt, `attach_url` (the receipt's page in Cosimo), and the receipt's files after the JSON, up to four: images as JPEGs of at most 1568 px on the long edge, PDFs as embedded resources |
| `get_reserves` | Each reserve the person set up (money set aside as a rate of net income per tax year, such as tax) and where it stands: per part, target, paid, remaining, the projected annual amount, and the next due date and amount; in book mode also booked, held, and the true-up due. Cosimo doesn't compute tax, and no tool creates a reserve or changes its rates or due dates |
| `get_cash_forecast`, `list_forecast_scenarios`, `list_planned_items` | The cash forecast from today: opening cash, buckets of expected inflows and outflows (reserve installments included), the low point, and `draw_capacity` (how much can be drawn now: the low point less the cash buffer and what reserves owe that the window doesn't pay), with the `binding` outflows that set it, the largest `drivers` (each with how firm it is), and `attention` items to correct. Invoices are expected `collection_lag_days` after their due date and bills `bill_lag_days` after theirs (both default 0); their flows carry `due_date`. Pass `scenario_id` for a what-if; `window` is `w13` (default), `m12`, or a saved window's ID, or give `bucket` and `periods`. `list_planned_items` lists one scenario's own items |
| `list_attachments` | The files linked to a journal entry, bill, invoice, receipt, or bank transaction, with their attachment IDs |

`list_uncategorized_transactions` leaves out transactions still pending at the bank: they aren't
categorizable yet and don't count toward a closed month.

Every bank account (and bank connection in `get_cash_snapshot`) carries its feed's sync status, so
an assistant can tell "no new transactions" from "the feed isn't working":
`last_synced_at` (the last sync that finished, whether it worked or not), `last_successful_sync_at`,
`last_sync_status` (`never`, `in_progress`, `success`, or `error`), `last_sync_error`, the last
successful sync's `last_sync_added` / `_modified` / `_removed` counts, `connection_status`
(`healthy`, `needs_reauth`, `error`, or `disconnected`), and `new_accounts_available`. Accounts
without a bank feed have `null` in every one of these.

Resources: `org://profile` (the business profile) and `org://notes` (bookkeeping notes), for the
default organization, and the templates `org://{org_id}/profile` and `org://{org_id}/notes` for any
organization the connection covers. Edit both under Settings → Business profile.

Propose (each takes a `rationale`, which you see in Review):

| Tool | Effect when approved |
|---|---|
| `categorize_transaction` | Posts the categorization entry |
| `create_rule` | Activates the rule |
| `propose_owner_draw` | Posts a draw: debit Owner Draw, credit the bank account. The server attaches the cash forecast it computed (capacity, low point, drivers) to the review item. A draw over `draw_capacity` is proposed, not refused, and the result says `exceeds_capacity`. While pending, it counts as an outflow in the forecast. `include_true_ups` also proposes the reserve true-ups that are due. `pay_reserves` (`[{ part_id, tax_year, amount }]`) pays part of the draw out toward reserve parts, each its own reserve payment entry from the bank account; `reimburse_owner` (`{ account_id, amount }`) pays the owner back for expenses recorded against a liability such as Due to Owner, at most its balance, in the draw's own entry. Only the remainder debits Owner Draw, and together they can't exceed the amount. The result has `draw` (null when nothing is left for it), `reserve_payments`, and `true_ups` |
| `propose_reserve_true_up` | Posts a book-mode reserve's true-up: debit the charge account (Owner Draw unless set), credit each part's liability account for target − booked. Refused while one is already pending |
| `record_reserve_payment` | With `from_bank_account_id`: posts the payment's entry (debit the part's liability account in book mode, or the charge account in track mode; credit the bank). The payment record itself applies at once, and rejecting the entry removes it. Without a bank account (paid personally, out of a draw already taken): in track mode only the record, at once and audited; in book mode it also proposes debit the liability, credit the charge account (Owner Draw unless set), so the liability clears and the draw isn't counted twice |
| `create_manual_entry` | Posts the entry. With `receipt_id` (an inbox receipt), the receipt's files are linked to the entry and the receipt is marked booked |
| `create_invoice_draft` | Finalizes the invoice (you still decide when to send it). Takes optional `terms` and `due_date`: leave both out for the customer's, then the org's, default terms; a due date alone derives the terms; terms that disagree with the due date are rejected |
| `create_bill_draft` | Posts the bill to Accounts Payable. Takes `receipt_id` like `create_manual_entry` |
| `book_receipt` | Books an inbox receipt that will never meet a bank transaction (paid personally or in cash). `as: "entry"` debits the receipt's account and credits `credit_account`, by default the org's "Due to …" liability (what the business owes the owner); `as: "bill"` drafts a bill from the vendor. Every file on the receipt is linked to the entry or bill |
| `propose_reversal` | Posts a reversal of a posted entry |
| `propose_replacement` | Reverses a posted entry and posts the corrected one, together (one review item). The original's files are linked to the replacement unless `keep_attachments` is false, and a receipt booked to the original points at the replacement. Lines carry `contact_id` |
| `propose_recurring_template` | Creates, changes, pauses, or resumes a recurring invoice, bill, or journal entry. A template that emails invoices to the customer always waits for a person, whatever the review policies say |
| `record_invoice_payment` | Records a payment received from a customer against one or more of their open invoices, in full or in part; an amount beyond what is applied stays as customer credit. Pass `transaction_id` to record it from a bank deposit so the cash isn't counted twice. Refuses amounts beyond what is open (payments waiting in review count) |
| `record_bill_payment` | Records a payment made to a vendor against one or more of their open bills, in full or in part. Takes the date, amount, and the account the money moved through: a bank, other current asset, credit card, other current liability, or owner's equity account. Refuses amounts beyond what is open (payments waiting in review count) |
| `propose_payment_date_change` | Moves a payment to a new date: its entry is reversed on the old date and posted again on the new one; the documents it pays stay paid and a matched bank transaction stays matched (one review item) |

Entries created by invoices, bills, and payments can't be reversed or replaced over MCP; void or
edit the document instead. A payment's date is the one exception.

**Withdraw.** `withdraw_proposal` lets an assistant take back its own pending proposal (with a reason) so it can propose a corrected one. The item ends as rejected, with the note "Withdrawn by the assistant", and everything it did unwinds as on rejection. It refuses items already decided and items proposed by a person, a rule, an integration, or another person's assistant. Assistants still can't approve or reject.

Apply directly, without review, and recorded in the audit log:

| Tool | Effect |
|---|---|
| `create_contact`, `update_contact` | Adds, edits, archives, or unarchives a customer or vendor (contacts don't touch the books) |
| `append_note` | Adds a dated note attributed to the assistant (notes don't touch the books) |
| `create_receipt`, `update_receipt` | Captures a receipt from its fields (and optionally a file as base64, up to 10 MB), or fills in or corrects one. `amount` is what the card is charged, tip included; `paid_with_note` says how it was paid when not from a bank account. The result includes `attach_url`, where the person adds the photo and any other files. Receipts don't touch the books; categorizing the matched transaction still goes through review |
| `match_receipt`, `unmatch_receipt`, `dismiss_receipt` | Matches a receipt to its bank transaction, undoes a match or turns down a suggestion ("not this receipt", remembered), or takes a receipt out of the inbox |
| `create_forecast_scenario`, `save_planned_item`, `archive_planned_item`, `set_forecast_override` | Builds a what-if in the cash forecast: a scenario, planned items (a one-off or a repeating schedule; `kind: "draw"` for a planned owner draw), and exclusions or shifts of an open invoice, bill, recurring template, planned item, or reserve installment (`reserve_part` with `target_date`). These aren't ledger records, so they apply at once and are audited. **An assistant writes only to scenarios its own connection created**: the baseline and another connection's scenario are refused, and only a person promotes a scenario into the baseline |
| `link_attachment` | Links a file already in Cosimo to a journal entry, bill, invoice, receipt, or bank transaction (the target must exist). Linking to a receipt adds it to the receipt's files. Uploading new files over MCP isn't possible; the person adds them at a receipt's `attach_url` |
| `sync_bank_feed` | Fetches new transactions from Plaid now, for one bank account, one connection, or all of them. Rules run as in a scheduled sync, under the same review policies. It returns the new rows, with any rule suggestion. A connection synced within the last minute answers `cooldown` without calling Plaid (Admin → Settings → Plaid sets the interval). `force_refresh` also calls Plaid's `/transactions/refresh`, which Plaid bills separately, only when an instance admin allows it. A connection that needs reconnecting is reported as `needs_reauth`: only a person can fix that. Needs Owner or Bookkeeper |

There are no tools to approve, reject, void, delete, or change lock dates. OAuth access
tokens can only read through the REST API, so an assistant can't reach those actions there either. Owners can auto-approve some
proposals with a review policy, such as "AI categorizations under $100 to an account already used
for that payee" (Settings → Review policies). Anything over the amount threshold is always
reviewed.

## The bundled skill

`skills/cosimo-bookkeeping/SKILL.md` teaches an assistant the standard workflows: the monthly
close, invoice follow-up, and the year-end package. For Claude Code, copy the folder to
`~/.claude/skills/cosimo-bookkeeping/`. For other clients, add it as a skill or paste it into the
project instructions.

## Technical details

- Transport: streamable HTTP, stateless. Each JSON-RPC `POST /mcp` gets an `application/json`
  answer. `GET /mcp` returns 405, because there is no server-initiated stream. Protocol versions
  2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are accepted.
- Authorization follows the MCP authorization spec, which is based on OAuth 2.1:
  - Protected resource metadata is at `/.well-known/oauth-protected-resource/mcp` and
    authorization server metadata at `/.well-known/oauth-authorization-server`. A request without
    a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - Clients can register themselves with dynamic client registration (`POST /oauth/register`),
    either as public clients (`token_endpoint_auth_method` `none`) or as confidential ones
    (`client_secret_post` or `client_secret_basic`). A confidential client gets its secret in the
    registration response, and the secret doesn't expire. An instance admin can turn dynamic
    registration off and register clients by hand instead, in Admin → Settings → OAuth clients.
    Those clients get a secret.
  - Authorization uses the code flow with PKCE, and only `S256` is accepted. Codes are single-use
    and last 10 minutes. Replaying a code revokes the tokens it produced.
  - One code, and the token pair it produces, covers every organization approved on the consent
    screen, each with its own role. A refresh drops any organization the user is no longer a member
    of, and fails only when none is left.
  - Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use, so an old
    refresh token stops working. Revoke a token with RFC 7009 at `POST /oauth/revoke`.
  - Redirect URIs must match exactly. `http://` is accepted only for `localhost`, `127.0.0.1` and
    `[::1]`, which may use any port (RFC 8252).
  - Codes, tokens and client secrets are stored only as SHA-256 hashes.
- Cookies aren't accepted at `/mcp`, and requests whose `Origin` isn't this instance's are refused.
  Both protect against DNS rebinding and cross-site use.
- Try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
  `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL `https://books.example.com/mcp`.
  Either let it run the OAuth flow, or add an `Authorization: Bearer <token>` header.
