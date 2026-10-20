/**
 * Plaid bank feeds (SPEC §7.1): bring-your-own keys, Link, `/transactions/sync` with a stored
 * cursor, pending handling, webhooks with signature verification, polling, and reauthentication.
 *
 * Access tokens are encrypted with the master key and never leave the server. Network calls run
 * outside database transactions; each sync applies all of its pages in one write.
 */
import { normalizeDescription, sha256Hex } from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, eq, inArray, isNotNull, max, ne } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { connectionMessage, isSyncing, syncStatusView, trackSync } from "./bank-sync.ts";
import {
  applyRulesTx,
  type BankTxnView,
  bankTxnView,
  createBankAccountTx,
  mustGetBankAccount,
  pairImportedTransfersTx,
} from "./banking.ts";
import {
  type Jwk,
  type PlaidAccount,
  type PlaidApi,
  type PlaidCredentials,
  PlaidError,
  type PlaidTransaction,
  plaidClient,
  REAUTH_CODES,
  type SyncPage,
} from "./plaid-client.ts";
import { matchForReceiptTx, releaseReceiptsForTxnTx, withReceipts } from "./receipts.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgDb | OrgTx;
type ConnRow = typeof org.bankConnections.$inferSelect;

// ----------------------------------------------------------------------------- credentials

export interface ResolvedPlaid extends PlaidCredentials {
  source: "org" | "instance";
}

/** Org-level keys win over instance keys (SPEC §7.1). Null when neither is complete. */
export async function plaidCredentials(ctx: AppContext, db: Reader): Promise<ResolvedPlaid | null> {
  const s = await db.select().from(org.orgSettings).get();
  if (s?.plaidClientId && s.plaidSecretEnc) {
    const secret = ctx.secrets.reveal(s.plaidSecretEnc);
    if (secret)
      return {
        source: "org",
        env: s.plaidEnv === "production" ? "production" : "sandbox",
        clientId: s.plaidClientId,
        secret,
      };
  }
  const p = await ctx.settings.get("plaid");
  if (p.enabled && p.client_id && p.secret)
    return { source: "instance", env: p.env, clientId: p.client_id, secret: p.secret };
  return null;
}

async function mustClient(ctx: AppContext, db: Reader): Promise<PlaidApi> {
  const creds = await plaidCredentials(ctx, db);
  if (!creds)
    throw unprocessable(
      "Plaid is not set up. An instance admin can add Plaid keys under Admin → Settings, or an owner can add org-level keys.",
      "plaid_not_configured",
    );
  return plaidClient(creds);
}

/** Webhook URL for this org, or null when there is no public HTTPS URL to receive it. */
export async function webhookUrl(ctx: AppContext, orgId: string): Promise<string | null> {
  const p = await ctx.settings.get("plaid");
  const base = (p.webhook_url || ctx.config.server.public_url || "").replace(/\/+$/, "");
  if (!base.startsWith("https://")) return null;
  return `${base}/api/v1/webhooks/plaid/${orgId}`;
}

export async function plaidStatus(ctx: AppContext, db: Reader, orgId: string) {
  const creds = await plaidCredentials(ctx, db);
  return {
    configured: Boolean(creds),
    env: creds?.env ?? null,
    source: creds?.source ?? null,
    webhooks: Boolean(await webhookUrl(ctx, orgId)),
    redirect_uri: (await ctx.settings.get("plaid")).redirect_uri || null,
  };
}

/**
 * Check keys with Plaid before storing them, so a wrong secret fails where it was entered rather than
 * later at Connect a bank. Plaid issues a different secret per environment, and a secret used with
 * the wrong one is the usual mistake, so the message names the environment.
 */
export async function verifyPlaidKeys(creds: PlaidCredentials): Promise<void> {
  try {
    await plaidClient(creds).checkCredentials();
  } catch (e) {
    if (!(e instanceof PlaidError)) throw e;
    if (e.code === "INVALID_API_KEYS") {
      const env = creds.env === "production" ? "Production" : "Sandbox";
      const other = creds.env === "production" ? "Sandbox" : "Production";
      throw unprocessable(
        `Plaid rejected these keys for ${env}. Plaid issues a separate secret for each environment: check that you copied the ${env} secret, or set Environment to ${other} if these are ${other} keys.`,
        "plaid_keys_rejected",
      );
    }
    if (e.code === "NETWORK_ERROR")
      throw new ApiError(502, "plaid_unreachable", `Could not reach Plaid to check the keys: ${e.message}`);
    throw unprocessable(`Plaid: ${e.message} (${e.code})`, "plaid_keys_rejected");
  }
}

function toApiError(e: unknown): never {
  if (e instanceof PlaidError) {
    throw new ApiError(502, "plaid_error", `Plaid: ${e.message} (${e.code})`, {
      plaid_error_code: e.code,
      request_id: e.requestId ?? null,
    });
  }
  throw e;
}

function assertCanManage(a: ActorInfo) {
  if (a.role !== "owner") throw forbidden("Only owners can manage bank connections.");
  if (a.actor === "mcp" || a.proposeOnly) throw forbidden("AI assistants cannot manage bank connections.");
}

// ----------------------------------------------------------------------------- views

export async function listConnections(db: Reader) {
  const conns = await db.select().from(org.bankConnections).all();
  const accts = await db
    .select()
    .from(org.bankAccounts)
    .where(isNotNull(org.bankAccounts.connectionId))
    .all();
  return conns.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => connectionView(c, accts));
}

