# AGENTS.md: setting up and using Cosimo as an AI agent

Cosimo is self-hosted double-entry bookkeeping. This file tells an AI agent how to install it for a
person, check that it works, and connect to it for ongoing bookkeeping. The same file is published
at `https://raw.githubusercontent.com/steve-lomnes/cosimo/main/AGENTS.md`.

Everything below is a stable interface: `cosimo init --questions --json`, `cosimo init --answers
… --yes --json`, the result JSON, the exit codes, and `cosimo doctor --json`.

## 1. Install with one command

macOS and Linux:

```sh
curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/steve-lomnes/cosimo/releases/latest/download/install.ps1 | iex
```

The installer:
- downloads the release binary from GitHub Releases and checks its SHA-256 (and the cosign signature
  when `cosign` is installed);
- installs to `~/.local/bin/cosimo`, or `/usr/local/bin` as root;
- then runs `cosimo init` with any arguments given after `sh -s --`.

It never uses `sudo` unless given `--system`. Add `--no-init` to install only. The script is in the
repository at `scripts/install.sh` if the person wants to read it first.

Non-interactive, for agents: install first, then run init with the answers. When piping to `sh`,
stdin carries the script, so answers can't come from stdin in the same command.

```sh
curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --no-init
cosimo init --answers - --yes --json < answers.json     # or a heredoc; see below
```

An answers file also works in one line:
`curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --answers ./cosimo-answers.json --yes --json`.

## 2. Run a short Q&A, then apply the answers

Fetch the questions:

```sh
cosimo init --questions --json
```

You get `{ "schema_version": 1, "questions": [...] }`. Each question has these fields:

| Field | Meaning |
|---|---|
| `id` | Answer ID |
| `prompt` | The question to ask |
| `help` | Extra explanation |
| `type` | `choice`, `string`, `secret`, `email`, `path`, `boolean`, `integer`, or `date` |
| `choices` | Allowed values, for `choice` |
| `default` | Default value |
| `required` | Whether an answer is needed |
| `secret` | Whether the value is a secret |
| `ask_when` | Condition over earlier answers, such as `target == 'docker'` or `plaid_enabled` (`&&`, `||`, `!` allowed) |

Ask the human only the required questions, plus any whose default doesn't fit what they told you.
Pressing Enter through everything gives a working local instance, so most people need to answer:

- `admin_email` and `admin_name`
- `org_name`, and `entity_type` if it isn't a single-member LLC
- `target`: `local` (this computer), `docker` (their Linux server, with automatic HTTPS), or `fly`
- `domain`, for docker: DNS must point at the server
- `plaid_enabled`: whether they have Plaid keys now (file import works without them)

**Prefer `admin_auth: "claim_link"`.** Setup then creates the admin with no password and returns a
single-use link, valid for 24 hours, where the human sets their own password and optional 2FA. You
never see or handle their password. This is the default with `--json`.

**Pass secrets through stdin or environment variables, not files.** Examples are Plaid and SMTP
passwords, Turso tokens, and S3 keys. Any answer can come from `COSIMO_INIT_<ID>` in upper case,
which overrides the answers file:

```sh
COSIMO_INIT_PLAID_SECRET="$PLAID_SECRET" cosimo init --answers - --yes --json <<'EOF'
{"target":"docker","domain":"books.example.com","admin_email":"sam@example.com",
 "admin_name":"Sam","org_name":"Sam Consulting LLC","plaid_enabled":true,
 "plaid_client_id":"…","plaid_env":"sandbox"}
EOF
```

Exit codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | Read the JSON result |
| 2 | Missing or invalid answers; nothing was changed | The error JSON lists `missing` and `invalid` IDs. Ask for those and retry. |
| 3 | Environment problem, such as Docker or flyctl missing or logged out | The message includes the install or login command. |
| 4 | External service error (Turso, Plaid, Fly, SMTP) | Show the message to the human. |
| 5 | An instance already exists | Stop, or re-run with `--reconfigure` to change only the supplied answers. It never deletes data. |
| 1 | Anything else | Show the message. |

Progress goes to stderr; stdout carries exactly one JSON object.

