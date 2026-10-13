import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

// Set the instance sign-up mode as the e2e owner (cookie session, so the CSRF header is needed).
async function setSignupMode(page: Page, mode: "single_user" | "open") {
  const status = await page.evaluate(async (mode) => {
    const csrf = decodeURIComponent(/(?:^|; )cosimo_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? "");
    const res = await fetch("/api/v1/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ signup_mode: mode }),
    });
    return res.status;
  }, mode);
  expect(status).toBe(200);
}

test("open sign-up: login links to /signup and creates an account; closed shows an explanation", async ({
  page,
  browser,
}) => {
  await signIn(page);
  try {
    await setSignupMode(page, "single_user");
    const closed = await browser.newContext();
    const closedPage = await closed.newPage();
    await closedPage.goto("/signup");
    await expect(closedPage.getByRole("heading", { name: "Sign-up is closed" })).toBeVisible();
    await closedPage.goto("/login");
    await expect(closedPage.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(closedPage.getByRole("link", { name: "Create one" })).toHaveCount(0);
    await closed.close();

    await setSignupMode(page, "open");
    const fresh = await browser.newContext();
    const p = await fresh.newPage();
    await p.goto("/login");
    await p.getByRole("link", { name: "Create one" }).click();
    await expect(p).toHaveURL(/\/signup/);
    await p.getByLabel("Name").fill("Sign Up Test");
    await p.getByLabel("Email").fill(`signup-${Date.now()}@example.com`);
    await p.getByLabel("Password", { exact: true }).fill("a long enough password");
    await p.getByLabel("Confirm password").fill("a long enough password");
    await p.getByRole("button", { name: "Create account" }).click();
    await expect(p).toHaveURL(/\/orgs/);
    await fresh.close();
  } finally {
    await setSignupMode(page, "single_user");
  }
});
