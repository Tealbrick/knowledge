import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.KNOWLEDGE_E2E_BASE_URL || "http://127.0.0.1:5310",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  reporter: "line",
});
