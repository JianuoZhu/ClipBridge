import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "node tests/e2e-server.js",
    url: "http://127.0.0.1:4173/healthz",
    reuseExistingServer: false,
    timeout: 15_000
  }
});
