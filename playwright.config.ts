import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // open: "never" — レポートサーバーの自動起動でローカル実行がブロックされるのを防ぐ。
  // CI の失敗時 artifact 収集は playwright-report/ を参照する（.github/workflows/ci.yml）
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    // build 込みのため通常の起動より長めに取る
    timeout: 180_000,
  },
});
