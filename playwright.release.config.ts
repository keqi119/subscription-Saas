import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/release",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: process.env.RELEASE_GATE_PLAYWRIGHT_OUTPUT_DIR ?? "test-results/release",
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    channel: process.env.PLAYWRIGHT_RELEASE_BROWSER_CHANNEL || undefined,
    headless: true,
    ignoreHTTPSErrors: false,
    screenshot: "only-on-failure",
    trace: "on",
    video: "off"
  }
});
