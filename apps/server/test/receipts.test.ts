/**
 * Receipt inbox (#89): capture, forward matching on a Plaid sync and a statement import, reverse
 * matching, suggestions and their confirmation by categorizing, rules, pending and removed rows,
 * unmatch, exclude, booking, roles, MCP (image content and base64 creation), HEIC conversion,
 * the dashboard, and an export round trip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { org } from "@cosimo/db";
import { addDays, today } from "@cosimo/shared";
import { and, eq } from "drizzle-orm";
import * as jpeg from "jpeg-js";
import { exportOrg, importOrgArchive } from "../src/services/export.ts";
import { syncConnection } from "../src/services/plaid.ts";
import { type PlaidAccount, setPlaidFactory } from "../src/services/plaid-client.ts";
import { type FakeItem, FakePlaid } from "./fake-plaid.ts";
import {
  addMember,
  type Client,
  createOrg,
  createTestEnv,
  DB_MODE,
  FakeBlobStore,
  login,
  type TestEnv,
} from "./harness.ts";

let env: TestEnv;
let owner: Client;
let viewer: Client;
let bookkeeper: Client;
let orgId: string;
let fake: FakePlaid;
let item: FakeItem;
let restore: () => void;
let store: FakeBlobStore;
let connId: string;
let visa: string;
let meals: string;
let office: string;
let ownerEquity: string;
const base = () => `/api/v1/orgs/${orgId}`;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-receipts-"));

const ACCOUNTS: PlaidAccount[] = [
  { account_id: "acc-visa", name: "Business Visa", mask: "4242", type: "credit", subtype: "credit card" },
];

/** A small valid JPEG, standing in for a phone photo. */
function jpegBytes(size = 8) {
  const data = Buffer.alloc(size * size * 4, 0xee);
  return new Uint8Array(jpeg.encode({ data, width: size, height: size }, 80).data);
}
const HEIC = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/sample.heic")));
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

async function sync() {
  return syncConnection(env.ctx, orgId, connId);
}

/** Add a posted card charge (Plaid amounts are positive for money out) and sync. */
async function charge(id: string, dollars: number, name: string, date = "2026-10-22", pending = false) {
  item.add({ transaction_id: id, account_id: "acc-visa", amount: dollars, name, date, pending });
  return sync();
}

async function txnByProvider(providerId: string) {
  const h = await env.ctx.orgs.mustOpen(orgId);
  const row = await h.db
    .select()
    .from(org.bankTransactions)
    .where(eq(org.bankTransactions.providerTransactionId, providerId))
    .get();
  if (!row) return null;
  return (await owner.json("GET", `${base()}/bank-transactions/${row.id}`)).body;
}

async function createReceipt(
  fields: Record<string, unknown>,
  file?: { bytes: Uint8Array<ArrayBuffer>; name: string },
) {
  if (!file) return owner.json("POST", `${base()}/receipts`, fields);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.set(k, String(v));
  fd.set("file", new File([file.bytes], file.name, { type: "application/octet-stream" }));
  return owner.json("POST", `${base()}/receipts`, fd);
}

const getReceipt = async (id: string) => (await owner.json("GET", `${base()}/receipts/${id}`)).body;

async function links(type: string, id: string) {
  return (await owner.json("GET", `${base()}/attachments?target_type=${type}&target_id=${id}`)).body
    .data as any[];
}

async function auditFor(action: string, targetId: string) {
  const h = await env.ctx.orgs.mustOpen(orgId);
  return h.db
    .select()
    .from(org.auditLog)
    .where(and(eq(org.auditLog.action, action), eq(org.auditLog.targetId, targetId)))
    .all();
}

async function categorize(txnId: string, accountId: string, amount: number) {
  return owner.json("POST", `${base()}/bank-transactions/${txnId}/categorize`, {
    splits: [{ account_id: accountId, amount }],
  });
}

