import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId, org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import type { ActorInfo } from "../src/services/actor.ts";
import { categorizeTx } from "../src/services/banking.ts";
import { submitEntryTx } from "../src/services/ledger.ts";
import { completeReconTx, resolveFlagTx } from "../src/services/reconcile.ts";
import { approveReviewTx, expireOldTx, rejectReviewTx } from "../src/services/review.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;
let orgId: string;
let acct: Record<string, string>;
let checking: { id: string; ledger_account_id: string };
let savings: { id: string; ledger_account_id: string };
let card: { id: string; ledger_account_id: string };
const base = () => `/api/v1/orgs/${orgId}`;

const CHECKING_CSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,01/05/2026,"ADOBE *CREATIVE CLOUD 408-536-6000 CA",-54.99,ACH_DEBIT,1000.00,
CREDIT,01/07/2026,"CLIENT PAYMENT ACME CORP",2400.00,ACH_CREDIT,3445.01,
DEBIT,01/09/2026,"ONLINE TRANSFER TO SAV XXXX5678",-500.00,ACCT_XFER,2945.01,
DEBIT,01/12/2026,"STARBUCKS STORE 12345",-6.75,DEBIT_CARD,2938.26,
DEBIT,01/12/2026,"STARBUCKS STORE 12345",-6.75,DEBIT_CARD,2931.51,
DEBIT,01/20/2026,"ADOBE *CREATIVE CLOUD 408-536-6000 CA",-54.99,ACH_DEBIT,2876.52,
`;

const SAVINGS_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260131<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>123456789<ACCTID>5678<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260110120000<TRNAMT>500.00<FITID>SAV-0001<NAME>TRANSFER FROM CHK XXXX1234</STMTTRN>
<STMTTRN><TRNTYPE>INT<DTPOSTED>20260131<TRNAMT>1.23<FITID>SAV-0002<NAME>INTEREST PAID</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1501.23<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;

async function txns(c: Client, bankId: string, status?: string) {
  const r = await c.json(
    "GET",
    `${base()}/bank-transactions?bank_account_id=${bankId}${status ? `&status=${status}` : ""}`,
  );
  return r.body.data as any[];
}

async function importFile(c: Client, bankId: string, filename: string, content: string) {
  return c.json("POST", `${base()}/bank-accounts/${bankId}/import`, { filename, content });
}

async function tb() {
  return (await owner.json("GET", `${base()}/reports/trial_balance?as_of=2026-12-31`)).body;
}

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "bank-owner@example.com");
  orgId = await createOrg(env, owner, "Bank Co");
  const r = await owner.json("GET", `${base()}/accounts`);
  acct = Object.fromEntries(r.body.data.map((a: any) => [a.code, a.id]));
  checking = (
    await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Checking",
      kind: "checking",
      ledger_account_id: acct["1000"],
    })
  ).body;
  savings = (
    await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Savings",
      kind: "savings",
      ledger_account_id: acct["1010"],
    })
  ).body;
  card = (
    await owner.json("POST", `${base()}/bank-accounts`, { name: "Amex", kind: "credit_card", mask: "1001" })
  ).body;
});
afterAll(async () => {
  await env.close();
});

describe(`bank accounts and import (${DB_MODE})`, () => {
  test("bank accounts link or create ledger accounts of the right type", async () => {
    expect(checking.ledger_account_id).toBe(acct["1000"]!);
    const accts = (await owner.json("GET", `${base()}/accounts`)).body.data;
    const cardLedger = accts.find((a: any) => a.id === card.ledger_account_id);
    expect(cardLedger.type).toBe("liability");
    expect(cardLedger.subtype).toBe("credit_card");
    const dup = await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Again",
      kind: "checking",
      ledger_account_id: acct["1000"],
    });
    expect(dup.status).toBe(409);
    const wrong = await owner.json("POST", `${base()}/bank-accounts`, {
      name: "X",
      kind: "credit_card",
      ledger_account_id: acct["6000"] ?? acct["1000"],
    });
    expect(wrong.status).toBeGreaterThanOrEqual(409);
  });

  test("CSV preview guesses the mapping and counts rows without saving", async () => {
    const p = await owner.json("POST", `${base()}/bank-accounts/${checking.id}/import/preview`, {
      filename: "chase.csv",
      content: CHECKING_CSV,
    });
    expect(p.status).toBe(200);
    expect(p.body.format).toBe("csv");
    expect(p.body.profile_source).toBe("guessed");
    expect(p.body.summary).toEqual({ rows: 6, new: 6, duplicates: 0, errors: 0 });
    expect(p.body.sample[0].amount).toBe(-5499);
    expect(await txns(owner, checking.id)).toHaveLength(0);
  });

  test("CSV import is idempotent, keeps same-day identical rows, and saves the profile", async () => {
    const r1 = await importFile(owner, checking.id, "chase.csv", CHECKING_CSV);
    expect(r1.status).toBe(200);
    expect(r1.body.imported).toBe(6);
    const r2 = await importFile(owner, checking.id, "chase-again.csv", CHECKING_CSV);
    expect(r2.body.imported).toBe(0);
    expect(r2.body.duplicates).toBe(6);
    expect(r2.body.batch_id).toBeNull();
    expect(await txns(owner, checking.id)).toHaveLength(6);
    const p = await owner.json("POST", `${base()}/bank-accounts/${checking.id}/import/preview`, {
      filename: "x.csv",
      content: CHECKING_CSV,
    });
    expect(p.body.profile_source).toBe("saved");
    const hist = await owner.json("GET", `${base()}/bank-accounts/${checking.id}/imports`);
    expect(hist.body.data).toHaveLength(1);
  });

  test("OFX import is idempotent by FITID", async () => {
    const r1 = await importFile(owner, savings.id, "savings.ofx", SAVINGS_OFX);
    expect(r1.body.format).toBe("ofx");
    expect(r1.body.imported).toBe(2);
    const r2 = await importFile(
      owner,
      savings.id,
      "savings.qfx",
      SAVINGS_OFX.replace("INTEREST PAID", "INTEREST PAID (renamed)"),
    );
    expect(r2.body.imported).toBe(0);
  });

  test("bad rows are reported, not fatal", async () => {
    const bad = `Date,Description,Amount\n2026-02-01,Good row,-10.00\n2026-02-30,Bad date,-5.00\n2026-02-02,Bad amount,abc\n`;
    const r = await owner.json("POST", `${base()}/bank-accounts/${card.id}/import`, {
      filename: "bad.csv",
      content: bad,
      profile: {
        hasHeader: true,
        skipRows: 0,
        dateFormat: "YYYY-MM-DD",
        amountMode: "signed",
        signConvention: "positive_is_deposit",
        columns: { date: 0, description: 1, amount: 2 },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.errors).toBe(2);
    expect(r.body.error_rows.map((e: any) => e.row)).toEqual([3, 4]);
  });
});

describe(`bank review (${DB_MODE})`, () => {
  const find = async (bankId: string, text: string, status = "new") =>
    (await txns(owner, bankId, status)).find((t) => t.description.includes(text));

  test("categorize posts one entry against the bank account", async () => {
    const t = await find(checking.id, "CLIENT PAYMENT");
    const r = await owner.json("POST", `${base()}/bank-transactions/${t.id}/categorize`, {
      splits: [{ account_id: acct["4000"], amount: 240000 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("posted");
    expect(r.body.transaction.status).toBe("categorized");
    expect(r.body.entry.source_type).toBe("bank_transaction");
    const bank = r.body.entry.lines.find((l: any) => l.account_id === acct["1000"]);
    expect(bank.amount).toBe(240000);
  });

  test("split must add up to the transaction; splits create multiple lines", async () => {
    const t = await find(checking.id, "STARBUCKS");
    const bad = await owner.json("POST", `${base()}/bank-transactions/${t.id}/categorize`, {
      splits: [{ account_id: acct["6000"] ?? Object.values(acct)[0], amount: 600 }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("split_mismatch");
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.filter(
      (a: any) => a.type === "expense",
    );
    const ok = await owner.json("POST", `${base()}/bank-transactions/${t.id}/categorize`, {
      splits: [
        { account_id: expense[0].id, amount: 400 },
        { account_id: expense[1].id, amount: 275 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.entry.lines).toHaveLength(3);
  });

  test("history suggestion: the second identical charge suggests the same account", async () => {
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.type === "expense",
    );
    const first = (await txns(owner, checking.id, "new"))
      .filter((t) => t.description.includes("ADOBE"))
      .sort((a, b) => a.date.localeCompare(b.date));
    await owner.json("POST", `${base()}/bank-transactions/${first[0].id}/categorize`, {
      splits: [{ account_id: expense.id, amount: 5499 }],
    });
    // Re-run suggestions by importing a later Adobe charge.
    const csv = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,02/05/2026,"ADOBE *CREATIVE CLOUD 408-536-6000 CA",-54.99,ACH_DEBIT,1.00,\n`;
    const r = await importFile(owner, checking.id, "feb.csv", csv);
    expect(r.body.suggested).toBe(1);
    const feb = (await txns(owner, checking.id, "new")).find((t) => t.date === "2026-02-05");
    expect(feb.suggestion).toMatchObject({ source: "history", account_id: expense.id });
  });

  test("transfer pairs both imported sides into one entry with no income or expense", async () => {
    const out = await find(checking.id, "ONLINE TRANSFER");
    const incoming = await find(savings.id, "TRANSFER FROM CHK");
    const before = await owner.json("GET", `${base()}/reports/profit_and_loss?from=2026-01-01&to=2026-12-31`);
    const r = await owner.json("POST", `${base()}/bank-transactions/${out.id}/transfer`, {
      account_id: savings.ledger_account_id,
    });
    expect(r.status).toBe(200);
    expect(r.body.counterpart_id).toBe(incoming.id);
    expect(r.body.entry.lines).toHaveLength(2);
    const other = (await owner.json("GET", `${base()}/bank-transactions/${incoming.id}`)).body;
    expect(other.status).toBe("categorized");
    expect(other.entry_id).toBe(r.body.entry.id);
    const after = await owner.json("GET", `${base()}/reports/profit_and_loss?from=2026-01-01&to=2026-12-31`);
    expect(after.body.lines).toEqual(before.body.lines);
  });

  test("a transfer recorded first is paired automatically when the other side is imported", async () => {
    const csv = `Date,Description,Amount\n2026-03-01,PAYMENT TO AMEX,-300.00\n`;
    const prof = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: "YYYY-MM-DD",
      amountMode: "signed",
      signConvention: "positive_is_deposit",
      columns: { date: 0, description: 1, amount: 2 },
    };
    await owner.json("POST", `${base()}/bank-accounts/${checking.id}/import`, {
      filename: "mar.csv",
      content: csv,
      profile: prof,
      save_profile: false,
    });
    const pay = await find(checking.id, "PAYMENT TO AMEX");
    const r = await owner.json("POST", `${base()}/bank-transactions/${pay.id}/transfer`, {
      account_id: card.ledger_account_id,
    });
    expect(r.body.counterpart_id).toBeNull();
    const cardCsv = `Date,Description,Amount\n2026-03-02,PAYMENT RECEIVED THANK YOU,300.00\n`;
    const imp = await owner.json("POST", `${base()}/bank-accounts/${card.id}/import`, {
      filename: "amex.csv",
      content: cardCsv,
      profile: prof,
    });
    expect(imp.body.transfers_paired).toBe(1);
    const paid = (await txns(owner, card.id)).find((t) => t.description.includes("PAYMENT RECEIVED"));
    expect(paid.status).toBe("categorized");
    expect(paid.entry_id).toBe(r.body.entry.id);
  });

  test("match links to an existing entry; exclude and restore; undo reverses", async () => {
    const interest = await find(savings.id, "INTEREST");
    const incomeAcct = acct["4000"]!;
    const manual = await owner.json("POST", `${base()}/entries`, {
      date: "2026-01-31",
      memo: "Interest",
      lines: [
        { account_id: savings.ledger_account_id, amount: 123 },
        { account_id: incomeAcct, amount: -123 },
      ],
    });
    const cands = await owner.json("GET", `${base()}/bank-transactions/${interest.id}/match-candidates`);
    expect(cands.body.data.map((x: any) => x.id)).toContain(manual.body.entry.id);
    const m = await owner.json("POST", `${base()}/bank-transactions/${interest.id}/match`, {
      entry_id: manual.body.entry.id,
    });
    expect(m.body.transaction.status).toBe("matched");
    const u = await owner.json("POST", `${base()}/bank-transactions/${interest.id}/undo`, {});
    expect(u.body.transaction.status).toBe("new");
    // matching never reverses someone else's entry
    expect(
      (await owner.json("GET", `${base()}/entries/${manual.body.entry.id}`)).body.reversed_by_entry_id,
    ).toBeNull();

    const x = await owner.json("POST", `${base()}/bank-transactions/${interest.id}/exclude`);
    expect(x.body.transaction.status).toBe("excluded");
    expect(
      (await owner.json("POST", `${base()}/bank-transactions/${interest.id}/restore`)).body.transaction
        .status,
    ).toBe("new");

    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.type === "income",
    );
    const cat = await owner.json("POST", `${base()}/bank-transactions/${interest.id}/categorize`, {
      splits: [{ account_id: expense.id, amount: 123 }],
    });
    const entryId = cat.body.entry.id;
    const undo = await owner.json("POST", `${base()}/bank-transactions/${interest.id}/undo`, {});
    expect(undo.body.transaction.status).toBe("new");
    expect((await owner.json("GET", `${base()}/entries/${entryId}`)).body.reversed_by_entry_id).toBeTruthy();
    expect((await owner.json("POST", `${base()}/verify`)).body.ok).toBe(true);
  });

  test("pending bank transactions cannot be categorized", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const id = newId();
    await h.write((tx) =>
      tx.insert(org.bankTransactions).values({
        id,
        bankAccountId: checking.id,
        date: "2026-03-05",
        amount: -1000,
        description: "PENDING THING",
        normalizedDescription: "PENDING THING",
        isPending: true,
        dedupeHash: `pending-${id}`,
      }),
    );
    const r = await owner.json("POST", `${base()}/bank-transactions/${id}/categorize`, {
      splits: [{ account_id: acct["4000"], amount: 1000 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("pending_transaction");
  });

  test("buckets: to categorize leaves out pending rows and rows waiting in the review queue", async () => {
    const bucketAcct = (
      await owner.json("POST", `${base()}/bank-accounts`, { name: "Bucket Test", kind: "checking" })
    ).body;
    const csv =
      "Date,Description,Amount\n" +
      "2026-05-01,COFFEE SHOP,-4.50\n" +
      "2026-05-02,EQUIPMENT PURCHASE,-5000.00\n" +
      "2026-05-03,GROCERY STORE,-32.10\n" +
      "2026-05-04,SUBSCRIPTION FEE,-9.99\n";
    await importFile(owner, bucketAcct.id, "bucket.csv", csv);
    const rows = await txns(owner, bucketAcct.id);
    const coffee = rows.find((t) => t.description.includes("COFFEE"))!;
    const big = rows.find((t) => t.description.includes("EQUIPMENT PURCHASE"))!;
    const grocery = rows.find((t) => t.description.includes("GROCERY"))!;
    const sub = rows.find((t) => t.description.includes("SUBSCRIPTION"))!;
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.type === "expense",
    );

    // Over the review threshold: it waits in the review queue, so its bucket is "categorized",
    // not "to categorize" -- otherwise it would be counted twice (here and in "waiting for
    // approval").
    const bigR = await owner.json("POST", `${base()}/bank-transactions/${big.id}/categorize`, {
      splits: [{ account_id: expense.id, amount: 500000 }],
    });
    expect(bigR.body.entry.status).toBe("pending_review");
    await owner.json("POST", `${base()}/bank-transactions/${grocery.id}/categorize`, {
      splits: [{ account_id: expense.id, amount: 3210 }],
    });
    await owner.json("POST", `${base()}/bank-transactions/${sub.id}/exclude`);

    const h = await env.ctx.orgs.mustOpen(orgId);
    const pendingId = newId();
    await h.write((tx) =>
      tx.insert(org.bankTransactions).values({
        id: pendingId,
        bankAccountId: bucketAcct.id,
        date: "2026-05-05",
        amount: -1500,
        description: "STORE HOLD",
        normalizedDescription: "STORE HOLD",
        isPending: true,
        dedupeHash: `pending-${pendingId}`,
      }),
    );

    const counts = await owner.json(
      "GET",
      `${base()}/bank-transactions/counts?bank_account_id=${bucketAcct.id}`,
    );
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual({
      all: 5,
      to_categorize: 1,
      pending: { count: 1, total: -1500 },
      categorized: 2,
      excluded: 1,
    });

    // `q` narrows the counts the same way it narrows the list.
    const qCounts = await owner.json(
      "GET",
      `${base()}/bank-transactions/counts?bank_account_id=${bucketAcct.id}&q=store`,
    );
    expect(qCounts.body).toEqual({
      all: 2,
      to_categorize: 0,
      pending: { count: 1, total: -1500 },
      categorized: 1,
      excluded: 0,
    });

    // `bucket` filters the list the same way.
    const todo = await owner.json(
      "GET",
      `${base()}/bank-transactions?bank_account_id=${bucketAcct.id}&bucket=to_categorize`,
    );
    expect(todo.body.data.map((t: any) => t.id)).toEqual([coffee.id]);
    const pendingList = await owner.json(
      "GET",
      `${base()}/bank-transactions?bank_account_id=${bucketAcct.id}&bucket=pending`,
    );
    expect(pendingList.body.data.map((t: any) => t.id)).toEqual([pendingId]);
    const catAndExcl = await owner.json(
      "GET",
      `${base()}/bank-transactions?bank_account_id=${bucketAcct.id}&bucket=categorized,excluded`,
    );
    expect(new Set(catAndExcl.body.data.map((t: any) => t.id))).toEqual(
      new Set([big.id, grocery.id, sub.id]),
    );

    // `unreviewed` on the bank account view leaves out the pending row and the one in review.
    const accts = (await owner.json("GET", `${base()}/bank-accounts`)).body.data;
    const view = accts.find((a: any) => a.id === bucketAcct.id);
    expect(view.unreviewed).toBe(1);
    expect(view.pending).toBe(1);
    expect(view.pending_amount).toBe(-1500);
  });
});