function connectionView(c: ConnRow, accts: (typeof org.bankAccounts.$inferSelect)[]) {
  return {
    id: c.id,
    provider: c.provider,
    institution_name: c.institutionName,
    status: c.status,
    error_code: c.errorCode,
    message: connectionMessage(c),
    ...syncStatusView(c),
    created_at: c.createdAt,
    accounts: accts
      .filter((a) => a.connectionId === c.id)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mask: a.mask,
        kind: a.kind,
        is_active: a.isActive,
        provider_account_id: a.providerAccountId,
      })),
  };
}

export type ConnectionView = ReturnType<typeof connectionView>;

async function mustConnection(db: Reader, id: string) {
  const c = await db.select().from(org.bankConnections).where(eq(org.bankConnections.id, id)).get();
  if (!c) throw notFound("Bank connection");
  return c;
}

export async function getConnection(db: Reader, id: string) {
  const c = await mustConnection(db, id);
  const accts = await db.select().from(org.bankAccounts).where(eq(org.bankAccounts.connectionId, id)).all();
  return connectionView(c, accts);
}

// ----------------------------------------------------------------------------- link

export async function createLinkToken(
  ctx: AppContext,
  orgId: string,
  a: ActorInfo,
  opts: { connectionId?: string | null; accountSelection?: boolean } = {},
) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const client = await mustClient(ctx, h.db);
  let accessToken: string | null = null;
  if (opts.connectionId) {
    const c = await mustConnection(h.db, opts.connectionId);
    if (c.status === "disconnected")
      throw conflict("This connection was removed. Connect the bank again instead.", "invalid_state");
    accessToken = ctx.secrets.reveal(c.accessTokenEnc);
  }
  const name = (await ctx.orgs.get(orgId))?.name ?? "Cosimo";
  const p = await ctx.settings.get("plaid");
  try {
    const r = await client.linkTokenCreate({
      userId: `${orgId}:${a.userId ?? "system"}`,
      clientName: name,
      webhook: await webhookUrl(ctx, orgId),
      redirectUri: p.redirect_uri || null,
      accessToken,
      // Account selection only applies to update mode: adding accounts to an existing login.
      accountSelection: Boolean(accessToken && opts.accountSelection),
    });
    return { link_token: r.link_token, expiration: r.expiration, update_mode: Boolean(accessToken) };
  } catch (e) {
    toApiError(e);
  }
}

export type AccountChoice =
  | { account_id: string; action: "new"; ledger_account_id?: string | null; name?: string | null }
  | { account_id: string; action: "link"; bank_account_id: string }
  | { account_id: string; action: "skip" };

function kindFor(a: PlaidAccount): "checking" | "savings" | "credit_card" | "other" {
  if (a.type === "credit") return "credit_card";
  if (a.type === "depository")
    return a.subtype === "savings" ? "savings" : a.subtype === "checking" ? "checking" : "other";
  return "other";
}

/** Plaid products cover deposit and card accounts; loans and investments are skipped by default. */
function defaultAction(a: PlaidAccount): "new" | "skip" {
  return a.type === "depository" || a.type === "credit" ? "new" : "skip";
}

/**
 * Create or link a bank account for each Plaid account per the user's choices; an account with no
 * choice gets `defaultFor`. Returns how many accounts were added or linked.
 */
async function applyAccountChoicesTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  connId: string,
  plaidAccounts: PlaidAccount[],
  choices: AccountChoice[],
  defaultFor: (a: PlaidAccount) => "new" | "skip",
) {
  const byId = new Map(choices.map((c) => [c.account_id, c]));
  let n = 0;
  for (const pa of plaidAccounts) {
    const choice: AccountChoice = byId.get(pa.account_id) ?? {
      account_id: pa.account_id,
      action: defaultFor(pa),
    };
    if (choice.action === "skip") continue;
    n++;
    if (choice.action === "link") {
      const ba = await tx
        .select()
        .from(org.bankAccounts)
        .where(eq(org.bankAccounts.id, choice.bank_account_id))
        .get();
      if (!ba) throw notFound("Bank account");
      if (ba.connectionId) {
        const other = await tx
          .select()
          .from(org.bankConnections)
          .where(eq(org.bankConnections.id, ba.connectionId))
          .get();
        if (other && other.status !== "disconnected")
          throw conflict(`${ba.name} is already connected to a bank feed.`, "already_linked");
      }
      await tx
        .update(org.bankAccounts)
        .set({ connectionId: connId, providerAccountId: pa.account_id, mask: pa.mask ?? ba.mask })
        .where(eq(org.bankAccounts.id, ba.id));
      await appendAudit(tx, orgId, a, {
        action: "bank_account.connect",
        targetType: "bank_account",
        targetId: ba.id,
        after: { connection_id: connId },
      });
      continue;
    }
    await createBankAccountTx(tx, orgId, a, {
      name: (choice.name || pa.name || pa.official_name || "Bank account").slice(0, 200),
      kind: kindFor(pa),
      mask: pa.mask ?? null,
      ledger_account_id: choice.ledger_account_id ?? null,
      connection_id: connId,
      provider_account_id: pa.account_id,
    });
  }
  return n;
}

/**
 * Finish Link: exchange the public token, record the connection with an encrypted access token,
 * create or link bank accounts per the user's choices, and run the first sync.
 */
