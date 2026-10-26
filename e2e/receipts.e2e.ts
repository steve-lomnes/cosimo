import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { pick } from "./pick.ts";

// An expense paid on a personal card (#95): capture the receipt, add two files, book it to Due to
// Owner, then correct the entry's account. The files and the line's contact must survive the edit.
test.describe.configure({ mode: "serial" });

const JPEG = readFileSync(join(import.meta.dirname, "fixtures/receipt.jpg"));

function orgId(page: Page) {
  return /\/o\/([A-Z0-9]+)/.exec(page.url())![1]!;
}

/** Call the API from the page, with the session's CSRF token. */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = decodeURIComponent(/(?:^|; )cosimo_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? "");
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    { method, path, body },
  );
}

test("a receipt paid personally: two files, booked to Due to Owner, then corrected", async ({ page }) => {
  await signIn(page);
  const id = orgId(page);
  const base = `/o/${id}`;
  const vendor = await api(page, "POST", `/api/v1/orgs/${id}/contacts`, {
    kind: "vendor",
    name: "Staples E2E",
  });
  expect(vendor.status).toBe(201);

  await page.goto(`${base}/expenses/receipts/new`);
  await page.getByLabel("Merchant").fill("Staples E2E");
  await page.getByLabel("Amount charged").fill("43.43");
  await page.getByLabel("Paid with", { exact: true }).selectOption("");
  await page.getByLabel("Paid with (if not a bank account)").fill("personal Amex");
  await pick(page.getByLabel("Account", { exact: true }), "6090", "6090 · Office Expenses");
  await pick(page.getByLabel("Contact", { exact: true }), "Staples E2E");
  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(page).toHaveURL(/\/expenses\/receipts$/);

  // The "no bank account" filter, as the dashboard's "Receipts to book" links to it.
  await page.getByRole("button", { name: "Paid personally or in cash" }).click();
  await expect(page).toHaveURL(/no_bank_account=true/);
  const row = page.getByRole("listitem").filter({ hasText: "Staples E2E" });
  await expect(row.getByText("Paid with personal Amex: book it")).toBeVisible();
  await row.getByRole("link", { name: "Staples E2E" }).click();

  // Two files: the receipt, then the itemized slip.
  const picker = () => page.getByRole("main").locator('input[type="file"]').first();
  await picker().setInputFiles({ name: "front.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await expect(page.getByText("Add another file")).toBeVisible();
  await picker().setInputFiles({ name: "back.jpg", mimeType: "image/jpeg", buffer: JPEG });
  const files = page.getByRole("list", { name: "Receipt files" });
  await expect(files.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Remove back.jpg" })).toBeVisible();

  // Book: with no bank account it opens on a journal entry crediting Due to Owner.
  await page.getByRole("button", { name: "Book…" }).click();
  await expect(page.getByLabel("Book as")).toHaveValue("entry");
  await expect(page.getByText("Paid personally: the business now owes the owner this amount.")).toBeVisible();
  await page.getByRole("button", { name: "Book entry" }).click();
  await expect(page).toHaveURL(/\/accounting\/entries\/[A-Z0-9]+/);
  const attachments = page.getByRole("list", { name: "Attachments" });
  await expect(attachments.getByRole("link", { name: "front.jpg" })).toBeVisible();
  await expect(attachments.getByRole("link", { name: "back.jpg" })).toBeVisible();
  const firstEntry = /\/entries\/([A-Z0-9]+)/.exec(page.url())![1]!;

  // Wrong account: edit the posted entry. The replacement keeps the files and the line's contact.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await pick(page.getByLabel("Line 1 account"), "6180", "6180 · Meals");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page).not.toHaveURL(new RegExp(firstEntry));
  await expect(page).toHaveURL(/\/accounting\/entries\/[A-Z0-9]+/);
  await expect(page.getByRole("list", { name: "Attachments" }).getByRole("link")).toHaveCount(2);
  const next = /\/entries\/([A-Z0-9]+)/.exec(page.url())![1]!;
  const entry = await api(page, "GET", `/api/v1/orgs/${id}/entries/${next}`);
  const meals = (await api(page, "GET", `/api/v1/orgs/${id}/accounts`)).body.data.find(
    (a: { code: string }) => a.code === "6180",
  );
  expect(entry.body.lines.find((l: { account_id: string }) => l.account_id === meals.id).contact_id).toBe(
    vendor.body.id,
  );
  const list = await api(page, "GET", `/api/v1/orgs/${id}/receipts?status=booked&limit=500`);
  const receipt = list.body.data.find((r: { merchant: string }) => r.merchant === "Staples E2E");
  expect(receipt.booked_target_id).toBe(next);
});