describe(`rules (${DB_MODE})`, () => {
  test("auto-post rules post; suggest rules land in the review queue; approve and reject", async () => {
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.filter(
      (a: any) => a.type === "expense",
    );
    const auto = await owner.json("POST", `${base()}/rules`, {
      name: "Gusto payroll",
      conditions: { description_contains: "gusto", direction: "out" },
      actions: { account_id: expense[2].id, auto_post: true },
    });
    expect(auto.status).toBe(201);
    expect(auto.body.rule.is_active).toBe(true);
    const suggest = await owner.json("POST", `${base()}/rules`, {
      name: "Uber",
      conditions: { description_regex: "^uber\\b" },
      actions: { account_id: expense[3].id },
    });
    expect(suggest.status).toBe(201);
    const invalid = await owner.json("POST", `${base()}/rules`, {
      name: "x",
      conditions: {},
      actions: { account_id: expense[0].id },
    });
    expect(invalid.status).toBe(422);
    const evil = await owner.json("POST", `${base()}/rules`, {
      name: "x",
      conditions: { description_regex: "(a+)+$" },
      actions: { account_id: expense[0].id },
    });
    expect(evil.status).toBe(422);

    const csv = `Date,Description,Amount\n2026-04-01,GUSTO PAYROLL 4411,-1200.00\n2026-04-02,UBER TRIP HELP.UBER.COM,-23.10\n2026-04-03,GUSTO PAYROLL BIG,-3000.00\n`;
    const prof = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: "YYYY-MM-DD",
      amountMode: "signed",
      signConvention: "positive_is_deposit",
      columns: { date: 0, description: 1, amount: 2 },
    };
    const imp = await owner.json("POST", `${base()}/bank-accounts/${checking.id}/import`, {
      filename: "apr.csv",
      content: csv,
      profile: prof,
      save_profile: false,
    });
    expect(imp.body.rules_applied).toBe(3);
    expect(imp.body.auto_posted).toBe(1);
    // the $3,000 payroll is over the review threshold even with auto-post, and Uber is suggest-only
    expect(imp.body.proposed).toBe(2);

    const queue = await owner.json("GET", `${base()}/review`);
    const uber = queue.body.data.find((i: any) => i.payload.bank_transaction?.description.includes("UBER"));
    expect(uber.item_type).toBe("bank_categorization");
    expect(uber.proposed_by_actor).toBe("rule");
    expect(queue.body.pending_count).toBeGreaterThanOrEqual(2);
    const big = queue.body.data.find((i: any) => i.payload.bank_transaction?.description.includes("BIG"));
    expect(big.reason).toContain("threshold");

    const before = await tb();
    const ap = await owner.json("POST", `${base()}/review/${uber.id}/approve`, {});
    expect(ap.status).toBe(200);
    expect(ap.body.item.status).toBe("approved");
    const after = await tb();
    expect(after.lines).not.toEqual(before.lines);
    const uberTxn = (await txns(owner, checking.id)).find((t) => t.description.includes("UBER"));
    expect(uberTxn.status).toBe("categorized");

    const rj = await owner.json("POST", `${base()}/review/${big.id}/reject`, {
      note: "Split this one by hand",
    });
    expect(rj.body.item.status).toBe("rejected");
    const bigTxn = (await txns(owner, checking.id)).find((t) => t.description.includes("BIG"));
    expect(bigTxn.status).toBe("new");
    expect(bigTxn.entry_id).toBeNull();
    const rejectedEntry = (await owner.json("GET", `${base()}/entries?status=rejected`)).body.data;
    expect(rejectedEntry.length).toBeGreaterThanOrEqual(1);
    expect((await tb()).lines).toEqual(after.lines);
  });
});