export async function exchangePublicToken(
  ctx: AppContext,
  orgId: string,
  a: ActorInfo,
  input: { public_token: string; accounts?: AccountChoice[] },
) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const client = await mustClient(ctx, h.db);
  let exchanged: { access_token: string; item_id: string };
  let accounts: PlaidAccount[];
  let institutionId: string | null;
  try {
    exchanged = await client.exchangePublicToken(input.public_token);
    ({ accounts, institution_id: institutionId } = await client.accountsGet(exchanged.access_token));
  } catch (e) {
    toApiError(e);
  }
  const institutionName = institutionId
    ? await client.institutionName(institutionId).catch(() => null)
    : null;
  const connId = await h.write(async (tx) => {
    const existing = await tx
      .select()
      .from(org.bankConnections)
      .where(
        and(
          eq(org.bankConnections.itemId, exchanged.item_id),
          ne(org.bankConnections.status, "disconnected"),
        ),
      )
      .get();
    if (existing) throw conflict("This bank login is already connected.", "already_connected");
    const id = newId();
    await tx.insert(org.bankConnections).values({
      id,
      provider: "plaid",
      itemId: exchanged.item_id,
      accessTokenEnc: ctx.secrets.encrypt(exchanged.access_token),
      institutionName,
      institutionId,
      status: "active",
    });
    await appendAudit(tx, orgId, a, {
      action: "bank_connection.create",
      targetType: "bank_connection",
      targetId: id,
      after: { provider: "plaid", institution_name: institutionName, accounts: accounts.length },
    });
    await applyAccountChoicesTx(tx, orgId, a, id, accounts, input.accounts ?? [], defaultAction);
    return id;
  });

  let sync: SyncSummary | null = null;
  try {
    sync = await syncConnection(ctx, orgId, connId, { userId: a.userId });
  } catch {
    // The connection is recorded; the error is stored on it and polling retries.
  }
  return { connection: await getConnection(h.db, connId), sync };
}

/** After Link update mode succeeds: mark the connection healthy and sync. */
export async function markReconnected(ctx: AppContext, orgId: string, a: ActorInfo, connectionId: string) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  await h.write(async (tx) => {
    const c = await mustConnection(tx, connectionId);
    if (c.status === "disconnected") throw conflict("This connection was removed.", "invalid_state");
    await tx
      .update(org.bankConnections)
      .set({ status: "active", errorCode: null, errorMessage: null })
      .where(eq(org.bankConnections.id, connectionId));
    await appendAudit(tx, orgId, a, {
      action: "bank_connection.reauth",
      targetType: "bank_connection",
      targetId: connectionId,
      before: { status: c.status, error_code: c.errorCode },
      after: { status: "active" },
    });
  });
  let sync: SyncSummary | null = null;
  try {
    sync = await syncConnection(ctx, orgId, connectionId, { userId: a.userId });
  } catch {
    // stored on the connection
  }
  return { connection: await getConnection(h.db, connectionId), sync };
}

/** An active connection's access token, for calls an owner makes about its accounts. */
async function liveToken(ctx: AppContext, db: Reader, connectionId: string) {
  const c = await mustConnection(db, connectionId);
  if (c.status === "disconnected") throw conflict("This connection was removed.", "invalid_state");
  const token = ctx.secrets.reveal(c.accessTokenEnc);
  if (!token) throw unprocessable("Plaid is not set up for this organization.", "plaid_not_configured");
  return token;
}

async function linkedProviderIds(db: Reader, connectionId: string) {
  const rows = await db
    .select({ p: org.bankAccounts.providerAccountId })
    .from(org.bankAccounts)
    .where(eq(org.bankAccounts.connectionId, connectionId))
    .all();
  return new Set(rows.map((r) => r.p).filter((p): p is string => Boolean(p)));
}

/** Plaid accounts at this login that no bank account in Cosimo is linked to yet (#12). */
export async function availableAccounts(ctx: AppContext, orgId: string, a: ActorInfo, connectionId: string) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const client = await mustClient(ctx, h.db);
  const token = await liveToken(ctx, h.db, connectionId);
  let accounts: PlaidAccount[];
  try {
    ({ accounts } = await client.accountsGet(token));
  } catch (e) {
    toApiError(e);
  }
  const linked = await linkedProviderIds(h.db, connectionId);
  return accounts
    .filter((x) => !linked.has(x.account_id))
    .map((x) => ({
      account_id: x.account_id,
      name: x.name,
      mask: x.mask ?? null,
      type: x.type,
      subtype: x.subtype ?? null,
    }));
}

/**
 * Add accounts to an existing connection after Link update mode with account selection (#12).
 * Only accounts not already linked are eligible, and an account with no choice is skipped: the
 * owner picked explicitly. Clears the new-accounts flag, then syncs.
 */
