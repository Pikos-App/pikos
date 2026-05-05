// screenshot-calendar.mjs — drive the desktop app via Playwright and capture
// the calendar in a matrix of (dayCount × density × sidebar) configurations.
//
// Used to validate calendar layout work without rebuilding/installing the
// Tauri shell. Output PNGs are NOT version-controlled — they exist purely so
// the agent (or you) can eyeball each scenario after a change.
//
// Usage:
//   pnpm --filter @pikos/desktop screenshot:calendar
//
// To target a single scenario (faster iteration):
//   pnpm --filter @pikos/desktop screenshot:calendar -- --only=7-normal
//
// Output: apps/desktop/.screenshots/<scenario>.png

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(__dirname, "..");
const OUT_DIR = resolve(DESKTOP_DIR, ".screenshots");

const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));
const { chromium } = requireFromDesktop("@playwright/test");

// Distinct port from the Tauri dev server (1420) and the e2e server (1421)
// so a running dev session and a running test suite don't clash.
const PORT = 1423;
const URL_BASE = `http://localhost:${PORT}`;

// Anchor every screenshot at the same Monday so the seed always lays out
// the same Mon→Sun ramp. Matches `record-hero.spec.ts` so seed behavior is
// already exercised at this clock value.
const REFERENCE_DATE = new Date("2026-03-16T09:00:00");

// Matrix of scenarios. Add/remove freely — keys become PNG filenames.
const SCENARIOS = [
  { name: "7-normal", dayCount: 7, density: "normal", sidebarCollapsed: false },
  { name: "7-compact", dayCount: 7, density: "compact", sidebarCollapsed: false },
  { name: "7-spacious", dayCount: 7, density: "spacious", sidebarCollapsed: false },
  { name: "7-normal-no-sidebar", dayCount: 7, density: "normal", sidebarCollapsed: true },
  { name: "5-normal", dayCount: 5, density: "normal", sidebarCollapsed: false },
  { name: "mf-normal", dayCount: "mf", density: "normal", sidebarCollapsed: false },
  { name: "3-normal", dayCount: 3, density: "normal", sidebarCollapsed: false },
  { name: "1-normal", dayCount: 1, density: "normal", sidebarCollapsed: false },
];

// ── CLI arg parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
const scenariosToRun = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (scenariosToRun.length === 0) {
  console.error(`No scenarios matched --only="${only?.join(",")}". Available:`);
  for (const s of SCENARIOS) console.error(`  ${s.name}`);
  process.exit(1);
}

// ── Vite dev server ─────────────────────────────────────────────────────────

console.log(`Starting Vite on :${PORT} with VITE_TEST_MODE=true VITE_SEED=calendar-colors…`);
const vite = spawn(
  "pnpm",
  ["vite", "--port", String(PORT), "--strictPort"],
  {
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      VITE_TEST_MODE: "true",
      VITE_SEED: "calendar-colors",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let viteExited = false;
vite.on("exit", (code) => {
  viteExited = true;
  if (code !== 0 && code !== null) {
    console.error(`Vite exited with code ${code}`);
  }
});

// Forward Vite errors so they don't get swallowed.
vite.stderr.on("data", (chunk) => {
  process.stderr.write(`[vite] ${chunk}`);
});

// Wait for "ready" — Vite prints "Local: …" when accepting connections.
await new Promise((resolveReady, rejectReady) => {
  const timeout = setTimeout(() => rejectReady(new Error("Vite startup timed out")), 30_000);
  vite.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    if (text.includes("Local:") || text.includes(`localhost:${PORT}`)) {
      clearTimeout(timeout);
      resolveReady();
    }
  });
  vite.on("exit", () => {
    clearTimeout(timeout);
    if (!viteExited) rejectReady(new Error("Vite died before ready"));
  });
});

// Give Vite an extra beat to finish wiring HMR before we navigate.
await new Promise((r) => setTimeout(r, 500));

// ── Playwright ──────────────────────────────────────────────────────────────

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
let writtenCount = 0;
try {
  for (const scenario of scenariosToRun) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });

    // Lock the in-browser clock so the seed produces a fully-populated week
    // every run, regardless of what day the script is invoked.
    await context.clock.install({ time: REFERENCE_DATE });

    // Pre-seed localStorage so the calendar opens in the desired state. Done
    // via initScript so it lands BEFORE React reads from useLocalStorage.
    await context.addInitScript(
      ({ dayCount, density, sidebarCollapsed, referenceDateIso }) => {
        localStorage.setItem("pikos:calendarDayCount", JSON.stringify(dayCount));
        localStorage.setItem("pikos:calendarDensity", JSON.stringify(density));
        localStorage.setItem("pikos:sidebarCollapsed", JSON.stringify(sidebarCollapsed));
        localStorage.setItem("pikos:rightPanel", JSON.stringify("calendar"));
        localStorage.setItem("pikos:calendarReferenceDate", JSON.stringify(referenceDateIso));
        // Smart-start scroll: drop user near 7am so the seeded morning events
        // are in frame on every density.
        localStorage.setItem("pikos:calendarScrollHour", "7");
      },
      {
        dayCount: scenario.dayCount,
        density: scenario.density,
        sidebarCollapsed: scenario.sidebarCollapsed,
        referenceDateIso: REFERENCE_DATE.toISOString(),
      }
    );

    const page = await context.newPage();
    await page.goto(URL_BASE, { waitUntil: "networkidle" });

    // Wait for calendar region to mount + at least one block to be present —
    // otherwise we'd snapshot a half-rendered grid on slower starts.
    await page.getByRole("region", { name: "Week calendar" }).waitFor({ state: "visible" });
    await page.locator("[data-cal-page-id]").first().waitFor({ state: "visible", timeout: 10_000 });
    // Let layout settle (ResizeObserver, scroll restore, font load).
    await page.waitForTimeout(400);

    const outPath = resolve(OUT_DIR, `${scenario.name}.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    writtenCount++;
    console.log(`  ✓ ${scenario.name} → ${outPath}`);

    await context.close();
  }
} finally {
  await browser.close();
  vite.kill("SIGINT");
  // Give it a moment to clean up the port.
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`\nWrote ${writtenCount} screenshot(s) to ${OUT_DIR}`);
