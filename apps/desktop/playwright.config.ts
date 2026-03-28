import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    timeout: 15_000,
  },
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: "tier1",
      use: { ...devices["Desktop Safari"] },
      grep: /@tier1/,
    },
    {
      name: "tier2",
      use: { ...devices["Desktop Safari"] },
      grep: /@tier2/,
    },
  ],
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