export async function addAccounts(
  ctx: AppContext,
  orgId: string,
  a: ActorInfo,
  connectionId: string,
  choices: AccountChoice[],
) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  let accounts: PlaidAccount[] = [];
  // With nothing chosen this only clears the flag, so it doesn't need Plaid.
  if (choices.length) {
    const client = await mustClient(ctx, h.db);
    const token = await liveToken(ctx, h.db, connectionId);
    try {
      ({ accounts } = await client.accountsGet(token));
    } catch (e) {
      toApiError(e);
    }
  }
  await h.write(async (tx) => {
    const c = await mustConnection(tx, connectionId);
    if (c.status === "disconnected") throw conflict("This connection was removed.", "invalid_state");
    const linked = await linkedProviderIds(tx, connectionId);
    const eligible = accounts.filter((x) => !linked.has(x.account_id));
    const added = await applyAccountChoicesTx(tx, orgId, a, connectionId, eligible, choices, () => "skip");
    await tx
      .update(org.bankConnections)
      .set({ newAccountsAvailable: false })
      .where(eq(org.bankConnections.id, connectionId));
    await appendAudit(tx, orgId, a, {
      action: "bank_connection.add_accounts",
      targetType: "bank_connection",
      targetId: connectionId,
      after: { accounts: added },
    });
  });
  let sync: SyncSummary | null = null;
  try {
    sync = await syncConnection(ctx, orgId, connectionId, { userId: a.userId });
  } catch {
    // stored on the connection
  }
  return { connection: await getConnection(h.db, connectionId), sync };
}

/** Remove the item at Plaid and forget the access token. Imported transactions stay. */
export async function disconnect(ctx: AppContext, orgId: string, a: ActorInfo, connectionId: string) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const c = await mustConnection(h.db, connectionId);
  if (c.status !== "disconnected") {
    const token = ctx.secrets.reveal(c.accessTokenEnc);
    const creds = await plaidCredentials(ctx, h.db);
    if (token && creds) {
      try {
        await plaidClient(creds).itemRemove(token);
      } catch (e) {
        // An item Plaid no longer knows about is already gone.
        if (!(e instanceof PlaidError) || !["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"].includes(e.code))
          toApiError(e);
      }
    }
  }
  await h.write(async (tx) => {
    await tx
      .update(org.bankConnections)
      .set({
        status: "disconnected",
        accessTokenEnc: "",
        syncCursor: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(org.bankConnections.id, connectionId));
    await appendAudit(tx, orgId, a, {
      action: "bank_connection.disconnect",
      targetType: "bank_connection",
      targetId: connectionId,
      before: { status: c.status },
      after: { status: "disconnected" },
    });
  });
  return getConnection(h.db, connectionId);
}

// ----------------------------------------------------------------------------- sync

export interface SyncSummary {
  added: number;
  modified: number;
  removed: number;
  skipped: number;
  transfers_paired: number;
  rules_applied: number;
  /** Rows this sync inserted, pending ones included, in insert order. */
  transaction_ids: string[];
}

export interface SyncOpts {
  userId?: string | null;
  /** Who asked for this sync. When set, every completed or failed sync is audited as them. */
  actor?: ActorInfo;
}

/** Plaid sign is money-out positive; ours is money-in positive. Amounts have two decimals. */
export function plaidCents(amount: number): number {
  const c = -Math.round(amount * 100);
  return c === 0 ? 0 : c;
}

function plaidHash(transactionId: string) {
  return sha256Hex(JSON.stringify(["plaid", transactionId]));
}

function describe(t: PlaidTransaction) {
  const description = (t.original_description || t.name || t.merchant_name || "Transaction").slice(0, 500);
  const payee = t.merchant_name?.slice(0, 200) ?? null;
  return { description, payee, normalizedDescription: normalizeDescription(payee || description) };
}

/** Sync one connection. Concurrent calls for the same connection share one run. */
export function syncConnection(
  ctx: AppContext,
  orgId: string,
  connectionId: string,
  opts: SyncOpts = {},
): Promise<SyncSummary> {
  return trackSync(connectionId, () => runSync(ctx, orgId, connectionId, opts));
}

async function fetchAll(client: PlaidApi, token: string, cursor: string | null) {
  // Plaid asks clients to restart from the original cursor if data changes mid-pagination.
  for (let attempt = 0; ; attempt++) {
    const pages: SyncPage[] = [];
    let next = cursor;
    try {
      for (;;) {
        const page = await client.transactionsSync(token, next);
        pages.push(page);
        next = page.next_cursor;
        if (!page.has_more) break;
      }
      return { pages, cursor: next };
    } catch (e) {
      if (e instanceof PlaidError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 3)
        continue;
      throw e;
    }
  }
}

