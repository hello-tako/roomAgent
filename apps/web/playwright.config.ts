import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "pnpm exec wrangler d1 migrations apply ai-company-os --local --config wrangler.local.jsonc && pnpm exec wrangler dev --config wrangler.local.jsonc --port 8787 --ip 127.0.0.1 --local",
      cwd: "../api",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { WRANGLER_SEND_METRICS: "false", CI: "true" },
    },
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_LOCAL_FIXTURE: "true" },
    },
  ],
});
