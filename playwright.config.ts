import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  workers: 2,
  use: {
    baseURL: "http://localhost:5175",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx tests/e2e/real-server.ts",
      url: "http://127.0.0.1:3002/api/health/live",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "E2E_API_PORT=3002 pnpm dev:web --port 5175",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