beforeAll(async () => {
  env = await createTestEnv();
  store = new FakeBlobStore();
  env.ctx.services.storage = store;
  fake = new FakePlaid();
  restore = setPlaidFactory((c) => {
    fake.creds.push(c);
    return fake;
  });
  owner = await login(env, "receipts-owner@example.com");
  viewer = await login(env, "receipts-viewer@example.com");
  bookkeeper = await login(env, "receipts-bk@example.com");
  orgId = await createOrg(env, owner, "Receipts Co");
  await addMember(env, orgId, viewer.userId, "viewer");
  await addMember(env, orgId, bookkeeper.userId, "bookkeeper");
  await env.ctx.settings.set("plaid", {
    enabled: true,
    env: "sandbox",
    client_id: "cid-instance",
    secret: "instance-secret-value",
  });
  const n = fake.newItem(ACCOUNTS);
  item = n.item;
  const r = await owner.json("POST", `${base()}/plaid/exchange`, { public_token: n.publicToken });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  connId = r.body.connection.id;
  visa = r.body.connection.accounts[0].id;
  const accts = (await owner.json("GET", `${base()}/accounts`)).body.data as any[];
  meals = accts.find((a) => a.code === "6180").id;
  office = accts.find((a) => a.code === "6090").id;
  ownerEquity = accts.find((a) => a.code === "3100").id;
});

