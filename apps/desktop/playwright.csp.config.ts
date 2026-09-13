import { defineConfig, devices } from "@playwright/test";

/**
 * Release-CSP smoke test against a prod build (vite preview). Separate config
 * because the rest of the suite needs the dev server, and the policy under test
 * only exists once the bundle is built.
 *
 * Usage: pnpm --filter @pikos/desktop test:e2e:csp
 * Requires: VITE_TEST_MODE=true pnpm build (run before)
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4174",
    trace: "off",
    screenshot: "only-on-failure",
    timeout: 15_000,
  },
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: "csp-prod",
      use: { ...devices["Desktop Safari"] },
      grep: /@csp-prod/,
    },
  ],
  webServer: {
    command: "VITE_TEST_MODE=true pnpm vite preview --port 4174",
    url: "http://localhost:4174",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
