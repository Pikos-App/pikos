import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: !!process.env["CI"],
  fullyParallel: true,
  projects: [
    {
      grep: /@tier1/,
      name: "tier1",
      use: { ...devices["Desktop Safari"] },
    },
    {
      grep: /@tier2/,
      name: "tier2",
      use: { ...devices["Desktop Safari"] },
    },
    {
      grep: /@perf(?!-prod)/,
      name: "perf",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
  retries: process.env["CI"] ? 2 : 0,
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:1420",
    screenshot: "only-on-failure",
    timeout: 15_000,
    trace: "on-first-retry",
  },
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
    url: "http://localhost:1420",
  },
  workers: process.env["CI"] ? 1 : undefined,
});
