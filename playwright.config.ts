import { defineConfig } from "@playwright/test";

const port = Number(process.env.AI_NOTE_E2E_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("AI_NOTE_E2E_PORT is required; run Playwright through `npm run test:e2e`");
}

// The server remains bound to 127.0.0.1. Next 15 exposes Route Handler request
// URLs with the localhost authority, so the browser uses that equivalent loopback
// name to preserve the app's exact Host/URL security boundary.
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.mjs",
  outputDir: "test-results/playwright",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["list"],
    ["./e2e/support/evidence-reporter.ts"],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: baseURL,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "desktop-1440",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-390",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
    {
      name: "mobile-320",
      use: { browserName: "chromium", viewport: { width: 320, height: 700 } },
    },
  ],
});
