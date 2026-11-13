import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.COSIMO_E2E_PORT ?? 8799);

// A pre-installed browser: the runner's Google Chrome in CI (#105), or one in an environment that
// can't download Playwright's pinned build.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // The other specs navigate by sidebar links, which sit behind the drawer on a phone.
      testIgnore: "mobile.e2e.ts",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath },
      },
    },
    {
      // iPhone 13 viewport and touch on Chromium (WebKit isn't installed everywhere).
      name: "mobile",
      testMatch: "mobile.e2e.ts",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        launchOptions: { executablePath },
      },
    },
  ],
  webServer: {
    command: `bun e2e/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
