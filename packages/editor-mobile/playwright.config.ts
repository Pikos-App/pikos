import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

/**
 * Where to find Chromium, when Playwright's own resolution will not do.
 *
 * Some environments ship a pre-installed browser whose build number does not
 * match what this Playwright version expects, and cannot download the matching
 * one. Pointing at what is actually there beats failing to launch. Where
 * Playwright can resolve a browser itself — a developer machine, the CI
 * container — this returns undefined and normal resolution applies.
 */
function chromiumPath(): string | undefined {
  const override = process.env["CHROMIUM_PATH"];
  if (override) return override;
  const preinstalled = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  return existsSync(preinstalled) ? preinstalled : undefined;
}

// Drives the built editor in a real browser.
//
// This is not a substitute for M0 — the questions M0 asks (typing latency,
// keyboard behaviour, selection handles) are about WKWebView on a phone, and no
// desktop browser can answer them. What it does cover is everything *else* the
// editor does: that the bridge protocol works end to end, that documents
// round-trip unchanged, and that a malformed message is refused. Those would
// otherwise be discovered on device, where debugging costs far more.
//
// Chromium because WKWebView is WebKit and Chromium is what is available here.
// The gap is real and is the reason the device run still matters; it is much
// smaller than the gap between "untested" and "tested".
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:4319",
    // A phone-sized viewport so the safe-area and layout CSS is exercised at
    // roughly the size it will actually run at.
    ...devices["iPhone 13"],
    // Desktop Chromium cannot emulate the mobile user agent's engine, and
    // pretending otherwise would make failures confusing.
    isMobile: false,
    hasTouch: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
        // explicit `undefined` different from an absent key, and Playwright
        // wants the key absent when it should resolve the browser itself.
        launchOptions: { ...(chromiumPath() ? { executablePath: chromiumPath()! } : {}) },
      },
    },
  ],
  webServer: {
    command: "pnpm vite preview --port 4319 --strictPort",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
