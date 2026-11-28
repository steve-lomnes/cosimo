import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { pick } from "./pick.ts";

// Reconcile with a statement (#118): start, upload the statement PDF, see a flag raised over the API
// block Complete, dismiss it, then Complete. The History table shows the statement.
test.describe.configure({ mode: "serial" });

const PDF = Buffer.from("%PDF-1.4\n% e2e statement\n");

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

test("reconcile with a statement: upload, a flag blocks Complete, dismiss, complete", async ({ page }) => {
  await signIn(page);
  const id = orgId(page);
  await page.goto(`/o/${id}/banking/reconcile`);

  // A statement dated before any activity, so nothing needs clearing and the difference is 0.
  await pick(page.getByLabel("Account", { exact: true }), "1000", "1000 · Business Checking");
  await page.getByLabel("Statement end date").fill("1999-12-31");
  await page.getByLabel("Statement ending balance").fill("0.00");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/banking\/reconcile\/[A-Z0-9]+/);
  const reconId = /\/reconcile\/([A-Z0-9]+)/.exec(page.url())![1]!;

  await page
    .getByRole("main")
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "december.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByRole("link", { name: "december.pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeEnabled();

  // A flag raised over the API (as the assistant would) blocks Complete.
  const flag = await api(page, "POST", `/api/v1/orgs/${id}/reconciliations/${reconId}/flags`, {
    kind: "missing_from_books",
    description: "Bank fee not in the books",
    date: "1999-12-15",
    amount: -1500,
  });
  expect(flag.status).toBe(201);
  await page.reload();
  await expect(page.getByText("Bank fee not in the books")).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeDisabled();

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("button", { name: "Complete" })).toBeEnabled();
  await page.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByText("Completed and locked.")).toBeVisible();

  // A statement can still be added afterwards, and History shows it.
  await page
    .getByRole("main")
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "december-page2.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByRole("link", { name: "december-page2.pdf" })).toBeVisible();
  await page.goto(`/o/${id}/banking/reconcile`);
  await expect(page.getByRole("row", { name: /1999/ }).getByText("2 files")).toBeVisible();
});