async function runSync(
  ctx: AppContext,
  orgId: string,
  connectionId: string,
  opts: SyncOpts,
): Promise<SyncSummary> {
  const h = await ctx.orgs.mustOpen(orgId);
  const c = await mustConnection(h.db, connectionId);
  if (c.status === "disconnected") throw conflict("This connection was removed.", "invalid_state");
  const creds = await plaidCredentials(ctx, h.db);
  const token = ctx.secrets.reveal(c.accessTokenEnc);
  if (!creds || !token)
    throw unprocessable("Plaid is not set up for this organization.", "plaid_not_configured");

  let fetched: Awaited<ReturnType<typeof fetchAll>>;
  try {
    fetched = await fetchAll(plaidClient(creds), token, c.syncCursor);
  } catch (e) {
    if (e instanceof PlaidError) {
      await recordFailure(h, orgId, connectionId, e, opts.actor);
      ctx.logger.warn("plaid sync failed", { org: orgId, connection: connectionId, code: e.code });
    }
    throw e instanceof PlaidError
      ? new ApiError(502, "plaid_error", `Plaid: ${e.message} (${e.code})`, { plaid_error_code: e.code })
      : e;
  }

  const added = fetched.pages.flatMap((p) => p.added);
  const modified = fetched.pages.flatMap((p) => p.modified);
  const removed = fetched.pages.flatMap((p) => p.removed);

  return h.write(async (tx) => {
    const accts = await tx
      .select()
      .from(org.bankAccounts)
      .where(eq(org.bankAccounts.connectionId, connectionId))
      .all();
    const byProvider = new Map(
      accts.filter((x) => x.providerAccountId).map((x) => [x.providerAccountId!, x]),
    );
    const cutoffs = await fileImportCutoffs(
      tx,
      accts.map((x) => x.id),
    );
    const summary: SyncSummary = {
      added: 0,
      modified: 0,
      removed: 0,
      skipped: 0,
      transfers_paired: 0,
      rules_applied: 0,
      transaction_ids: [],
    };

    // Removals first: a pending row replaced by its posted version is removed in the same sync.
    // A deleted row's receipts go back to the inbox first, and are matched again after the rules
    // run (which match the rows this sync adds).
    const released: string[] = [];
    const removedIds = removed.map((r) => r.transaction_id);
    const acctIds = accts.map((x) => x.id);
    if (removedIds.length && acctIds.length) {
      const rows = await tx
        .select()
        .from(org.bankTransactions)
        .where(
          and(
            inArray(org.bankTransactions.bankAccountId, acctIds),
            inArray(org.bankTransactions.providerTransactionId, removedIds),
          ),
        )
        .all();
      for (const r of rows) {
        if ((r.status === "new" || r.status === "excluded") && !r.reviewItemId && !r.matchedEntryId) {
          released.push(...(await releaseReceiptsForTxnTx(tx, orgId, systemActor(opts.userId), r.id)));
          await tx.delete(org.bankTransactions).where(eq(org.bankTransactions.id, r.id));
          summary.removed++;
        } else {
          // Already booked: keep the row and its entry; record what the bank did.
          await appendAudit(tx, orgId, systemActor(opts.userId), {
            action: "bank_txn.provider_removed",
            targetType: "bank_transaction",
            targetId: r.id,
            before: { date: r.date, amount: r.amount, status: r.status },
          });
        }
      }
    }

    const batches = new Map<string, string>();
    const newIds: string[] = [];
    for (const t of added) {
      const ba = byProvider.get(t.account_id);
      if (!ba?.isActive) {
        summary.skipped++;
        continue;
      }
      const cutoff = cutoffs.get(ba.id);
      if (cutoff && t.date <= cutoff) {
        summary.skipped++;
        continue;
      }
      let batchId = batches.get(ba.id);
      if (!batchId) {
        batchId = newId();
        batches.set(ba.id, batchId);
        await tx.insert(org.importBatches).values({
          id: batchId,
          bankAccountId: ba.id,
          source: "plaid",
          filename: null,
          createdBy: opts.userId ?? null,
        });
      }
      const d = describe(t);
      const id = newId();
      const res = await tx
        .insert(org.bankTransactions)
        .values({
          id,
          bankAccountId: ba.id,
          providerTransactionId: t.transaction_id,
          pendingTransactionId: t.pending_transaction_id ?? null,
          batchId,
          date: t.date,
          amount: plaidCents(t.amount),
          ...d,
          isPending: t.pending,
          dedupeHash: plaidHash(t.transaction_id),
        })
        .onConflictDoNothing()
        .returning({ id: org.bankTransactions.id });
      if (!res.length) continue;
      summary.added++;
      summary.transaction_ids.push(id);
      if (!t.pending) newIds.push(id);
    }
    for (const [bankAccountId, batchId] of batches) {
      const n = added.filter((t) => byProvider.get(t.account_id)?.id === bankAccountId).length;
      const imported = await tx
        .select({ id: org.bankTransactions.id })
        .from(org.bankTransactions)
        .where(eq(org.bankTransactions.batchId, batchId))
        .all();
      await tx
        .update(org.importBatches)
        .set({ rowCount: n, importedCount: imported.length, duplicateCount: n - imported.length })
        .where(eq(org.importBatches.id, batchId));
    }

    for (const t of modified) {
      const ba = byProvider.get(t.account_id);
      if (!ba) continue;
      const row = await tx
        .select()
        .from(org.bankTransactions)
        .where(
          and(
            eq(org.bankTransactions.bankAccountId, ba.id),
            eq(org.bankTransactions.providerTransactionId, t.transaction_id),
          ),
        )
        .get();
      if (!row) continue;
      const next = { date: t.date, amount: plaidCents(t.amount), isPending: t.pending, ...describe(t) };
      if (row.status === "new" && !row.reviewItemId) {
        await tx.update(org.bankTransactions).set(next).where(eq(org.bankTransactions.id, row.id));
        summary.modified++;
        if (row.isPending && !t.pending) newIds.push(row.id);
      } else if (row.amount !== next.amount || row.date !== next.date) {
        await appendAudit(tx, orgId, systemActor(opts.userId), {
          action: "bank_txn.provider_modified",
          targetType: "bank_transaction",
          targetId: row.id,
          before: { date: row.date, amount: row.amount },
          after: { date: next.date, amount: next.amount },
        });
      }
    }

    summary.transfers_paired = await pairImportedTransfersTx(tx, orgId, newIds);
    summary.rules_applied = (await applyRulesTx(tx, orgId, newIds, systemActor(opts.userId))).applied;
    for (const id of new Set(released)) await matchForReceiptTx(tx, orgId, systemActor(opts.userId), id);

    const now = new Date().toISOString();
    await tx
      .update(org.bankConnections)
      .set({
        syncCursor: fetched.cursor,
        lastSyncedAt: now,
        lastSyncAttemptAt: now,
        lastSyncAdded: summary.added,
        lastSyncModified: summary.modified,
        lastSyncRemoved: summary.removed,
        status: "active",
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(org.bankConnections.id, connectionId));
    // Someone asked for this sync: record it even when nothing changed. Background syncs are
    // recorded only when they changed something.
    if (opts.actor || summary.added || summary.modified || summary.removed) {
      const { transaction_ids: _ids, ...counts } = summary;
      await appendAudit(tx, orgId, opts.actor ?? systemActor(opts.userId), {
        action: "bank_connection.sync",
        targetType: "bank_connection",
        targetId: connectionId,
        after: counts,
      });
    }
    return summary;
  });
}

/** Store a failed sync or refresh on the connection, audited when someone asked for it. */
async function recordFailure(
  h: OrgHandle,
  orgId: string,
  connectionId: string,
  e: PlaidError,
  actor?: ActorInfo,
) {
  const status = REAUTH_CODES.has(e.code) ? "needs_reauth" : "error";
  await h.write(async (tx) => {
    await tx
      .update(org.bankConnections)
      .set({
        status,
        errorCode: e.code,
        errorMessage: e.message.slice(0, 500),
        lastSyncAttemptAt: new Date().toISOString(),
      })
      .where(eq(org.bankConnections.id, connectionId));
    if (actor)
      await appendAudit(tx, orgId, actor, {
        action: "bank_connection.sync_failed",
        targetType: "bank_connection",
        targetId: connectionId,
        after: { status, error_code: e.code },
      });
  });
}

function systemActor(userId?: string | null): ActorInfo {
  return userId ? { actor: "user", role: "owner", userId } : { actor: "system", role: "owner", userId: null };
}

/**
 * When a Plaid account is linked to a bank account that already has statement imports, feed
 * transactions on or before the last imported date are skipped so the two sources never overlap.
 */
async function fileImportCutoffs(tx: OrgTx, bankAccountIds: string[]) {
  const out = new Map<string, string>();
  if (!bankAccountIds.length) return out;
  const rows = await tx
    .select({
      id: org.bankTransactions.bankAccountId,
      source: org.importBatches.source,
      d: max(org.bankTransactions.date),
    })
    .from(org.bankTransactions)
    .leftJoin(org.importBatches, eq(org.importBatches.id, org.bankTransactions.batchId))
    .where(inArray(org.bankTransactions.bankAccountId, bankAccountIds))
    .groupBy(org.bankTransactions.bankAccountId, org.importBatches.source)
    .all();
  for (const r of rows) {
    if (r.source === "plaid" || !r.d) continue;
    const cur = out.get(r.id);
    if (!cur || r.d > cur) out.set(r.id, r.d);
  }
  return out;
}

/** Sync every connection that is not waiting on the user (polling job and "sync all"). */
export async function syncAll(ctx: AppContext, orgId: string) {
  const h = await ctx.orgs.mustOpen(orgId);
  if (!(await plaidCredentials(ctx, h.db))) return { synced: 0, failed: 0, skipped: 0 };
  const conns = await h.db.select().from(org.bankConnections).all();
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of conns) {
    if (c.status === "disconnected" || c.status === "needs_reauth") {
      skipped++;
      continue;
    }
    try {
      await syncConnection(ctx, orgId, c.id);
      synced++;
    } catch {
      failed++;
    }
  }
  return { synced, failed, skipped };
}

