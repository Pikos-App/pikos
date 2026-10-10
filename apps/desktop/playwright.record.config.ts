import { defineConfig, devices } from "@playwright/test";

/**
 * The marketing recordings, once per theme: `RECORD_TAKE` picks which (default
 * `hero`, e2e/record-hero.spec.ts).
 *
 * Its own config for the same reason the tour has one: the seed is read when Vite
 * starts, so each take needs a server launched with its own `VITE_SEED`. The shared
 * suite's server on 1421 carries no seed and `reuseExistingServer` would silently
 * hand back whatever is already listening, which is how the hero spec came to fail
 * against an empty calendar for a week without anyone noticing.
 *
 * Usage: pnpm --filter @pikos/desktop record:hero
 */

const RECORD_PORT = 1427;

const TAKES = {
  hero: { grep: /@recording/, seed: "marketing" },
} as const;

const takeName = process.env["RECORD_TAKE"] ?? "hero";
if (!(takeName in TAKES)) {
  throw new Error(`RECORD_TAKE must be one of ${Object.keys(TAKES).join(", ")}`);
}
const take = TAKES[takeName as keyof typeof TAKES];

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  projects: [
    {
      grep: take.grep,
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
    command: `VITE_TEST_MODE=true VITE_SEED=${take.seed} pnpm vite --port ${RECORD_PORT} --strictPort`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://localhost:${RECORD_PORT}`,
  },
  workers: 1,
});
