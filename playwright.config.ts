import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30000,
  fullyParallel: false,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:3100",
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100",
    url: `${process.env.TEST_BASE_URL ?? "http://127.0.0.1:3100"}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
})
