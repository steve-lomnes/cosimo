import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

// Runs in the `mobile` project (iPhone 13 viewport, touch). Serial: the first test loads a demo org
// that the rest reuse.
test.describe.configure({ mode: "serial" });

let base = "";

// A 1x1 PNG, enough for the upload path.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shot(page: Page, name: string) {
  if (process.env.MOBILE_SHOTS) await page.screenshot({ path: `${process.env.MOBILE_SHOTS}/${name}.png` });
}

test("load a demo organization", async ({ page }) => {
  await signIn(page);
  await page.goto("/orgs");
  // The button is gone once a demo org exists (a CI retry reuses the database), so reuse that one.
  const existing = page.getByRole("listitem").filter({ hasText: "Demo" }).getByRole("link");
  if (await existing.count()) await existing.first().click();
  else await page.getByRole("button", { name: "Load demo organization" }).click();
  await expect(page).toHaveURL(/\/o\/[A-Z0-9]+/);
  base = /\/o\/[A-Z0-9]+/.exec(page.url())![0];
});

test("no page scrolls sideways", async ({ page }) => {
  await signIn(page);
  const paths = [
    "",
    "/banking/categorize",
    "/banking/receipts",
    "/banking/receipts/new",
    "/banking/import",
    "/banking/rules",
    "/banking/reconcile",
    "/banking/accounts",
    "/sales/invoices",
    "/sales/customers",
    "/expenses/bills",
    "/expenses/vendors",
    "/accounting/review",
    "/accounting/accounts",
    "/accounting/entries",
    "/reports",
    "/settings",
  ].map((p) => `${base}${p}`);
  for (const p of [...paths, "/orgs", "/account"]) {
    await page.goto(p);
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await overflow(page), `horizontal overflow on ${p}`).toBeLessThanOrEqual(0);
  }
});

test("drawer: user controls live in it and it closes after navigating", async ({ page }) => {
  await signIn(page);
  await page.goto(base);
  const header = page.getByRole("banner");
  await shot(page, "header");
  await expect(header.getByRole("button", { name: "Sign out" })).toBeHidden();
  await expect(header.getByTitle("Toggle theme")).toBeHidden();

  await header.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("navigation", { name: "Main" }).locator("xpath=..");
  await expect(drawer.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(drawer.getByTitle("Toggle theme")).toBeVisible();
  await shot(page, "drawer");

  // Escape closes it
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

  await header.getByRole("button", { name: "Open menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Bills", exact: true })
    .click();
  await expect(page).toHaveURL(/\/expenses\/bills/);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
});

test("attach a receipt to a bank transaction and still categorize it", async ({ page }) => {
  await signIn(page);
  await page.goto(`${base}/banking/categorize?status=todo`);
  await page.locator("ul li > button[aria-expanded]").filter({ hasText: "BLUE BOTTLE" }).first().click();
  const row = page.locator("li:has(> button[aria-expanded=true])");
  await expect(row.getByText("Attach receipt")).toBeVisible();
  await row
    .locator('input[type="file"]')
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await expect(row.getByRole("link", { name: "receipt.png" })).toBeVisible();
  await shot(page, "categorize");

  // categorizing still works
  const before = await page.getByRole("button", { name: /^To categorize/ }).innerText();
  await row.getByLabel("Category").fill("software");
  await page.getByRole("listbox").getByRole("option").first().click();
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /^To categorize/ })).not.toHaveText(before);
});

