import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The desktop screen tour (e2e/screen-tour.spec.ts), once per theme.
 *
 * Its own config because the seed is read when Vite starts: the tour needs a
 * server launched with the demo workspace, a second with the first-run tutorial
 * and a third with a calendar's mirrors, none of which the suite's shared server
 * on 1421 can be.
 *
 * Usage: scripts/desktop-screen-tour.sh, or pnpm --filter @pikos/desktop screen:tour
 */

const TOUR_PORT = 1424;
const FIRST_RUN_PORT = 1425;
const SYNCED_PORT = 1426;

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: true,
  metadata: {
    firstRunURL: `http://localhost:${FIRST_RUN_PORT}`,
    syncedURL: `http://localhost:${SYNCED_PORT}`,
    tourOut:
      process.env["PIKOS_TOUR_OUT"] ??
      resolve(import.meta.dirname, "../../build/desktop-screen-tour"),
  },
  projects: (["light", "dark"] as const).map((theme) => ({
    grep: /@tour/,
    metadata: { theme },
    name: `tour-${theme}`,
    use: {
      ...devices["Desktop Safari"],
      colorScheme: theme,
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1440 },
    },
  })),
  reporter: [["list"]],
  retries: 0,
  testDir: "./e2e",
  timeout: 10 * 60_000,
  use: {
    actionTimeout: 5_000,
    baseURL: `http://localhost:${TOUR_PORT}`,
    trace: "off",
  },
  webServer: [
    {
      command: `VITE_TEST_MODE=true VITE_SEED=demo pnpm vite --port ${TOUR_PORT} --strictPort`,
      reuseExistingServer: false,
      timeout: 60_000,
      url: `http://localhost:${TOUR_PORT}`,
    },
    {
      command: `VITE_TEST_MODE=true VITE_SEED=tutorial pnpm vite --port ${FIRST_RUN_PORT} --strictPort`,
      reuseExistingServer: false,
      timeout: 60_000,
      url: `http://localhost:${FIRST_RUN_PORT}`,
    },
    {
      command: `VITE_TEST_MODE=true VITE_SEED=synced pnpm vite --port ${SYNCED_PORT} --strictPort`,
      reuseExistingServer: false,
      timeout: 60_000,
      url: `http://localhost:${SYNCED_PORT}`,
    },
  ],
  workers: Number(process.env["PIKOS_TOUR_WORKERS"] ?? 4),
});