// ----------------------------------------------------------------------------- assistant sync

export type AssistantSyncStatus =
  | "synced"
  | "cooldown"
  | "in_progress"
  | "needs_reauth"
  | "error"
  | "disconnected";

const REFRESH_NOTE =
  "Plaid is checking the bank for newer transactions. They arrive asynchronously: a webhook-triggered sync or a later sync_bank_feed call picks them up.";

/** New rows listed in one result; a first sync can bring back two years of history. */
const MAX_TXNS = 200;

const REAUTH_NOTE = "A person must reconnect it in Cosimo (Banking → Accounts). You can't do this.";

/**
 * Sync bank feeds for an AI assistant (the `sync_bank_feed` MCP tool): one connection, the one
 * behind a bank account, or every connection that isn't disconnected. Connections waiting on a
 * person, already syncing, or synced within the cooldown are reported without calling Plaid.
 */
export async function syncForAssistant(
  ctx: AppContext,
  orgId: string,
  actor: ActorInfo,
  input: { bankAccountId?: string; connectionId?: string; forceRefresh?: boolean },
) {
  if (input.bankAccountId && input.connectionId)
    throw badRequest("Pass bank_account_id or connection_id, not both.");
  const h = await ctx.orgs.mustOpen(orgId);
  let targets: ConnRow[];
  if (input.bankAccountId) {
    const ba = await mustGetBankAccount(h.db, input.bankAccountId);
    if (!ba.connectionId)
      throw unprocessable("This account has no bank feed; import a statement instead.", "not_connected");
    targets = [await mustConnection(h.db, ba.connectionId)];
  } else if (input.connectionId) {
    targets = [await mustConnection(h.db, input.connectionId)];
  } else {
    targets = (await h.db.select().from(org.bankConnections).all())
      .filter((c) => c.status !== "disconnected")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const creds = await plaidCredentials(ctx, h.db);
  if (!creds)
    throw unprocessable(
      "Plaid is not set up. An instance admin can add Plaid keys under Admin → Settings, or an owner can add org-level keys.",
      "plaid_not_configured",
    );
  const p = await ctx.settings.get("plaid");
  const accts = await h.db
    .select()
    .from(org.bankAccounts)
    .where(isNotNull(org.bankAccounts.connectionId))
    .all();

  const results = [];
  for (const c of targets) {
    const r = await syncOneForAssistant(ctx, h, orgId, actor, c, {
      forceRefresh: Boolean(input.forceRefresh),
      cooldownSeconds: p.sync_cooldown_seconds,
      refreshEnabled: p.refresh_enabled,
      client: plaidClient(creds),
    });
    const fresh = await mustConnection(h.db, c.id);
    const ids = r.summary?.transaction_ids ?? [];
    results.push({
      connection_id: c.id,
      institution_name: c.institutionName,
      bank_accounts: accts
        .filter((x) => x.connectionId === c.id)
        .map((x) => ({ id: x.id, name: x.name, mask: x.mask })),
      status: r.status,
      added: r.summary?.added ?? null,
      modified: r.summary?.modified ?? null,
      removed: r.summary?.removed ?? null,
      message: r.message,
      retry_after_seconds: r.retryAfter ?? null,
      refresh: r.refresh,
      refresh_error: r.refreshError ?? null,
      ...syncStatusView(fresh),
      transactions: r.summary ? await txnsById(h.db, ids.slice(0, MAX_TXNS)) : [],
      transactions_omitted: Math.max(0, ids.length - MAX_TXNS),
    });
  }
  return { connections: results };
}

interface OneResult {
  status: AssistantSyncStatus;
  message: string | null;
  refresh: "requested" | "failed" | "not_enabled" | null;
  refreshError?: string;
  retryAfter?: number;
  summary?: SyncSummary;
}

async function syncOneForAssistant(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  actor: ActorInfo,
  c: ConnRow,
  o: { forceRefresh: boolean; cooldownSeconds: number; refreshEnabled: boolean; client: PlaidApi },
): Promise<OneResult> {
  if (c.status === "disconnected")
    return { status: "disconnected", message: connectionMessage(c), refresh: null };
  if (c.status === "needs_reauth")
    return {
      status: "needs_reauth",
      message: `${connectionMessage(c) ?? "The bank needs you to reconnect."} ${REAUTH_NOTE}`,
      refresh: null,
    };
  if (isSyncing(c.id))
    return {
      status: "in_progress",
      message: "A sync of this connection is already running. Check again shortly.",
      refresh: null,
    };
  const last = c.lastSyncAttemptAt ?? c.lastSyncedAt;
  if (last && o.cooldownSeconds > 0) {
    const wait = o.cooldownSeconds * 1000 - (Date.now() - Date.parse(last));
    if (wait > 0) {
      const retryAfter = Math.ceil(wait / 1000);
      return {
        status: "cooldown",
        message: `This connection synced moments ago. Try again in ${retryAfter} seconds.`,
        refresh: null,
        retryAfter,
      };
    }
  }

  let refresh: OneResult["refresh"] = null;
  let refreshError: string | undefined;
  if (o.forceRefresh && !o.refreshEnabled) refresh = "not_enabled";
  else if (o.forceRefresh) {
    try {
      await o.client.transactionsRefresh(ctx.secrets.reveal(c.accessTokenEnc) ?? "");
      refresh = "requested";
    } catch (e) {
      if (!(e instanceof PlaidError)) throw e;
      refresh = "failed";
      refreshError = e.code;
      // The login itself is broken: the sync would fail the same way.
      if (REAUTH_CODES.has(e.code)) {
        await recordFailure(h, orgId, c.id, e, actor);
        const now = await mustConnection(h.db, c.id);
        return {
          status: "needs_reauth",
          message: `${connectionMessage(now) ?? "The bank needs you to reconnect."} ${REAUTH_NOTE}`,
          refresh,
          refreshError,
        };
      }
    }
  }

  try {
    const summary = await syncConnection(ctx, orgId, c.id, { userId: actor.userId, actor });
    const counts = `${summary.added} new, ${summary.modified} changed, ${summary.removed} removed.`;
    const notes = [
      summary.added || summary.modified || summary.removed ? `Synced: ${counts}` : "Synced: nothing new.",
    ];
    if (refresh === "requested") notes.push(REFRESH_NOTE);
    if (refresh === "not_enabled")
      notes.push("force_refresh is not enabled on this instance; this sync used what Plaid already had.");
    if (refresh === "failed") notes.push(`Plaid refused the refresh (${refreshError}); the sync still ran.`);
    return { status: "synced", message: notes.join(" "), refresh, refreshError, summary };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const now = await mustConnection(h.db, c.id);
    if (now.status === "needs_reauth")
      return {
        status: "needs_reauth",
        message: `${connectionMessage(now) ?? "The bank needs you to reconnect."} ${REAUTH_NOTE}`,
        refresh,
        refreshError,
      };
    return { status: "error", message: e.message, refresh, refreshError };
  }
}

/** The rows a sync inserted, in its order, as the Categorize view shows them. */
async function txnsById(db: Reader, ids: string[]): Promise<BankTxnView[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ t: org.bankTransactions, entryStatus: org.journalEntries.status })
    .from(org.bankTransactions)
    .leftJoin(org.journalEntries, eq(org.journalEntries.id, org.bankTransactions.matchedEntryId))
    .where(inArray(org.bankTransactions.id, ids))
    .all();
  const views = await withReceipts(
    db,
    rows.map((r) => bankTxnView(r.t, r.entryStatus)),
  );
  const byId = new Map(views.map((v) => [v.id, v]));
  return ids.map((id) => byId.get(id)).filter((x): x is BankTxnView => Boolean(x));
}

