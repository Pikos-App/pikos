import { defineConfig, devices } from "@playwright/test";

/**
 * Scale benchmarks: the interface timed against corpora from 20 to 2,000,000 pages.
 *
 * Its own config rather than a project in the main one, because these are slow by design and must
 * never be swept into an ordinary `test:e2e:perf` run. Sequential, no retries, and a long timeout:
 * seeding two million rows in JavaScript is minutes, and a retry would only double that.
 *
 * Usage: pnpm --filter @pikos/desktop test:e2e:scale
 * Requires: VITE_TEST_MODE=true pnpm build (the webServer below runs the preview).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 600_000,
  use: {
    baseURL: "http://localhost:4174",
    trace: "off",
    screenshot: "off",
  },
  expect: { timeout: 60_000 },
  projects: [{ name: "scale", use: { ...devices["Desktop Safari"] }, grep: /@perf-scale/ }],
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite preview --port 4174",
    port: 4174,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
