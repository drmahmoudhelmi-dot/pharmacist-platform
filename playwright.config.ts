import { defineConfig } from "@playwright/test";

const port = 3000;
// Only set locally when the installed Chromium build differs from the one this
// Playwright version expects. CI installs the matching browser instead.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  // Clears local per-IP rate-limit rows; every E2E request comes from 127.0.0.1.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 360, height: 780 },
    locale: "ar-EG",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    // Production server; `pnpm build` must have run first (CI does this).
    command: "pnpm start",
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
