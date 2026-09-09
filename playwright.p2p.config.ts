import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "p2p.spec.ts",
  testIgnore: [],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { ...base.use, baseURL: "http://127.0.0.1:4183" },
  webServer: { command: "node tests/e2e-server.js", url: "http://127.0.0.1:4183/healthz", reuseExistingServer: false, timeout: 20_000 },
});
