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
  // The transaction list (the default view) shows it on today's date.
  await expect(page.getByRole("row", { name: /Planned Equipment lease -\$500\.00/ })).toBeVisible();

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

test("a reserve set up in the form shows its due date in the forecast and holds back Safe to draw", async ({
  page,
}) => {
  await signIn(page);
  // Its own org: the income it books must not change the shared org's reports.
  const made = await api(page, "POST", "/api/v1/orgs", { name: "Reserve E2E LLC" });
  expect(made.status).toBeLessThan(300);
  const id = made.body.id as string;
  const accts = await api(page, "GET", `/api/v1/orgs/${id}/accounts`);
  const code = (c: string) => accts.body.data.find((a: { code: string }) => a.code === c).id;
  await api(page, "POST", `/api/v1/orgs/${id}/bank-accounts`, {
    name: "Reserve Checking",
    kind: "checking",
    ledger_account_id: code("1000"),
  });
  const today = iso(new Date());
  for (const [account, amount] of [
    ["3100", -200_000],
    ["4000", -100_000],
  ] as const) {
    const r = await api(page, "POST", `/api/v1/orgs/${id}/entries`, {
      date: today,
      memo: "Reserve e2e",
      lines: [
        { account_id: code("1000"), amount: -amount },
        { account_id: code(account), amount },
      ],
    });
    expect(r.status).toBeLessThan(300);
  }

  await page.goto(`/o/${id}/forecast`);
  const safe = page.getByTestId("safe-to-draw");
  await expect(safe).toHaveText(usd(3000));

  await page.getByRole("tab", { name: "Reserves" }).click();
  await expect(page).toHaveURL(/\/forecast\/reserves$/);
  await expect(page.getByText("No reserves yet")).toBeVisible();
  await page.getByRole("button", { name: "New reserve" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill("Owner taxes");
  await form.getByLabel("Label").fill("Federal");
  await form.getByLabel("Rate (%)").fill("25");
  // The preset fills the four US estimate dates; replace them with one 20 days out.
  await form.getByRole("button", { name: "US quarterly estimates" }).click();
  await expect(form.getByRole("button", { name: /^Remove / })).toHaveCount(4);
  await expect(form.getByRole("button", { name: "Remove Jan 15 (following year)" })).toBeVisible();
  for (let i = 0; i < 4; i++)
    await form
      .getByRole("button", { name: /^Remove / })
      .first()
      .click();
  await form.getByRole("button", { name: "Add date" }).click();
  const due = new Date(Date.now() + 20 * 86_400_000);
  await form.getByLabel("Federal due date 1 month").selectOption(String(due.getUTCMonth() + 1));
  await form.getByLabel("Federal due date 1 day").fill(String(due.getUTCDate()));
  if (due.getUTCFullYear() !== new Date().getUTCFullYear()) await form.getByLabel("Following year").check();
  await form.getByRole("button", { name: "Create reserve" }).click();
  await expect(form).toBeHidden();

  const card = page.locator("section", { hasText: "Owner taxes" });
  await expect(card.getByRole("cell", { name: "Federal (25%)" })).toBeVisible();
  await expect(card.getByRole("cell", { name: usd(250) }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Forecast" }).click();
  await expect(safe).toHaveText(usd(2750));
  await expect(page.getByRole("row", { name: /Reserve Owner taxes: Federal/ })).toBeVisible();

  // Paid personally: only the record, and the installment shrinks by it.
  await page.getByRole("tab", { name: "Reserves" }).click();
  await card.getByRole("button", { name: "Record payment" }).click();
  const pay = page.getByRole("dialog");
  await expect(pay.getByLabel("Amount")).toHaveValue("250.00");
  await pay.getByLabel("Amount").fill("100");
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(pay.getByText(/Recorded. No entry/)).toBeVisible();
  await pay.locator("footer").getByRole("button", { name: "Close" }).click();
  await card.getByRole("button", { name: /Payments for/ }).click();
  await expect(card.getByText("Paid personally")).toBeVisible();
  await page.getByRole("tab", { name: "Forecast" }).click();
  await expect(safe).toHaveText(usd(2850));
});

test("the transaction list: search anywhere, change a planned item in its row, and switch to By period", async ({
  page,
}) => {
  await signIn(page);
  const id = orgId(page);
  const soon = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
  for (const it of [
    { name: "Studio rent", direction: "out", amount: 210_000, start_date: soon(5) },
    { name: "Workshop fee", direction: "in", amount: 75_000, start_date: soon(9) },
  ])
    expect((await api(page, "POST", `/api/v1/orgs/${id}/forecast/items`, it)).status).toBe(201);

  await page.goto(`/o/${id}/forecast`);
  const list = page.locator("section", { has: page.getByRole("heading", { name: "Transactions" }) });
  await expect(list.getByRole("row", { name: /Studio rent/ })).toBeVisible();

  // "/" focuses the search; every word must match somewhere, and >N bounds the size.
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search forecast transactions")).toBeFocused();
  await page.keyboard.type("workshop");
  await expect(list.getByRole("row", { name: /Workshop fee/ })).toBeVisible();
  await expect(list.getByRole("row", { name: /Studio rent/ })).toHaveCount(0);
  await page.getByLabel("Search forecast transactions").fill(">1000 out");
  await expect(list.getByRole("row", { name: /Studio rent/ })).toBeVisible();
  await expect(list.getByRole("row", { name: /Workshop fee/ })).toHaveCount(0);
  await list.getByRole("button", { name: "Clear" }).click();

  // Change the amount in the row; the item itself changes.
  await list.getByRole("button", { name: /Studio rent/ }).click();
  await list.getByLabel("Amount").fill("2300");
  await list.getByRole("button", { name: "Save" }).click();
  await expect(list.getByRole("row", { name: /Studio rent -\$2,300\.00/ })).toBeVisible();

  // The period view is still there.
  await list.getByRole("button", { name: "By period" }).click();
  await expect(page.getByRole("heading", { name: "By period" })).toBeVisible();
  await page.getByRole("button", { name: "Transactions" }).click();

  for (const n of ["Studio rent", "Workshop fee"])
    await page.getByRole("button", { name: `Archive ${n}` }).click();
});
