#!/usr/bin/env node
/**
 * Pikos seed CLI — run any seed scenario against a SQLite workspace.
 *
 * Usage:
 *   pnpm seed <scenario> [db-path] [--force]
 *
 * Scenarios:
 *   dst        PST vs PDT edge cases (around US spring-forward)
 *   stress     Heavy load: many folders, pages, schedules
 *   realistic  Believable day-to-day life (work, personal, reading)
 *   demo       Polished data for screenshots and demo videos
 *   tutorial   Default onboarding content for first launch
 *
 * Options:
 *   --force    Delete the seed marker page and re-seed even if already run
 *
 * Examples:
 *   pnpm seed demo
 *   pnpm seed stress ~/.local/share/com.pikos.app/default.sqlite
 *   SEED_PAGES=1000 pnpm seed stress
 *   pnpm seed tutorial --force
 */

import { run as dst } from "./seed-dst.ts";
import { run as stress } from "./seed-stress.ts";
import { run as realistic } from "./seed-realistic.ts";
import { run as demo } from "./seed-demo.ts";
import { run as tutorial } from "./seed-tutorial.ts";
import { defaultDbPath, openDb } from "./_db.ts";

const SCENARIOS: Record<string, (dbPath: string) => void> = {
  dst,
  stress,
  realistic,
  demo,
  tutorial,
};

const MARKERS: Record<string, string> = {
  dst: "⚙️ [seed-dst] PST vs PDT edge cases",
  stress: "⚙️ [seed-stress] Stress test marker",
  realistic: "⚙️ [seed-realistic] Realistic life marker",
  demo: "⚙️ [seed-demo] Demo data marker",
  tutorial: "Welcome to Pikos 👋",
};

function printHelp(): void {
  console.log(`
Pikos seed CLI

  Usage: pnpm seed <scenario> [db-path] [--force]

  Scenarios:
    dst         PST vs PDT DST edge cases
    stress      Heavy load (many folders, pages, schedules)
    realistic   Believable day-to-day life
    demo        Polished data for screenshots / demo videos
    tutorial    Default onboarding content

  Options:
    --force     Re-seed even if already run (deletes marker page first)

  Examples:
    pnpm seed demo
    pnpm seed stress
    pnpm seed tutorial --force
    SEED_PAGES=2000 pnpm seed stress
`);
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "");
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");

  const scenario = positional[0];
  const dbPath = positional[1] ?? defaultDbPath();

  if (!scenario || scenario === "--help" || scenario === "-h") {
    printHelp();
    process.exit(scenario ? 0 : 1);
  }

  const runner = SCENARIOS[scenario];
  if (!runner) {
    console.error(`\n  Unknown scenario: '${scenario}'\n`);
    console.error(`  Available: ${Object.keys(SCENARIOS).join(", ")}\n`);
    process.exit(1);
  }

  // --force: delete marker page so the seed runs again
  if (force) {
    const marker = MARKERS[scenario];
    if (marker) {
      try {
        const db = openDb(dbPath);
        const result = db.prepare("DELETE FROM pages WHERE title = ?").run(marker);
        db.close();
        if (result.changes > 0) {
          console.log(`  --force: deleted marker page, re-seeding…`);
        }
      } catch {
        // DB may not exist yet — that's fine, seed will create it
      }
    }
  }

  runner(dbPath);
}

main();
