import { defineConfig, devices } from "@playwright/test";

/**
 * Perf-only config that runs against a prod build (vite preview).
 * Thresholds in perf.prod.spec.ts match the actual quality bar.
 *
 * Usage: pnpm --filter @pikos/desktop test:e2e:perf:prod
 * Requires: VITE_TEST_MODE=true pnpm build (run before)
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // perf tests should run sequentially to avoid resource contention
  retries: 0, // flaky perf results shouldn't retry — investigate instead
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    screenshot: "only-on-failure",
    timeout: 15_000,
  },
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: "perf-prod",
      use: { ...devices["Desktop Safari"] },
      grep: /@perf-prod/,
    },
  ],
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite preview --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