afterAll(async () => {
  restore();
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe(`receipt inbox (${DB_MODE})`, () => {
  let javaReceipt: string;
  let javaTxn: string;

  test("a receipt is captured with its photo and waits in the inbox", async () => {
    const r = await createReceipt(
      {
        merchant: "Professor Java's",
        receipt_date: "2026-10-20",
        receipt_time: "10:49",
        amount: 869,
        pre_tip_amount: 756,
        tax_amount: 56,
        tip_amount: 113,
        bank_account_id: visa,
        account_id: meals,
        business_purpose: "Meeting with David",
        attendees: "David",
        location: "Albany, NY",
      },
      { bytes: jpegBytes(), name: "receipt.jpg" },
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: "inbox",
      amount: 869,
      pre_tip_amount: 756,
      receipt_time: "10:49",
      extraction_source: "manual",
      matched_bank_txn_id: null,
      suggested_bank_txn_id: null,
      stale: false,
    });
    expect(r.body.attachment).toMatchObject({ mime_type: "image/jpeg", filename: "receipt.jpg" });
    javaReceipt = r.body.id;
    expect(await links("receipt", javaReceipt)).toHaveLength(1);
    expect((await auditFor("receipt.create", javaReceipt)).length).toBe(1);

    // A file or an amount is required.
    const empty = await createReceipt({ merchant: "Nothing" });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe("receipt_empty");
  });

  test("the sync auto-matches the charge and the receipt becomes the Categorize suggestion", async () => {
    await charge("pj-1", 8.69, "SQ *PROFESSOR JAVAS");
    const t = await txnByProvider("pj-1");
    javaTxn = t.id;
    expect(t.amount).toBe(-869);
    expect(t.receipt_id).toBe(javaReceipt);
    expect(t.suggested_receipt_ids).toEqual([]);
    expect(t.suggestion).toMatchObject({
      source: "receipt",
      receipt_id: javaReceipt,
      account_id: meals,
      memo: "Professor Java's: Meeting with David",
    });
    const r = await getReceipt(javaReceipt);
    expect(r).toMatchObject({ status: "matched", matched_bank_txn_id: javaTxn, match_method: "auto" });
    expect(r.transaction).toMatchObject({ id: javaTxn, amount: -869 });
    expect(await links("bank_transaction", javaTxn)).toHaveLength(1);
    // Matching during a sync is audited under the system actor.
    const audit = await auditFor("receipt.match", javaReceipt);
    expect(audit.map((x) => x.actor)).toEqual(["system"]);

    const has = await owner.json("GET", `${base()}/bank-transactions?has_receipt=true`);
    expect(has.body.data.map((x: any) => x.id)).toEqual([javaTxn]);
    const hasNot = await owner.json("GET", `${base()}/bank-transactions?has_receipt=false`);
    expect(hasNot.body.data.map((x: any) => x.id)).not.toContain(javaTxn);
  });

  test("categorizing links the receipt's file to the entry; undo keeps the match", async () => {
    const c = await categorize(javaTxn, meals, 869);
    expect(c.status).toBe(200);
    const entryId = c.body.entry.id;
    expect(c.body.entry.memo).toBeTruthy();
    expect(await links("journal_entry", entryId)).toHaveLength(1);
    expect((await getReceipt(javaReceipt)).match_method).toBe("auto");

    const undo = await owner.json("POST", `${base()}/bank-transactions/${javaTxn}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.transaction.receipt_id).toBe(javaReceipt);
    expect((await getReceipt(javaReceipt)).status).toBe("matched");
  });

  test("reverse matching: a receipt for a transaction already categorized", async () => {
    await charge("bh-1", 12.5, "BLUE HERON CAFE", "2026-10-05");
    const t = await txnByProvider("bh-1");
    const c = await categorize(t.id, meals, 1250);
    const entryId = c.body.entry.id;
    const r = await createReceipt(
      { merchant: "Blue Heron Cafe", receipt_date: "2026-10-04", amount: 1250 },
      { bytes: jpegBytes(), name: "heron.jpg" },
    );
    expect(r.body).toMatchObject({ status: "matched", matched_bank_txn_id: t.id, match_method: "auto" });
    expect(await links("bank_transaction", t.id)).toHaveLength(1);
    expect(await links("journal_entry", entryId)).toHaveLength(1);
    // A second receipt can't take the same transaction.
    const twin = await createReceipt({
      merchant: "Blue Heron Cafe",
      receipt_date: "2026-10-04",
      amount: 1250,
    });
    expect(twin.body).toMatchObject({ status: "inbox", suggested_bank_txn_id: null });
    const m = await owner.json("POST", `${base()}/receipts/${twin.body.id}/match`, {
      bank_transaction_id: t.id,
    });
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe("already_matched");
  });

  test("two candidate charges: no auto-match, the closest one is suggested", async () => {
    const r = await createReceipt({ merchant: "Ridge Hardware", receipt_date: "2026-10-10", amount: 2000 });
    item.add({
      transaction_id: "rh-1",
      account_id: "acc-visa",
      amount: 20,
      name: "RIDGE HARDWARE",
      date: "2026-10-11",
    });
    await charge("rh-2", 20, "RIDGE HARDWARE", "2026-10-14");
    const t1 = await txnByProvider("rh-1");
    const t2 = await txnByProvider("rh-2");
    const after = await getReceipt(r.body.id);
    expect(after).toMatchObject({ status: "inbox", suggested_bank_txn_id: t1.id });
    expect(t1.suggested_receipt_ids).toEqual([r.body.id]);
    expect(t1.suggestion).toMatchObject({ source: "receipt", receipt_id: r.body.id });
    expect(t2.suggested_receipt_ids).toEqual([]);
    expect(t2.suggestion?.source).not.toBe("receipt");
    const cands = await owner.json("GET", `${base()}/receipts/${r.body.id}/candidates`);
    expect(cands.body.data.map((x: any) => x.transaction.id)).toEqual([t1.id, t2.id]);
    expect(cands.body.data[0]).toMatchObject({ fit: "exact", merchant_match: true, suggested: true });
  });

  test("two receipts for one charge: both listed, neither matched; categorizing doesn't pick one", async () => {
    const a = await createReceipt({ merchant: "Lantern Books", receipt_date: "2026-10-12", amount: 3000 });
    const b = await createReceipt({ merchant: "Lantern Books", receipt_date: "2026-10-13", amount: 3000 });
    await charge("lb-1", 30, "LANTERN BOOKS", "2026-10-13");
    const t = await txnByProvider("lb-1");
    expect(t.receipt_id).toBeNull();
    expect([...t.suggested_receipt_ids].sort()).toEqual([a.body.id, b.body.id].sort());
    expect(t.suggestion?.source ?? null).not.toBe("receipt");
    await categorize(t.id, office, 3000);
    expect((await getReceipt(a.body.id)).status).toBe("inbox");
    expect((await getReceipt(b.body.id)).status).toBe("inbox");
  });

  test("tip-tolerant: a charge with a bigger tip is suggested, never auto-matched", async () => {
    const r = await createReceipt({
      merchant: "Corner Bistro",
      receipt_date: "2026-10-15",
      amount: 1500,
      pre_tip_amount: 1500,
    });
    await charge("cb-other", 18, "GAS STATION", "2026-10-16");
    await charge("cb-1", 18, "CORNER BISTRO", "2026-10-16");
    const t = await txnByProvider("cb-1");
    const after = await getReceipt(r.body.id);
    expect(after).toMatchObject({ status: "inbox", suggested_bank_txn_id: t.id });
    const cands = (await owner.json("GET", `${base()}/receipts/${r.body.id}/candidates`)).body.data;
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ fit: "tip", merchant_match: true });
    // Over 35% is too much tip.
    await charge("cb-2", 20.26, "CORNER BISTRO", "2026-10-17");
    expect((await owner.json("GET", `${base()}/receipts/${r.body.id}/candidates`)).body.data).toHaveLength(1);
  });

  test("categorizing a transaction with a receipt suggestion confirms the match", async () => {
    const t = await txnByProvider("cb-1");
    const receiptId = t.suggested_receipt_ids[0];
    expect(t.suggestion).toMatchObject({ source: "receipt", receipt_id: receiptId });
    const c = await categorize(t.id, meals, 1800);
    expect(c.status).toBe(200);
    expect(c.body.transaction.receipt_id).toBe(receiptId);
    expect(await getReceipt(receiptId)).toMatchObject({
      status: "matched",
      matched_bank_txn_id: t.id,
      match_method: "confirmed",
    });
    expect((await auditFor("receipt.match", receiptId)).at(-1)!.actor).toBe("user");
  });

  test("a rule keeps its account, takes the receipt's memo, and auto-posts with the receipt attached", async () => {
    const rule = await owner.json("POST", `${base()}/rules`, {
      name: "Green Leaf",
      conditions: { description_contains: "GREEN LEAF" },
      actions: { account_id: office, auto_post: true },
    });
    expect(rule.status).toBe(201);
    const r = await createReceipt(
      {
        merchant: "Green Leaf Market",
        receipt_date: "2026-10-18",
        amount: 4200,
        account_id: meals,
        business_purpose: "Team supplies",
      },
      { bytes: jpegBytes(), name: "leaf.jpg" },
    );
    await charge("gl-1", 42, "GREEN LEAF MARKET", "2026-10-19");
    const t = await txnByProvider("gl-1");
    expect(t.status).toBe("categorized");
    expect(t.rule_id).toBe(rule.body.rule.id);
    expect(t.suggestion).toMatchObject({ source: "rule", account_id: office, receipt_id: r.body.id });
    const e = (await owner.json("GET", `${base()}/entries/${t.entry_id}`)).body;
    expect(e.memo).toBe("Green Leaf Market: Team supplies");
    expect(e.lines.some((l: any) => l.account_id === office)).toBe(true);
    expect(await links("journal_entry", t.entry_id)).toHaveLength(1);
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "matched", match_method: "auto" });
  });

  test("pending rows aren't matched; the posted replacement is", async () => {
    const r = await createReceipt({ merchant: "Harbor Fuel", receipt_date: "2026-10-20", amount: 5500 });
    await charge("hf-pend", 55, "HARBOR FUEL", "2026-10-20", true);
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "inbox", suggested_bank_txn_id: null });
    item.remove("hf-pend");
    await charge("hf-1", 55, "HARBOR FUEL", "2026-10-21");
    expect(await txnByProvider("hf-pend")).toBeNull();
    const t = await txnByProvider("hf-1");
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "matched", matched_bank_txn_id: t.id });
  });

  test("a matched row the bank removes releases its receipt, which matches the replacement", async () => {
    const r = await createReceipt(
      { merchant: "Maple Deli", receipt_date: "2026-10-20", amount: 6100 },
      { bytes: jpegBytes(), name: "deli.jpg" },
    );
    await charge("md-1", 61, "MAPLE DELI", "2026-10-21");
    const t1 = await txnByProvider("md-1");
    expect((await getReceipt(r.body.id)).matched_bank_txn_id).toBe(t1.id);
    item.remove("md-1");
    await charge("md-2", 61, "MAPLE DELI", "2026-10-22");
    expect(await txnByProvider("md-1")).toBeNull();
    const t2 = await txnByProvider("md-2");
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "matched", matched_bank_txn_id: t2.id });
    expect(await links("bank_transaction", t1.id)).toHaveLength(0);
    expect(await links("bank_transaction", t2.id)).toHaveLength(1);

    // Removed with no replacement: back to the inbox.
    item.remove("md-2");
    await sync();
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "inbox", matched_bank_txn_id: null });
    expect(await links("bank_transaction", t2.id)).toHaveLength(0);
  });

  test("unmatch rejects the transaction for good; a manual match can take it back", async () => {
    const r = await createReceipt(
      { merchant: "Pine Diner", receipt_date: "2026-10-20", amount: 7300 },
      { bytes: jpegBytes(), name: "pine.jpg" },
    );
    await charge("pd-1", 73, "PINE DINER", "2026-10-21");
    const t = await txnByProvider("pd-1");
    expect((await getReceipt(r.body.id)).status).toBe("matched");
    const u = await owner.json("POST", `${base()}/receipts/${r.body.id}/unmatch`);
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ status: "inbox", rejected_txn_ids: [t.id], suggested_bank_txn_id: null });
    expect(await links("bank_transaction", t.id)).toHaveLength(0);
    const tAfter = await txnByProvider("pd-1");
    expect(tAfter.receipt_id).toBeNull();
    expect(tAfter.suggestion?.source ?? null).not.toBe("receipt");

    // A later sync doesn't bring the match back.
    item.modify({
      transaction_id: "pd-1",
      account_id: "acc-visa",
      amount: 73,
      date: "2026-10-21",
      name: "PINE DINER",
      pending: false,
    });
    await sync();
    expect((await getReceipt(r.body.id)).status).toBe("inbox");

    const m = await owner.json("POST", `${base()}/receipts/${r.body.id}/match`, {
      bank_transaction_id: t.id,
    });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ status: "matched", match_method: "manual", rejected_txn_ids: [] });
    expect(await links("bank_transaction", t.id)).toHaveLength(1);
  });

  test("excluding a transaction releases its receipt", async () => {
    const r = await createReceipt(
      { merchant: "Cedar Books", receipt_date: "2026-10-20", amount: 8100 },
      { bytes: jpegBytes(), name: "cedar.jpg" },
    );
    await charge("cd-1", 81, "CEDAR BOOKS", "2026-10-21");
    const t = await txnByProvider("cd-1");
    expect((await getReceipt(r.body.id)).status).toBe("matched");
    const x = await owner.json("POST", `${base()}/bank-transactions/${t.id}/exclude`);
    expect(x.status).toBe(200);
    expect(x.body.transaction.receipt_id).toBeNull();
    expect(await getReceipt(r.body.id)).toMatchObject({ status: "inbox", suggested_bank_txn_id: null });
    expect(await links("bank_transaction", t.id)).toHaveLength(0);
    expect((await owner.json("GET", `${base()}/receipts/${r.body.id}/candidates`)).body.data).toEqual([]);
  });

  test("a statement import matches too", async () => {
    const cash = await owner.json("POST", `${base()}/bank-accounts`, { name: "Checking", kind: "checking" });
    const r = await createReceipt({ merchant: "Oak Street Bakery", receipt_date: "2026-10-20", amount: 945 });
    const imp = await owner.json("POST", `${base()}/bank-accounts/${cash.body.id}/import`, {
      filename: "oct.csv",
      content: "Date,Description,Amount\n2026-10-21,OAK STREET BAKERY,-9.45\n",
    });
    expect(imp.status).toBe(200);
    const after = await getReceipt(r.body.id);
    expect(after.status).toBe("matched");
    expect(after.transaction.bank_account_id).toBe(cash.body.id);
  });

  test("book as a draft bill or as an entry", async () => {
    const vendor = await owner.json("POST", `${base()}/contacts`, { kind: "vendor", name: "Farmers Market" });
    const r = await createReceipt(
      {
        merchant: "Farmers Market",
        receipt_date: "2026-09-01",
        amount: 2500,
        account_id: meals,
        contact_id: vendor.body.id,
      },
      { bytes: jpegBytes(), name: "market.jpg" },
    );
    const bill = await owner.json("POST", `${base()}/receipts/${r.body.id}/book`, { as: "bill" });
    expect(bill.status).toBe(200);
    expect(bill.body.receipt).toMatchObject({ status: "booked", booked_target_type: "bill" });
    const b = (await owner.json("GET", `${base()}/bills/${bill.body.target.id}`)).body;
    expect(b).toMatchObject({
      status: "draft",
      total: 2500,
      vendor_id: vendor.body.id,
      issue_date: "2026-09-01",
    });
    expect(await links("bill", b.id)).toHaveLength(1);
    expect((await auditFor("receipt.book", r.body.id)).length).toBe(1);
    expect((await owner.json("POST", `${base()}/receipts/${r.body.id}/book`, { as: "bill" })).status).toBe(
      409,
    );

    const noAccount = await createReceipt({
      merchant: "Cash Taxi",
      receipt_date: "2026-09-02",
      amount: 1800,
    });
    const bad = await owner.json("POST", `${base()}/receipts/${noAccount.body.id}/book`, {
      as: "entry",
      credit_account_id: ownerEquity,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("missing_account");
    const noVendor = await owner.json("POST", `${base()}/receipts/${noAccount.body.id}/book`, { as: "bill" });
    expect(noVendor.status).toBe(422);

    await owner.json("PATCH", `${base()}/receipts/${noAccount.body.id}`, { account_id: office });
    const entry = await owner.json("POST", `${base()}/receipts/${noAccount.body.id}/book`, {
      as: "entry",
      credit_account_id: ownerEquity,
    });
    expect(entry.status).toBe(200);
    expect(entry.body.target.type).toBe("journal_entry");
    expect(entry.body.entry.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: office, amount: 1800 }),
        expect.objectContaining({ account_id: ownerEquity, amount: -1800 }),
      ]),
    );
  });

  test("dismiss and restore", async () => {
    const r = await createReceipt({ merchant: "Personal Shop", receipt_date: "2026-10-01", amount: 999 });
    const d = await owner.json("POST", `${base()}/receipts/${r.body.id}/dismiss`, { reason: "Personal" });
    expect(d.body).toMatchObject({ status: "dismissed", dismissed_reason: "Personal" });
    const inbox = await owner.json("GET", `${base()}/receipts?status=inbox`);
    expect(inbox.body.data.map((x: any) => x.id)).not.toContain(r.body.id);
    const back = await owner.json("POST", `${base()}/receipts/${r.body.id}/restore`);
    expect(back.body).toMatchObject({ status: "inbox", dismissed_reason: null });
    expect((await auditFor("receipt.dismiss", r.body.id)).length).toBe(1);
    expect((await auditFor("receipt.restore", r.body.id)).length).toBe(1);
  });

  test("roles: viewers read, bookkeepers write", async () => {
    expect((await viewer.json("GET", `${base()}/receipts`)).status).toBe(200);
    expect((await viewer.json("POST", `${base()}/receipts`, { amount: 100 })).status).toBe(403);
    const mine = await bookkeeper.json("POST", `${base()}/receipts`, { amount: 100, merchant: "Stamp Shop" });
    expect(mine.status).toBe(201);
    expect((await viewer.json("PATCH", `${base()}/receipts/${mine.body.id}`, { memo: "x" })).status).toBe(
      403,
    );
    expect((await viewer.json("POST", `${base()}/receipts/${mine.body.id}/dismiss`, {})).status).toBe(403);
  });

  test("HEIC uploads are stored as JPEG, for receipts and other attachments", async () => {
    const r = await createReceipt(
      { amount: 1111, merchant: "Phone Photo" },
      { bytes: HEIC, name: "IMG_0001.HEIC" },
    );
    expect(r.status).toBe(201);
    expect(r.body.attachment).toMatchObject({ mime_type: "image/jpeg", filename: "IMG_0001.jpg" });
    const dl = await owner.req("GET", r.body.attachment.download_url);
    expect([...new Uint8Array(await dl.arrayBuffer()).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const fd = new FormData();
    fd.set("file", new File([HEIC], "photo.heic", { type: "image/heic" }));
    const att = await owner.json("POST", `${base()}/attachments`, fd);
    expect(att.status).toBe(201);
    expect(att.body).toMatchObject({ mime_type: "image/jpeg", filename: "photo.jpg" });

    const broken = new Uint8Array(HEIC.slice(0, 4096));
    const fd2 = new FormData();
    fd2.set("file", new File([broken], "broken.heic"));
    const bad = await owner.json("POST", `${base()}/receipts`, fd2);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("heic_unsupported");
  });

  test("an iOS Shortcut posts just the photo with a propose-only token (docs/receipts.md)", async () => {
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "iPhone Shortcut",
      role: "bookkeeper",
      propose_only: true,
    });
    const fd = new FormData();
    fd.set("file", new File([HEIC], "IMG_0042.HEIC", { type: "application/octet-stream" }));
    const res = await env.app.request(`${base()}/receipts`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.body.token}` },
      body: fd,
    });
    expect(res.status).toBe(201);
    const r = (await res.json()) as any;
    expect(r).toMatchObject({ status: "inbox", amount: null });
    expect(r.attachment).toMatchObject({ mime_type: "image/jpeg", filename: "IMG_0042.jpg" });
  });

  test("replacing the file moves every link to the new one", async () => {
    const before = await getReceipt(javaReceipt);
    const oldId = before.attachment.id;
    const fd = new FormData();
    fd.set("file", new File([jpegBytes(16)], "better.jpg"));
    const r = await owner.json("PUT", `${base()}/receipts/${javaReceipt}/file`, fd);
    expect(r.status).toBe(200);
    expect(r.body.attachment.id).not.toBe(oldId);
    const ids = (await links("bank_transaction", javaTxn)).map((a) => a.id);
    expect(ids).toEqual([r.body.attachment.id]);
    expect((await links("receipt", javaReceipt)).map((a) => a.id)).toEqual([r.body.attachment.id]);
  });

  test("the dashboard counts receipts left in the inbox over 30 days", async () => {
    const r = await createReceipt({ merchant: "Old Receipt", receipt_date: "2026-01-01", amount: 123 });
    const h = await env.ctx.orgs.mustOpen(orgId);
    await h.write((tx) =>
      tx
        .update(org.receipts)
        .set({ createdAt: `${addDays(today(), -40)}T12:00:00.000Z` })
        .where(eq(org.receipts.id, r.body.id)),
    );
    const d = await owner.json("GET", `${base()}/dashboard`);
    expect(d.body.stale_receipts).toEqual({ count: 1 });
    expect((await getReceipt(r.body.id)).stale).toBe(true);
  });
});