// ----------------------------------------------------------------------------- webhooks

const keyCache = new Map<string, { jwk: Jwk; at: number }>();
const MAX_WEBHOOK_AGE_S = 5 * 60;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Plaid webhook: ES256 JWT in `Plaid-Verification`, key fetched by `kid` from Plaid,
 * issued within five minutes, and `request_body_sha256` equal to the SHA-256 of the raw body.
 */
export async function verifyPlaidWebhook(
  client: PlaidApi,
  jwt: string | undefined,
  rawBody: string,
  now = Date.now(),
): Promise<boolean> {
  if (!jwt) return false;
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [h64, p64, s64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { iat?: number; request_body_sha256?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p64)));
  } catch {
    return false;
  }
  if (header.alg !== "ES256" || !header.kid) return false;

  let cached = keyCache.get(header.kid);
  if (!cached || now - cached.at > 24 * 3_600_000) {
    try {
      cached = { jwk: await client.webhookVerificationKey(header.kid), at: now };
    } catch {
      return false;
    }
    keyCache.set(header.kid, cached);
  }
  const jwk = cached.jwk;
  if (jwk.expired_at) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlDecode(s64),
      new TextEncoder().encode(`${h64}.${p64}`),
    );
    if (!ok) return false;
  } catch {
    return false;
  }
  if (typeof payload.iat !== "number" || now / 1000 - payload.iat > MAX_WEBHOOK_AGE_S) return false;
  if (typeof payload.request_body_sha256 !== "string") return false;
  return timingSafeEqualHex(payload.request_body_sha256, sha256Hex(rawBody));
}

