import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

/**
 * Where to find Chromium when Playwright's own resolution will not do: some environments
 * ship a browser whose build does not match this Playwright and cannot download one. Returns
 * undefined where Playwright can resolve a browser itself.
 */
function chromiumPath(): string | undefined {
  const override = process.env["CHROMIUM_PATH"];
  if (override) return override;
  const preinstalled = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  return existsSync(preinstalled) ? preinstalled : undefined;
}

// Drives the built editor in Chromium, covering the bridge protocol, document round trips and
// malformed messages. It cannot answer WKWebView questions (typing latency, keyboard,
// selection handles): those need a device.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:4319",
    ...devices["iPhone 13"],
    // Desktop Chromium cannot emulate the mobile engine, so keep the emulation off.
    isMobile: false,
    hasTouch: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Spread: `exactOptionalPropertyTypes` makes an explicit `undefined` differ from an
        // absent key, and Playwright needs the key absent to resolve the browser itself.
        launchOptions: { ...(chromiumPath() ? { executablePath: chromiumPath()! } : {}) },
      },
    },
  ],
  webServer: {
    command: "pnpm vite preview --host 127.0.0.1 --port 4319 --strictPort",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
