import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.join(import.meta.dirname, "web/src") } },
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.{ts,tsx}"],
    setupFiles: ["./web/src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true
  }
});