/** Tests: forget cached verification keys. */
export function clearWebhookKeys() {
  keyCache.clear();
}

const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "DEFAULT_UPDATE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
]);

/**
 * Handle a verified-or-not webhook for an org. Returns what was done; `done` settles when any
 * sync it started finishes (the HTTP handler answers without waiting).
 */
export async function handleWebhook(
  ctx: AppContext,
  orgId: string,
  rawBody: string,
  signature: string | undefined,
): Promise<{ action: string; done: Promise<unknown> }> {
  const h = await ctx.orgs.open(orgId);
  if (!h) throw notFound("Organization");
  const creds = await plaidCredentials(ctx, h.db);
  if (!creds) throw badRequest("Plaid is not configured.", undefined, "plaid_not_configured");
  if (!(await verifyPlaidWebhook(plaidClient(creds), signature, rawBody)))
    throw new ApiError(401, "invalid_signature", "Webhook signature verification failed.");
  let body: {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
    error?: { error_code?: string };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw badRequest("Invalid JSON.");
  }
  const none = { action: "ignored", done: Promise.resolve() };
  if (!body.item_id) return none;
  const c = await h.db
    .select()
    .from(org.bankConnections)
    .where(and(eq(org.bankConnections.itemId, body.item_id), ne(org.bankConnections.status, "disconnected")))
    .get();
  if (!c) return none;
  const setStatus = (status: ConnRow["status"], errorCode: string | null) =>
    h.write((tx) =>
      tx
        .update(org.bankConnections)
        .set({ status, errorCode, errorMessage: null })
        .where(eq(org.bankConnections.id, c.id)),
    );
  const sync = () =>
    syncConnection(ctx, orgId, c.id).catch((e) => {
      ctx.logger.warn("plaid webhook sync failed", { org: orgId, connection: c.id, error: String(e) });
    });

  if (body.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(body.webhook_code ?? "")) {
    if (c.status === "needs_reauth") return none;
    return { action: "sync", done: sync() };
  }
  if (body.webhook_type === "ITEM") {
    switch (body.webhook_code) {
      case "ERROR": {
        const code = body.error?.error_code ?? "ITEM_ERROR";
        await setStatus(REAUTH_CODES.has(code) ? "needs_reauth" : "error", code);
        return { action: "status", done: Promise.resolve() };
      }
      case "PENDING_EXPIRATION":
      case "PENDING_DISCONNECT":
      case "USER_PERMISSION_REVOKED":
      case "USER_ACCOUNT_REVOKED":
        await setStatus("needs_reauth", body.webhook_code);
        return { action: "status", done: Promise.resolve() };
      case "LOGIN_REPAIRED":
        await setStatus("active", null);
        return { action: "sync", done: sync() };
      case "NEW_ACCOUNTS_AVAILABLE":
        // Never added automatically: an owner picks them through Link (Add accounts).
        await h.write((tx) =>
          tx
            .update(org.bankConnections)
            .set({ newAccountsAvailable: true })
            .where(eq(org.bankConnections.id, c.id)),
        );
        return { action: "status", done: Promise.resolve() };
    }
  }
  return none;
}
