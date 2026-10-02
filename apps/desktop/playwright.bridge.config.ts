import { defineConfig, devices } from "@playwright/test";

import type { StorageLane } from "./e2e/fixtures";
import { largeTemplatePath } from "./e2e/largeWorkspace";
import { MOCK_ONLY, OWN_CONFIG_TAGS } from "./e2e/tags";

// The same spec bodies as the mock lane, against the real Rust writer and a real
// SQLite file per test. Every test runs here unless it is tagged @mock-only.
const E2E_PORT = 1428;
const BRIDGE_PORT = 1423;
// The browser and the writer must agree on the zone, as the webview and the app do
// in production. calendar-sync.spec.ts pins this one, so it is the lane's too.
const ZONE = "America/New_York";

export default defineConfig<{ storage: StorageLane }>({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: !!process.env["CI"],
  fullyParallel: true,
  projects: [
    {
      grepInvert: new RegExp(`${MOCK_ONLY.source}|${OWN_CONFIG_TAGS.source}`),
      name: "bridge",
      use: { ...devices["Desktop Safari"], storage: "bridge", timezoneId: ZONE },
    },
  ],
  reporter: process.env["CI"]
    ? [["list"], ["blob"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report-bridge" }]],
  retries: process.env["CI"] ? 2 : 0,
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: [
    {
      // Reused only when E2E_REUSE_BRIDGE is set, by a caller that built and started the
      // bridge itself: a bridge left running from an older build would test old code.
      command: `TZ=${ZONE} PIKOS_E2E_LARGE_TEMPLATE=${largeTemplatePath(ZONE)} cargo run --manifest-path src-tauri/Cargo.toml --features e2e-bridge --bin pikos-e2e-bridge`,
      port: BRIDGE_PORT,
      reuseExistingServer: process.env["E2E_REUSE_BRIDGE"] === "1",
      stderr: "pipe",
      // A cold local build of the app crate takes minutes; CI builds it in a step first.
      timeout: 600_000,
    },
    {
      command: `VITE_TEST_MODE=true VITE_E2E_STORAGE=bridge pnpm vite --port ${E2E_PORT} --strictPort`,
      reuseExistingServer: !process.env["CI"],
      timeout: 30_000,
      url: `http://localhost:${E2E_PORT}`,
    },
  ],
});
