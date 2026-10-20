/** A scripted fake of the Plaid API, for the Plaid and receipt-matching tests. */
import {
  type Jwk,
  type LinkTokenRequest,
  type PlaidAccount,
  type PlaidApi,
  type PlaidCredentials,
  PlaidError,
  type PlaidTransaction,
  type SyncPage,
} from "../src/services/plaid-client.ts";

export type Event = { kind: "added" | "modified"; t: PlaidTransaction } | { kind: "removed"; id: string };

export class FakeItem {
  events: Event[] = [];
  constructor(
    readonly itemId: string,
    readonly accessToken: string,
    readonly accounts: PlaidAccount[],
  ) {}
  add(t: Partial<PlaidTransaction> & { transaction_id: string; account_id: string; amount: number }) {
    this.events.push({
      kind: "added",
      t: { date: "2026-03-02", name: t.transaction_id.toUpperCase(), pending: false, ...t },
    });
  }
  modify(t: PlaidTransaction) {
    this.events.push({ kind: "modified", t });
  }
  remove(id: string) {
    this.events.push({ kind: "removed", id });
  }
}

export class FakePlaid implements PlaidApi {
  items = new Map<string, FakeItem>();
  byPublic = new Map<string, FakeItem>();
  linkRequests: LinkTokenRequest[] = [];
  removed: string[] = [];
  creds: PlaidCredentials[] = [];
  pageSize = 2;
  failSync: PlaidError | null = null;
  mutateOnce = false;
  keys = new Map<string, Jwk>();
  syncCalls = 0;
  refreshCalls = 0;
  failRefresh: PlaidError | null = null;
  /** While set, syncs wait on it: a sync that is still running. */
  gate: Promise<void> | null = null;

  newItem(accounts: PlaidAccount[]) {
    const n = this.items.size + 1;
    const item = new FakeItem(`item-${n}`, `access-sandbox-secret-${n}-${crypto.randomUUID()}`, accounts);
    this.items.set(item.accessToken, item);
    this.byPublic.set(`public-${n}`, item);
    return { item, publicToken: `public-${n}` };
  }
  private item(token: string) {
    const i = this.items.get(token);
    if (!i) throw new PlaidError("INVALID_ACCESS_TOKEN", "INVALID_INPUT", "bad token", 400);
    return i;
  }
  async linkTokenCreate(r: LinkTokenRequest) {
    this.linkRequests.push(r);
    return { link_token: `link-sandbox-${this.linkRequests.length}`, expiration: "2026-12-31T00:00:00Z" };
  }
  async exchangePublicToken(p: string) {
    const i = this.byPublic.get(p);
    if (!i) throw new PlaidError("INVALID_PUBLIC_TOKEN", "INVALID_INPUT", "bad public token", 400);
    return { access_token: i.accessToken, item_id: i.itemId };
  }
  async accountsGet(token: string) {
    return { accounts: this.item(token).accounts, institution_id: "ins_109508" };
  }
  async institutionName() {
    return "First Platypus Bank";
  }
  async transactionsSync(token: string, cursor: string | null): Promise<SyncPage> {
    const item = this.item(token);
    this.syncCalls++;
    if (this.gate) await this.gate;
    if (this.failSync) throw this.failSync;
    const start = cursor ? Number(cursor) : 0;
    if (this.mutateOnce && start > 0) {
      this.mutateOnce = false;
      throw new PlaidError(
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "TRANSACTIONS_ERROR",
        "mutated",
        400,
      );
    }
    const slice = item.events.slice(start, start + this.pageSize);
    const end = start + slice.length;
    return {
      added: slice.flatMap((e) => (e.kind === "added" ? [e.t] : [])),
      modified: slice.flatMap((e) => (e.kind === "modified" ? [e.t] : [])),
      removed: slice.flatMap((e) => (e.kind === "removed" ? [{ transaction_id: e.id }] : [])),
      next_cursor: String(end),
      has_more: end < item.events.length,
    };
  }
  async transactionsRefresh(token: string) {
    this.item(token);
    this.refreshCalls++;
    if (this.failRefresh) throw this.failRefresh;
  }
  async itemRemove(token: string) {
    this.removed.push(this.item(token).itemId);
  }
  async itemWebhookUpdate() {}
  async webhookVerificationKey(kid: string) {
    const k = this.keys.get(kid);
    if (!k) throw new PlaidError("INVALID_INPUT", "INVALID_INPUT", "unknown key", 400);
    return k;
  }
  /** Answer key checks the way Plaid does for a secret from the wrong environment. */
  rejectKeys = false;
  keyChecks: PlaidCredentials[] = [];
  async checkCredentials() {
    this.keyChecks.push(this.creds.at(-1)!);
    if (this.rejectKeys)
      throw new PlaidError("INVALID_API_KEYS", "INVALID_INPUT", "invalid client_id or secret provided", 400);
  }
  async sandboxPublicToken() {
    return "";
  }
  async sandboxResetLogin() {}
}