describe(`review queue and policies (${DB_MODE})`, () => {
  const mcp = (userId: string): ActorInfo => ({
    actor: "mcp",
    role: "owner",
    userId,
    oauthClientId: "client-1",
    proposeOnly: true,
  });

  test("MCP proposals wait for review, do not affect reports, and MCP cannot approve", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const before = await tb();
    const r = await h.write((tx) =>
      submitEntryTx(tx, orgId, mcp(owner.userId), {
        date: "2026-05-01",
        memo: "Proposed by Claude",
        rationale: "Monthly software subscription",
        lines: [
          { accountId: acct["1000"]!, amount: -1500 },
          { accountId: acct["4000"]!, amount: 1500 },
        ],
      }),
    );
    expect(r.entry.status).toBe("pending_review");
    expect((await tb()).lines).toEqual(before.lines);
    await expect(
      h.write((tx) => approveReviewTx(tx, orgId, mcp(owner.userId), r.reviewItemId!)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.write((tx) => rejectReviewTx(tx, orgId, mcp(owner.userId), r.reviewItemId!, null)),
    ).rejects.toMatchObject({ status: 403 });
    const item = (await owner.json("GET", `${base()}/review/${r.reviewItemId}`)).body;
    expect(item.rationale).toBe("Monthly software subscription");

    // edit and approve keeps both versions
    const ap = await owner.json("POST", `${base()}/review/${r.reviewItemId}/approve`, {
      note: "fixed amount",
      edit: {
        lines: [
          { account_id: acct["1000"], amount: -1600 },
          { account_id: acct["4000"], amount: 1600 },
        ],
      },
    });
    expect(ap.status).toBe(200);
    expect(ap.body.item.edited).toBe(true);
    expect(ap.body.item.original_payload.entry.total).toBe(1500);
    expect(ap.body.item.payload.entry.total).toBe(1600);
    const e = (await owner.json("GET", `${base()}/entries/${r.entry.id}`)).body;
    expect(e.status).toBe("posted");
    expect(e.created_by_actor).toBe("mcp");
    expect(e.posted_by).toBe(owner.userId);
  });

  test("viewers and accountants cannot decide; bulk approve reports per item", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const ids: string[] = [];
    for (const amt of [100, 200]) {
      const r = await h.write((tx) =>
        submitEntryTx(tx, orgId, mcp(owner.userId), {
          date: "2026-05-02",
          lines: [
            { accountId: acct["1000"]!, amount: amt },
            { accountId: acct["4000"]!, amount: -amt },
          ],
        }),
      );
      ids.push(r.reviewItemId!);
    }
    const acc = await login(env, "cpa@example.com");
    await addMember(env, orgId, acc.userId, "accountant");
    expect((await acc.json("POST", `${base()}/review/${ids[0]}/approve`, {})).status).toBe(403);
    const bulk = await owner.json("POST", `${base()}/review/bulk-approve`, { ids: [...ids, ids[0]] });
    expect(bulk.body.results.map((x: any) => x.ok)).toEqual([true, true, false]);
  });

  test("owner policies can auto-approve small MCP categorizations to accounts used for the payee", async () => {
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.filter(
      (a: any) => a.type === "expense",
    );
    const pol = await owner.json("POST", `${base()}/review-policies`, {
      name: "Small known MCP categorizations",
      actor: "mcp",
      condition: { amount_lt: 10000, item_types: ["bank_categorization"], account_used_for_payee: true },
      action: "auto_approve",
    });
    expect(pol.status).toBe(201);
    const bk = await login(env, "bk2@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    expect(
      (
        await bk.json("POST", `${base()}/review-policies`, {
          actor: "mcp",
          condition: {},
          action: "auto_approve",
        })
      ).status,
    ).toBe(403);

    const csv = `Date,Description,Amount\n2026-06-01,NOTION LABS,-10.00\n2026-06-15,NOTION LABS,-10.00\n2026-06-20,NOTION LABS,-10.00\n`;
    const prof = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: "YYYY-MM-DD",
      amountMode: "signed",
      signConvention: "positive_is_deposit",
      columns: { date: 0, description: 1, amount: 2 },
    };
    await owner.json("POST", `${base()}/bank-accounts/${card.id}/import`, {
      filename: "jun.csv",
      content: csv,
      profile: prof,
      save_profile: false,
    });
    const list = (await txns(owner, card.id, "new"))
      .filter((t) => t.description === "NOTION LABS")
      .sort((a, b) => a.date.localeCompare(b.date));
    const h = await env.ctx.orgs.mustOpen(orgId);
    // First time: account never used for this payee → review.
    const first = await h.write((tx) =>
      categorizeTx(tx, orgId, mcp(owner.userId), list[0].id, {
        splits: [{ account_id: expense[4].id, amount: 1000 }],
        rationale: "Notion is software",
      }),
    );
    expect(first.entry.status).toBe("pending_review");
    await owner.json("POST", `${base()}/review/${first.reviewItemId}/approve`, {});
    // Now the account has been used for this payee → auto-approved by the owner's policy.
    const second = await h.write((tx) =>
      categorizeTx(tx, orgId, mcp(owner.userId), list[1].id, {
        splits: [{ account_id: expense[4].id, amount: 1000 }],
      }),
    );
    expect(second.entry.status).toBe("posted");
    // A different account is not "used for this payee" → review.
    const third = await h.write((tx) =>
      categorizeTx(tx, orgId, mcp(owner.userId), list[2].id, {
        splits: [{ account_id: expense[5].id, amount: 1000 }],
      }),
    );
    expect(third.entry.status).toBe("pending_review");
    await owner.json("DELETE", `${base()}/review-policies/${pol.body.id}`);
  });

  test("AI-proposed rules are inactive until approved", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const { createRuleTx } = await import("../src/services/rules.ts");
    const out = await h.write((tx) =>
      createRuleTx(tx, orgId, mcp(owner.userId), {
        name: "Claude: Zoom",
        conditions: { description_contains: "zoom.us" },
        actions: { account_id: acct["4000"]! },
        rationale: "Seen 6 times",
      }),
    );
    expect(out.rule.is_active).toBe(false);
    expect(out.review_item_id).toBeTruthy();
    const ap = await owner.json("POST", `${base()}/review/${out.review_item_id}/approve`, {});
    expect(ap.status).toBe(200);
    const rules = (await owner.json("GET", `${base()}/rules`)).body.data;
    expect(rules.find((r: any) => r.id === out.rule.id).is_active).toBe(true);
  });

  test("items pending more than 30 days expire and cannot be approved", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const r = await h.write((tx) =>
      submitEntryTx(tx, orgId, mcp(owner.userId), {
        date: "2026-05-03",
        lines: [
          { accountId: acct["1000"]!, amount: 5 },
          { accountId: acct["4000"]!, amount: -5 },
        ],
      }),
    );
    const n = await h.write((tx) => expireOldTx(tx, orgId, new Date(Date.now() + 31 * 86_400_000)));
    expect(n).toBeGreaterThanOrEqual(1);
    const ap = await owner.json("POST", `${base()}/review/${r.reviewItemId}/approve`, {});
    expect(ap.status).toBe(409);
    const cleanup = await owner.json("POST", `${base()}/review/${r.reviewItemId}/reject`, {
      note: "cleanup",
    });
    expect(cleanup.body.item.status).toBe("rejected");
  });
});