describe(`receipts over MCP (${DB_MODE})`, () => {
  let token: string;

  async function call(name: string, args: Record<string, unknown>) {
    const res = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).result as {
      isError: boolean;
      structuredContent?: any;
      content: any[];
    };
  }

  beforeAll(async () => {
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "assistant",
      role: "bookkeeper",
      propose_only: true,
    });
    token = t.body.token;
  });

  test("create_receipt from fields and base64 (HEIC converted), with attach_url", async () => {
    const r = await call("create_receipt", {
      merchant: "Northside Grill",
      date: "2026-10-20",
      amount: 2350,
      account: "6180",
      file_base64: Buffer.from(HEIC).toString("base64"),
      filename: "IMG_0002.HEIC",
    });
    expect(r.isError).toBe(false);
    const rec = r.structuredContent.receipt;
    expect(rec).toMatchObject({ extraction_source: "assistant", account_id: meals, amount: 2350 });
    expect(rec.attachment).toMatchObject({ mime_type: "image/jpeg", filename: "IMG_0002.jpg" });
    expect(r.structuredContent.attach_url).toBe(
      `${env.config.server.public_url.replace(/\/$/, "")}/o/${orgId}/expenses/receipts/${rec.id}`,
    );
    expect((await auditFor("receipt.create", rec.id))[0]!.actor).toBe("mcp");

    // get_receipt sends the image after the JSON.
    const g = await call("get_receipt", { receipt_id: rec.id });
    expect(g.isError).toBe(false);
    expect(g.content[0].type).toBe("text");
    expect(g.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const img = Buffer.from(g.content[1].data, "base64");
    expect([...img.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const dims = jpeg.decode(img);
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(1568);
    expect(g.structuredContent.attach_url).toContain(`/expenses/receipts/${rec.id}`);

    // Fields only: no file, and the result says where to add the photo.
    const f = await call("create_receipt", { merchant: "Food Truck", amount: 1200 });
    expect(f.structuredContent.receipt.attachment).toBeNull();
    expect(f.structuredContent.message).toContain("attach_url");
    const nf = await call("get_receipt", { receipt_id: f.structuredContent.receipt.id });
    expect(nf.content).toHaveLength(1);
    expect(nf.structuredContent.image_note).toContain("attach_url");
  });

  test("large images are downscaled; a PDF comes back as an embedded resource", async () => {
    const big = new Uint8Array(
      jpeg.encode({ data: Buffer.alloc(2000 * 1000 * 4, 0x80), width: 2000, height: 1000 }, 70).data,
    );
    const r = await createReceipt({ amount: 4321, merchant: "Wide Scan" }, { bytes: big, name: "wide.jpg" });
    const g = await call("get_receipt", { receipt_id: r.body.id });
    const dims = jpeg.decode(Buffer.from(g.content[1].data, "base64"));
    expect([dims.width, dims.height]).toEqual([1568, 784]);

    const p = await call("create_receipt", {
      amount: 5000,
      merchant: "Invoice Co",
      file_base64: Buffer.from(PDF).toString("base64"),
      filename: "invoice.pdf",
    });
    const pg = await call("get_receipt", { receipt_id: p.structuredContent.receipt.id });
    expect(pg.content[1]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf" } });
    expect(Buffer.from(pg.content[1].resource.blob, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("list, update, match, unmatch and dismiss apply directly", async () => {
    const list = await call("list_receipts", {});
    expect(list.structuredContent.data.every((x: any) => x.status === "inbox")).toBe(true);
    const target = list.structuredContent.data.find((x: any) => x.merchant === "Food Truck");
    const u = await call("update_receipt", {
      receipt_id: target.id,
      business_purpose: "Client lunch",
      amount: 1250,
    });
    expect(u.structuredContent.receipt).toMatchObject({ business_purpose: "Client lunch", amount: 1250 });
    const pd = await txnByProvider("pd-1");
    const unmatchFirst = await call("match_receipt", { receipt_id: target.id, transaction_id: pd.id });
    expect(unmatchFirst.isError).toBe(true);
    expect(unmatchFirst.content[0].text).toContain("already_matched");

    // A charge outside the receipt's window (it is dated today), matched by hand.
    await charge("ft-1", 12.5, "FOOD TRUCK", addDays(today(), 20));
    const ft = await txnByProvider("ft-1");
    expect((await getReceipt(target.id)).status).toBe("inbox");
    const m = await call("match_receipt", { receipt_id: target.id, transaction_id: ft.id });
    expect(m.isError).toBe(false);
    expect(m.structuredContent.receipt.status).toBe("matched");
    const un = await call("unmatch_receipt", { receipt_id: target.id });
    expect(un.structuredContent.receipt).toMatchObject({ status: "inbox", rejected_txn_ids: [ft.id] });
    const d = await call("dismiss_receipt", { receipt_id: target.id, reason: "Duplicate" });
    expect(d.structuredContent.receipt.status).toBe("dismissed");
    // Nothing went to the review queue.
    const pending = await owner.json("GET", `${base()}/review?status=pending`);
    expect(JSON.stringify(pending.body)).not.toContain(target.id);
  });

  test("a read-only connection can't write receipts", async () => {
    const t = await viewer.json("POST", "/api/v1/tokens", { org_id: orgId, name: "ro", role: "viewer" });
    const saved = token;
    token = t.body.token;
    const r = await call("create_receipt", { amount: 100 });
    expect(r.isError).toBe(true);
    expect((await call("list_receipts", {})).isError).toBe(false);
    token = saved;
  });
});

describe(`receipts in an export (${DB_MODE})`, () => {
  test("export and import keep receipts and their files", async () => {
    const before = (
      await owner.json("GET", `${base()}/receipts?status=inbox,matched,booked,dismissed&limit=500`)
    ).body.data as any[];
    const zip = join(tmp, "receipts.zip");
    const manifest = await exportOrg(env.ctx, orgId, zip);
    expect(manifest.tables.receipts!.rows).toBe(before.length);
    await env.ctx.orgs.destroy(orgId);
    const res = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), { userId: owner.userId });
    expect(res.chains_ok).toBe(true);
    const after = (
      await owner.json("GET", `${base()}/receipts?status=inbox,matched,booked,dismissed&limit=500`)
    ).body.data as any[];
    expect(after.map((r) => [r.id, r.status, r.matched_bank_txn_id])).toEqual(
      before.map((r) => [r.id, r.status, r.matched_bank_txn_id]),
    );
    const java = after.find((r) => r.merchant === "Professor Java's");
    const dl = await owner.req("GET", java.attachment.download_url);
    expect(dl.status).toBe(200);
  });
});
