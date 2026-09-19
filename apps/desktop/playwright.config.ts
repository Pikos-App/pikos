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
      grep: /@perf(?!-prod|-scale)/,
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
  // Per-test budget. `timeout` is not a `use` option — it sat there for a long
  // time, silently ignored, so the suite has always run on the 30s default.
  // Stated here at the value it has actually been passing under; tighten it
  // deliberately, with a run to back it, rather than as a typo fix.
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: {
    command: `VITE_TEST_MODE=true pnpm vite --port ${E2E_PORT}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
    url: `http://localhost:${E2E_PORT}`,
  },
  // Spread rather than `: undefined`, which exactOptionalPropertyTypes rejects.
  // Absent means Playwright's own default (half the cores); CI pins one worker
  // because the suite is already sharded across runners.
  ...(process.env["CI"] ? { workers: 1 } : {}),
});