test("tap targets are at least 44px on Categorize and the review queue", async ({ page }) => {
  await signIn(page);
  const tooSmall = async (scope: string) => {
    const sizes = await page
      .locator(
        `${scope} button:visible, ${scope} select:visible, ${scope} input:visible:not([type=checkbox]):not([type=file])`,
      )
      .evaluateAll((els) =>
        els.map((e) => ({
          text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30),
          h: e.getBoundingClientRect().height,
        })),
      );
    return sizes.filter((s) => s.h < 43.5);
  };

  await page.goto(`${base}/banking/categorize?status=todo`);
  await page.locator("ul li > button[aria-expanded]").first().click();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  // the list rows themselves are full-width buttons; check the toolbar and the open editor
  expect(await tooSmall("main")).toEqual([]);
  expect(await tooSmall("header")).toEqual([]);

  // A manual entry over the review threshold ($2,500) waits in the review queue, so the queue has
  // Approve, Edit and Reject buttons to measure. (Bank rows the owner categorizes post directly.)
  const orgId = base.split("/")[2];
  const status = await page.evaluate(async (orgId) => {
    const csrf = decodeURIComponent(/(?:^|; )cosimo_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? "");
    const headers = { "content-type": "application/json", "x-csrf-token": csrf };
    const accts = (await (await fetch(`/api/v1/orgs/${orgId}/accounts`)).json()).data as {
      id: string;
      code: string;
    }[];
    const id = (code: string) => accts.find((a) => a.code === code)?.id;
    const res = await fetch(`/api/v1/orgs/${orgId}/entries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        memo: "Mobile e2e: equipment",
        lines: [
          { account_id: id("1500"), amount: 300000 },
          { account_id: id("1000"), amount: -300000 },
        ],
      }),
    });
    return res.status;
  }, orgId);
  expect(status).toBe(201);

  await page.goto(`${base}/accounting/review`);
  await expect(page.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible();
  expect(await tooSmall("main")).toEqual([]);
  await shot(page, "review");
});

test("snap a receipt, then the bank charge arrives and Categorize suggests it", async ({ page }) => {
  await signIn(page);
  await page.goto(base);
  // The header button opens the chooser, then the capture form with the photo in hand.
  await page
    .getByRole("banner")
    .locator('input[type="file"]')
    .setInputFiles(join(import.meta.dirname, "fixtures/receipt.jpg"));
  await expect(page).toHaveURL(/\/banking\/receipts\/new/);
  await expect(page.getByAltText("Receipt preview")).toBeVisible();
  await page.getByLabel("Merchant").fill("Professor Java's");
  await page.getByLabel("Amount charged").fill("8.69");
  await page.getByLabel("Account", { exact: true }).fill("meals");
  await page.getByRole("listbox").getByRole("option").first().click();
  await shot(page, "receipt-new");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Save receipt" }).click();

  // It waits in the Inbox until the bank feed catches up.
  await expect(page).toHaveURL(/\/banking\/receipts$/);
  const receipt = page.getByRole("listitem").filter({ hasText: "Professor Java's" });
  await expect(receipt.getByText("Waiting for bank")).toBeVisible();
  await expect(receipt.getByRole("img", { name: "Receipt" })).toBeVisible();
  await shot(page, "receipts");
  const small = await page
    .locator("main button:visible, main select:visible, main input:visible:not([type=file])")
    .evaluateAll((els) =>
      els.map((e) => ({
        text: (e.textContent || "").trim().slice(0, 30),
        h: e.getBoundingClientRect().height,
      })),
    );
  expect(small.filter((x) => x.h < 43.5)).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // The charge arrives (a CSV import stands in for the feed) and is matched to the receipt.
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(`${base}/banking/import`);
  await page.getByLabel("Statement file").setInputFiles({
    name: "java.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`Date,Description,Amount\n${today},PROFESSOR JAVAS ALBANY NY,-8.69\n`),
  });
  await page.getByRole("button", { name: "Import 1 transactions" }).click();
  await expect(page.getByText(/Imported 1/)).toBeVisible();

  await page.goto(`${base}/banking/categorize?status=todo`);
  const txn = page.locator("ul li > button[aria-expanded]").filter({ hasText: "PROFESSOR JAVAS" });
  await expect(txn.getByText(/From receipt/)).toBeVisible();
  await txn.click();
  const row = page.locator("li:has(> button[aria-expanded=true])");
  await expect(
    row.getByText("Possible receipt").or(row.getByText("Receipt: Professor Java's")),
  ).toBeVisible();
  await shot(page, "categorize-receipt");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("PROFESSOR JAVAS")).toHaveCount(0);

  await page.goto(`${base}/banking/receipts`);
  await page.getByRole("tab", { name: "Matched" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Professor Java's" })
      .getByText(/Matched to .*PROFESSOR JAVAS/),
  ).toBeVisible();
});
