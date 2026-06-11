import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = 1421;

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
    {
      grep: /@recording/,
      name: "recording",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  // In CI the suite is sharded across a matrix; each shard emits a blob report
  // that the `e2e-report` job merges into one HTML report. Locally, write HTML
  // directly.
  reporter: process.env["CI"]
    ? [["list"], ["blob"]]
    : [["list"], ["html", { open: "never" }]],
  retries: process.env["CI"] ? 2 : 0,
  testDir: "./e2e",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    screenshot: "only-on-failure",
    timeout: 15_000,
    trace: "on-first-retry",
  },
  webServer: {
    command: `VITE_TEST_MODE=true pnpm vite --port ${E2E_PORT}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
    url: `http://localhost:${E2E_PORT}`,
  },
  workers: process.env["CI"] ? 1 : undefined,
});
