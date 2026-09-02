import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/release",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    channel: process.env.PLAYWRIGHT_RELEASE_BROWSER_CHANNEL || undefined,
    headless: true,
    ignoreHTTPSErrors: false,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  }
});