describe(`reconciliation (${DB_MODE})`, () => {
  test("clear lines to zero difference, complete, locked, owner-only undo", async () => {
    const acctId = savings.ledger_account_id;
    const start = await owner.json("POST", `${base()}/reconciliations`, {
      account_id: acctId,
      statement_end_date: "2026-01-31",
      statement_ending_balance: 50000,
    });
    expect(start.status).toBe(201);
    expect(start.body.beginning_balance).toBe(0);
    const again = await owner.json("POST", `${base()}/reconciliations`, {
      account_id: acctId,
      statement_end_date: "2026-02-28",
      statement_ending_balance: 1,
    });
    expect(again.status).toBe(409);
    const detail = await owner.json("GET", `${base()}/reconciliations/${start.body.id}`);
    const transfer = detail.body.lines.find((l: any) => l.amount === 50000);
    expect(transfer).toBeTruthy();
    const early = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/complete`);
    expect(early.status).toBe(422);
    const t = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/lines`, {
      line_ids: [transfer.id],
      cleared: true,
    });
    expect(t.body.difference).toBe(0);
    const done = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/complete`);
    expect(done.body.status).toBe("completed");
    const locked = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/lines`, {
      line_ids: [transfer.id],
      cleared: false,
    });
    expect(locked.status).toBe(409);

    // the database refuses changes to a completed reconciliation's items
    const h = await env.ctx.orgs.mustOpen(orgId);
    await expect(
      h.client.execute({
        sql: "delete from reconciliation_items where reconciliation_id = ?",
        args: [start.body.id],
      }),
    ).rejects.toThrow(/locked/);

    const unrec = await owner.json("GET", `${base()}/accounts/${acctId}/unreconciled`);
    expect(unrec.body.data.some((l: any) => l.id === transfer.id)).toBe(false);

    const next = await owner.json("POST", `${base()}/reconciliations`, {
      account_id: acctId,
      statement_end_date: "2026-02-28",
      statement_ending_balance: 50000,
    });
    expect(next.body.beginning_balance).toBe(50000);
    await owner.json("DELETE", `${base()}/reconciliations/${next.body.id}`);

    const bk = await login(env, "bk3@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    expect((await bk.json("POST", `${base()}/reconciliations/${start.body.id}/undo`)).status).toBe(403);
    const undo = await owner.json("POST", `${base()}/reconciliations/${start.body.id}/undo`);
    expect(undo.body.status).toBe("undone");
    const audit = (await owner.json("GET", `${base()}/audit?limit=500`)).body.data;
    expect(audit.some((a: any) => a.action === "reconciliation.undo")).toBe(true);
    const h2 = await env.ctx.orgs.mustOpen(orgId);
    const row = await h2.db
      .select()
      .from(org.reconciliations)
      .where(eq(org.reconciliations.id, start.body.id))
      .get();
    expect(row?.undoneBy).toBe(owner.userId);
  });

  describe(`reconciliation statements and flags (${DB_MODE})`, () => {
    const PDF = new TextEncoder().encode("%PDF-1.4\n% fake statement\n");
    let reconId: string;
    let lines: any[];

    const upload = (target: string, name = "statement.pdf") => {
      const form = new FormData();
      form.append("file", new File([PDF], name, { type: "application/pdf" }));
      form.append("target_type", "reconciliation");
      form.append("target_id", target);
      return owner.req("POST", `${base()}/attachments`, form);
    };
    const flag = (body: Record<string, unknown>, id = reconId) =>
      owner.json("POST", `${base()}/reconciliations/${id}/flags`, body);
    const detail = async (id = reconId) => (await owner.json("GET", `${base()}/reconciliations/${id}`)).body;
    const counts = async (id: string) =>
      (await owner.json("GET", `${base()}/reconciliations`)).body.data.find((r: any) => r.id === id);

    test("upload a statement to an in-progress reconciliation and list it", async () => {
      const start = await owner.json("POST", `${base()}/reconciliations`, {
        account_id: savings.ledger_account_id,
        statement_end_date: "2026-01-31",
        statement_ending_balance: 50000,
      });
      expect(start.status).toBe(201);
      reconId = start.body.id;
      expect((await counts(reconId)).statement_count).toBe(0);
      const up = await upload(reconId);
      expect(up.status).toBe(201);
      const att = await up.json();
      const d = await detail();
      expect(d.statements.map((a: any) => a.id)).toEqual([att.id]);
      lines = d.lines;
      expect((await counts(reconId)).statement_count).toBe(1);
      const list = await owner.json(
        "GET",
        `${base()}/attachments?target_type=reconciliation&target_id=${reconId}`,
      );
      expect(list.body.data).toHaveLength(1);
    });

    test("flags are validated per kind, and a duplicate open flag is refused", async () => {
      const line = lines[0].id;
      const bad = [
        { kind: "missing_from_books", description: "x" },
        { kind: "missing_from_books", description: "x", date: "2026-01-15" },
        { kind: "not_on_statement", description: "x" },
        { kind: "mismatch", description: "x", journal_line_id: line },
        { kind: "mismatch", description: "x", amount: 5 },
        { kind: "beginning_balance", description: "x" },
        { kind: "not_on_statement", description: "x", journal_line_id: "nope" },
      ];
      for (const b of bad) expect((await flag(b)).status).toBe(422);
      const ok = await flag({
        kind: "missing_from_books",
        description: "Bank fee",
        date: "2026-01-15",
        amount: -1500,
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: "open", created_actor: "user", amount: -1500 });
      const dup = await flag({
        kind: "missing_from_books",
        description: "Bank fee again",
        date: "2026-01-15",
        amount: -1500,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("duplicate_flag");
      expect((await flag({ kind: "not_on_statement", description: "?", journal_line_id: line })).status).toBe(
        201,
      );
      expect(
        (await flag({ kind: "not_on_statement", description: "again", journal_line_id: line })).status,
      ).toBe(409);
      expect(
        (await flag({ kind: "beginning_balance", description: "Opens at 10", amount: 1000 })).status,
      ).toBe(201);
      expect((await flag({ kind: "other", description: "Look at page 2" })).status).toBe(201);
      // a line of another account is refused
      const other = await owner.json("GET", `${base()}/accounts/${checking.ledger_account_id}/unreconciled`);
      if (other.body.data.length)
        expect(
          (await flag({ kind: "not_on_statement", description: "x", journal_line_id: other.body.data[0].id }))
            .status,
        ).toBe(422);
      expect((await detail()).flags).toHaveLength(4);
    });

    test("open flags block Complete; resolve and dismiss clear them; the report lists them", async () => {
      const transfer = lines.find((l) => l.amount === 50000);
      await owner.json("POST", `${base()}/reconciliations/${reconId}/lines`, {
        line_ids: [transfer.id],
        cleared: true,
      });
      const blocked = await owner.json("POST", `${base()}/reconciliations/${reconId}/complete`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe("open_flags");
      const flags = (await detail()).flags;
      const [first, ...rest] = flags;
      const res = await owner.json("POST", `${base()}/reconciliations/${reconId}/flags/${first.id}/resolve`, {
        status: "resolved",
        note: "Booked it",
      });
      expect(res.body).toMatchObject({
        status: "resolved",
        resolution_note: "Booked it",
        resolved_actor: "user",
      });
      expect(
        (
          await owner.json("POST", `${base()}/reconciliations/${reconId}/flags/${first.id}/resolve`, {
            status: "dismissed",
          })
        ).status,
      ).toBe(409);
      // a flag of another reconciliation is not found under this one
      expect(
        (
          await owner.json("POST", `${base()}/reconciliations/${newId()}/flags/${rest[0].id}/resolve`, {
            status: "dismissed",
          })
        ).status,
      ).toBe(404);
      for (const f of rest.slice(0, -1))
        await owner.json("POST", `${base()}/reconciliations/${reconId}/flags/${f.id}/resolve`, {
          status: "dismissed",
        });
      expect((await counts(reconId)).open_flag_count).toBe(1);
      expect((await owner.json("POST", `${base()}/reconciliations/${reconId}/complete`)).status).toBe(422);
      await owner.json("POST", `${base()}/reconciliations/${reconId}/flags/${rest.at(-1).id}/resolve`, {
        status: "dismissed",
        note: "Fine",
      });

      const csvRes = await owner.req("GET", `${base()}/reconciliations/${reconId}/export?format=csv`);
      expect(csvRes.status).toBe(200);
      const csv = await csvRes.text();
      expect(csv).toContain("Flags");
      expect(csv).toContain("Bank fee");
      expect(csv).toContain("Booked it");
      const done = await owner.json("POST", `${base()}/reconciliations/${reconId}/complete`);
      expect(done.body.status).toBe("completed");
    });

    test("a statement can be added to a completed reconciliation without changing it", async () => {
      const before = (await detail()).reconciliation;
      const up = await upload(reconId, "second.pdf");
      expect(up.status).toBe(201);
      const after = await detail();
      expect(after.statements).toHaveLength(2);
      expect({ ...after.reconciliation, statement_count: undefined }).toEqual({
        ...before,
        statement_count: undefined,
      });
      expect(after.reconciliation.status).toBe("completed");
      expect((await counts(reconId)).statement_count).toBe(2);
      // flags can't be added to a completed reconciliation
      expect((await flag({ kind: "other", description: "late" })).status).toBe(409);
    });

    test("completeReconTx refuses the mcp actor and propose-only actors", async () => {
      const h = await env.ctx.orgs.mustOpen(orgId);
      const start = await owner.json("POST", `${base()}/reconciliations`, {
        account_id: card.ledger_account_id,
        statement_end_date: "2026-01-31",
        statement_ending_balance: 0,
      });
      expect(start.status).toBe(201);
      const mcp: ActorInfo = { actor: "mcp", role: "owner", userId: owner.userId };
      await expect(h.write((tx) => completeReconTx(tx, orgId, mcp, start.body.id))).rejects.toThrow(/person/);
      const po: ActorInfo = { actor: "api_token", role: "owner", userId: owner.userId, proposeOnly: true };
      await expect(h.write((tx) => completeReconTx(tx, orgId, po, start.body.id))).rejects.toThrow(/person/);
      // a propose-only token can't dismiss, or resolve a flag a person raised
      const personFlag = await flag({ kind: "other", description: "raised by a person" }, start.body.id);
      expect(personFlag.status).toBe(201);
      await expect(
        h.write((tx) => resolveFlagTx(tx, orgId, po, personFlag.body.id, { status: "dismissed" })),
      ).rejects.toThrow(/person/);
      await expect(
        h.write((tx) => resolveFlagTx(tx, orgId, po, personFlag.body.id, { status: "resolved" })),
      ).rejects.toThrow(/you raised/);
      // discarding removes its flags and unlinks its statements; the file stays
      expect((await flag({ kind: "other", description: "gone soon" }, start.body.id)).status).toBe(201);
      const up = await (await upload(start.body.id, "temp.pdf")).json();
      expect((await owner.json("DELETE", `${base()}/reconciliations/${start.body.id}`)).status).toBe(200);
      const rows = await h.db
        .select()
        .from(org.reconciliationFlags)
        .where(eq(org.reconciliationFlags.reconciliationId, start.body.id))
        .all();
      expect(rows).toHaveLength(0);
      const links = await h.db
        .select()
        .from(org.attachmentLinks)
        .where(eq(org.attachmentLinks.targetId, start.body.id))
        .all();
      expect(links).toHaveLength(0);
      expect((await owner.req("GET", `${base()}/attachments/${up.id}`)).status).toBe(200);
      // clean up so the later tests start from a known state
      await owner.json("POST", `${base()}/reconciliations/${reconId}/undo`);
    });
  });

  describe(`reconciliation over MCP (${DB_MODE})`, () => {
    const PDF = new TextEncoder().encode("%PDF-1.4\n% fake statement\n");
    let token: string;
    let viewerToken: string;

    async function call(tok: string, name: string, args: Record<string, unknown>) {
      const res = await env.app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tok}`,
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
      token = (
        await owner.json("POST", "/api/v1/tokens", {
          org_id: orgId,
          name: "recon-assistant",
          role: "bookkeeper",
          propose_only: true,
        })
      ).body.token;
      viewerToken = (
        await owner.json("POST", "/api/v1/tokens", { org_id: orgId, name: "recon-ro", role: "viewer" })
      ).body.token;
    });

    test("the agent starts, reads the statement, clears, flags, and resolves only its own flags", async () => {
      const s = await call(token, "start_reconciliation", {
        account_id: savings.ledger_account_id,
        statement_end_date: "2026-01-31",
        statement_ending_balance: 50000,
        rationale: "Statement shared in chat",
      });
      expect(s.isError).toBe(false);
      const id = s.structuredContent.reconciliation.id;
      expect(s.structuredContent.reconcile_url).toBe(
        `${env.config.server.public_url.replace(/\/$/, "")}/o/${orgId}/banking/reconcile/${id}`,
      );

      // no statement yet: the note points at reconcile_url
      const none = await call(token, "read_statement", { reconciliation_id: id });
      expect(none.content).toHaveLength(1);
      expect(none.structuredContent.note).toContain("reconcile_url");
      const missing = await call(token, "list_reconciliations", { has_statement: false });
      expect(missing.structuredContent.data.map((r: any) => r.id)).toContain(id);

      const form = new FormData();
      form.append("file", new File([PDF], "jan.pdf", { type: "application/pdf" }));
      form.append("target_type", "reconciliation");
      form.append("target_id", id);
      expect((await owner.req("POST", `${base()}/attachments`, form)).status).toBe(201);
      const read = await call(token, "read_statement", { reconciliation_id: id });
      expect(read.content[1]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf" } });
      expect(Buffer.from(read.content[1].resource.blob, "base64")).toEqual(Buffer.from(PDF));
      const withStmt = await call(token, "list_reconciliations", {
        has_statement: true,
        status: "in_progress",
      });
      expect(withStmt.structuredContent.data.map((r: any) => r.id)).toEqual([id]);

      const g = await call(token, "get_reconciliation", { reconciliation_id: id });
      const transfer = g.structuredContent.lines.find((l: any) => l.amount === 50000);
      expect(g.structuredContent.statements).toHaveLength(1);
      const c = await call(token, "clear_reconciliation_lines", {
        reconciliation_id: id,
        line_ids: [transfer.id],
        cleared: true,
        rationale: "Matches the statement",
      });
      expect(c.structuredContent.reconciliation.difference).toBe(0);

      const f = await call(token, "flag_reconciliation_item", {
        reconciliation_id: id,
        kind: "missing_from_books",
        description: "Fee on the statement",
        date: "2026-01-20",
        amount: -500,
      });
      expect(f.isError).toBe(false);
      expect(f.structuredContent.flag).toMatchObject({ created_actor: "mcp", status: "open" });
      const bad = await call(token, "flag_reconciliation_item", {
        reconciliation_id: id,
        kind: "not_on_statement",
        description: "x",
      });
      expect(bad.isError).toBe(true);

      // a person's flag can't be resolved by the agent
      const theirs = await owner.json("POST", `${base()}/reconciliations/${id}/flags`, {
        kind: "other",
        description: "Person's note",
      });
      const refused = await call(token, "resolve_reconciliation_flag", {
        flag_id: theirs.body.id,
        note: "done",
      });
      expect(refused.isError).toBe(true);

      // completing is blocked by the open flags, and the agent has no tool for it
      expect((await owner.json("POST", `${base()}/reconciliations/${id}/complete`)).status).toBe(422);
      const ok = await call(token, "resolve_reconciliation_flag", {
        flag_id: f.structuredContent.flag.id,
        note: "Booked the fee",
      });
      expect(ok.structuredContent.flag).toMatchObject({ status: "resolved", resolved_actor: "mcp" });
      // the agent's token can't complete over REST either
      const viaRest = await env.app.request(`${base()}/reconciliations/${id}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(viaRest.status).toBe(403);
      await owner.json("POST", `${base()}/reconciliations/${id}/flags/${theirs.body.id}/resolve`, {
        status: "dismissed",
      });
      expect((await owner.json("POST", `${base()}/reconciliations/${id}/complete`)).body.status).toBe(
        "completed",
      );
      const audit = (await owner.json("GET", `${base()}/audit?limit=500`)).body.data;
      for (const a of [
        "reconciliation.start",
        "reconciliation.clear",
        "reconciliation.flag",
        "reconciliation.flag_resolve",
      ])
        expect(audit.some((r: any) => r.action === a && r.actor === "mcp")).toBe(true);
      await owner.json("POST", `${base()}/reconciliations/${id}/undo`);
    });

    test("a viewer connection is refused the write tools but can read", async () => {
      const r = await call(viewerToken, "start_reconciliation", {
        account_id: savings.ledger_account_id,
        statement_end_date: "2026-01-31",
        statement_ending_balance: 1,
        rationale: "nope",
      });
      expect(r.isError).toBe(true);
      expect((await call(viewerToken, "list_reconciliations", {})).isError).toBe(false);
    });
  });

  test("the whole session leaves both chains intact and the books tied out", async () => {
    expect((await owner.json("POST", `${base()}/verify`)).body.ok).toBe(true);
    expect((await tb()).checks.debits_minus_credits).toBe(0);
    const bs = await owner.json("GET", `${base()}/reports/balance_sheet?as_of=2026-12-31`);
    expect(bs.body.checks.assets_minus_liabilities_equity_0).toBe(0);
  });
});
