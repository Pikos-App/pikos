import { defineConfig, devices } from "@playwright/test";

/**
 * The marketing hero recording (e2e/record-hero.spec.ts), once per theme.
 *
 * Its own config for the same reason the tour has one: the seed is read when
 * Vite starts, so the recording needs a server launched with `VITE_SEED=marketing`.
 * The shared suite's server on 1421 carries no seed and `reuseExistingServer`
 * would silently hand back whatever is already listening, which is how this spec
 * came to fail against an empty calendar for a week without anyone noticing.
 *
 * Usage: pnpm --filter @pikos/desktop record:hero
 */

const RECORD_PORT = 1427;

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  projects: [
    {
      grep: /@recording/,
      name: "recording",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  reporter: [["list"]],
  retries: 0,
  testDir: "./e2e",
  timeout: 5 * 60_000,
  use: {
    baseURL: `http://localhost:${RECORD_PORT}`,
    trace: "off",
  },
  webServer: {
    command: `VITE_TEST_MODE=true VITE_SEED=marketing pnpm vite --port ${RECORD_PORT} --strictPort`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://localhost:${RECORD_PORT}`,
  },
  workers: 1,
});