## 3. Read the result and tell the human

```json
{
  "status": "ok",
  "url": "https://books.example.com",
  "claim_link": "https://books.example.com/claim/…",
  "claim_link_expires_at": "2026-09-26T12:00:00Z",
  "master_key_location": "/root/cosimo/.env",
  "next_steps": ["…"],
  "warnings": []
}
```

Tell the human:
1. The **URL**.
2. The **claim link**, and that it expires in 24 hours. If it expires, `cosimo user claim-link
   <email>` issues a new one; on docker, run it inside the container with `docker compose exec
   cosimo cosimo user claim-link <email>`.
3. **Back up the master key file** at `master_key_location`. Without it, stored bank connections and
   secrets can't be recovered. Never paste its contents into chat.
4. Anything in `warnings`, such as DNS not pointing at the server yet.

## 4. Check health

```sh
cosimo doctor --json          # docker: docker compose exec cosimo cosimo doctor --json
```

This returns `{ "status": "pass|warn|fail", "checks": [{ "id", "name", "status", "message",
"remediation" }] }` and exits 1 if any check fails. For each non-pass check, follow `remediation` or
explain it to the human. `server` and `tls` failures on a new docker install usually mean DNS or
ports 80/443. A `backups` warning is normal until the first nightly backup. If attachments or
backups use an S3-compatible bucket, see [docs/object-storage.md](docs/object-storage.md) for the
`backup_bucket` check and per-provider setup.

## 5. Connect for ongoing bookkeeping (MCP)

Cosimo serves a Model Context Protocol endpoint at `<url>/mcp` (streamable HTTP).

- **Preferred: OAuth with only the server URL.** Add `<url>/mcp` as a connector in your client. The
  human signs in, checks the organizations you may use (with a role in each), picks the default
  one, and approves. Tools take an optional `org_id`; without it they use the default. The default grant is Bookkeeper, with every
  write routed through the review queue.
- **Alternative: an API token**, for scripts or clients without OAuth. The human creates it in
  Account → Personal API tokens or with `cosimo token create --user <email> --org <org_id> --name <name> --role bookkeeper --propose-only`,
  and you send `Authorization: Bearer <token>`.

Tool list and protocol details: `docs/mcp.md`. REST API reference: `<url>/api/docs`
(OpenAPI at `<url>/api/v1/openapi.json`); mutating requests accept an `Idempotency-Key` header.

**Bundled skill.** `skills/cosimo-bookkeeping/SKILL.md` teaches the standard workflows: monthly
close, invoice follow-up, and year-end package. Install it by copying the folder into your client's
skills directory (for Claude Code, `~/.claude/skills/cosimo-bookkeeping/`). Read the organization's
business profile and bookkeeping notes (`org://profile`, `org://notes`) before categorizing.

## 6. Your writes go to the review queue

Everything you write to the books through MCP is proposed, not posted: categorizations, entries,
rules, invoice and bill drafts, and corrections (reversals, replacements, and payment date changes).
It waits in the review queue until a person approves it, unless an owner set a policy that
auto-approves it. Contacts and notes don't touch the books, so they apply directly. You can't
approve, reject, void, delete, or move lock dates.

- Always include a short `rationale` with each write.
- Write tools return a review item ID and its status. Tell the human when items are waiting, for
  example: "I proposed 23 categorizations; they're in Review for you to approve."
- Use `list_pending_reviews` to see what is still open.

## Example

> **Human:** Set me up with a bookkeeping system for my consulting LLC on my VPS.
>
> **Agent:** fetches `cosimo init --questions --json`, then asks for the domain, the human's email
> and name, the business name, and whether to connect Plaid now. It uses defaults for everything
> else. Over SSH it runs `curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --no-init`, then
> `cosimo init --answers - --yes --json` with the answers on stdin (`target: docker`, `admin_auth:
> claim_link`), then `docker compose exec cosimo cosimo doctor --json` from the directory init wrote.
> It replies:
>
> "Cosimo is running at https://books.example.com. Open this link within 24 hours to set your
> password: https://books.example.com/claim/…. Please back up /root/cosimo/.env somewhere safe:
> it holds the master key that protects your bank connections."
