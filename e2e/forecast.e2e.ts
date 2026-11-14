import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

test.describe.configure({ mode: "serial" });

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

const dollars = (s: string | null) => Number((s ?? "").replace(/[^0-9.-]/g, ""));
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

test("a planned item shows in its bucket and lowers Safe to draw; Didn't happen takes it back out", async ({
  page,
}) => {
  await signIn(page);
  const id = orgId(page);
  const base = `/o/${id}`;

  // Cash to draw from: a checking account holding $2,000.
  const accts = await api(page, "GET", `/api/v1/orgs/${id}/accounts`);
  const code = (c: string) => accts.body.data.find((a: { code: string }) => a.code === c).id;
  await api(page, "POST", `/api/v1/orgs/${id}/bank-accounts`, {
    name: "Forecast Checking",
    kind: "checking",
    ledger_account_id: code("1000"),
  });
  const seed = await api(page, "POST", `/api/v1/orgs/${id}/entries`, {
    date: iso(new Date()),
    memo: "Forecast e2e opening cash",
    lines: [
      { account_id: code("1000"), amount: 200_000 },
      { account_id: code("3100"), amount: -200_000 },
    ],
  });
  expect(seed.status).toBeLessThan(300);

  await page.goto(`${base}/forecast`);
  await expect(page.getByRole("heading", { name: "Cash forecast" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Projected cash balance/ })).toBeVisible();
  const safe = page.getByTestId("safe-to-draw");
  await expect(safe).toBeVisible();
  const before = dollars(await safe.textContent());
  expect(before).toBeGreaterThan(500);

  // Planned for two days ago: it counts today, so every point of the forecast drops by the amount.
  const past = iso(new Date(Date.now() - 2 * 86_400_000));
  await page.getByRole("button", { name: "Add planned item" }).click();
  await page.getByLabel("Name").fill("Equipment lease");
  await page.getByLabel("Amount").fill("500");
  await page.getByLabel("Date").fill(past);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByRole("cell", { name: "Equipment lease", exact: true })).toBeVisible();
  await expect(safe).toHaveText(usd(before - 500));
  await page.evaluate(() => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) b.click();
  });
  await expect(page.getByRole("row", { name: /Equipment lease.*Planned/ })).toBeVisible();

  // It is past due and unlinked, so it needs attention.
  const attention = page.locator("li", { hasText: "Equipment lease was planned for a date that has passed" });
  await expect(attention).toBeVisible();
  await attention.getByRole("button", { name: "Didn't happen" }).click();
  await expect(attention).toHaveCount(0);
  await expect(safe).toHaveText(usd(before));

  // The draw dialog starts at what is safe to draw.
  await page.getByRole("button", { name: "Plan a draw" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue(before.toFixed(2));
  await page.getByRole("button", { name: "Cancel" }).click();

  // Archive the item so later tests see no leftovers.
  await page.getByRole("button", { name: "Archive Equipment lease" }).click();
  await expect(page.getByRole("cell", { name: "Equipment lease", exact: true })).toHaveCount(0);
});

test("a scenario holds its own plan: the baseline is unchanged", async ({ page }) => {
  await signIn(page);
  const base = `/o/${orgId(page)}`;
  await page.goto(`${base}/forecast`);
  const safe = page.getByTestId("safe-to-draw");
  await expect(safe).toBeVisible();
  const baseline = await safe.textContent();

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Name").fill("Buy a van");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Scenario").locator("option:checked")).toHaveText("Buy a van");

  await page.getByRole("button", { name: "Add planned item" }).click();
  await page.getByLabel("Name").fill("Van deposit");
  await page.getByLabel("Amount").fill("300");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Van deposit", exact: true })).toBeVisible();
  await expect(safe).not.toHaveText(baseline ?? "");

  await page.getByLabel("Scenario").selectOption({ label: "Baseline" });
  await expect(page.getByRole("cell", { name: "Van deposit", exact: true })).toHaveCount(0);
  await expect(safe).toHaveText(baseline ?? "");

  // Leave no scenario behind.
  await page.getByLabel("Scenario").selectOption({ label: "Buy a van" });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByLabel("Scenario").locator("option:checked")).toHaveText("Baseline");
});
