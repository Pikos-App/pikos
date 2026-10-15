#!/usr/bin/env node
// The release half of the speed gate: the formal benchmark published on /speed has to pass
// PKOS-0133, and has to have measured the code being released.
//
//   node scripts/check-speed-gate.mjs     prints one line for the release record, or fails
//
// An interaction passes at a size when its median is under 100 ms, or within the larger of 1.5x
// and two frames over its 2,000-page median. Launch keeps that ratio alone. The numbers count
// only from a clean tree whose commit no product code has changed since: run
// `node apps/marketing/scripts/benchmark-app.mjs` on the release commit to refresh them.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "apps/marketing/src/data/app.json");
const REFERENCE_PAGES = 2_000;
const INSTANT_MS = 100;
const RATIO = 1.5;
const TWO_FRAMES_MS = 2 * (1000 / 60);
/** What /speed shows, by its key in the data. */
const INTERACTIONS = ["openDirect", "search", "switchView", "complete", "rename", "weekCold"];
/** Code that runs in the app. A test file can't move a timing, so it doesn't stale the numbers. */
const PRODUCT_CODE = [
  "apps/desktop/src",
  "apps/desktop/src-tauri/src",
  "packages/core/src",
  "crates",
  ":(exclude)*_tests.rs",
  ":(exclude)*/tests.rs",
  ":(exclude)*/tests/*",
  ":(exclude)*.test.ts",
  ":(exclude)*.test.tsx",
];

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function allowed(reference, instant) {
  const ratioLimit = Math.max(reference * RATIO, reference + TWO_FRAMES_MS);
  return instant ? Math.max(INSTANT_MS, ratioLimit) : ratioLimit;
}

function main() {
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const problems = [];

  if (data.build.dirty) {
    problems.push(`measured on a tree with uncommitted changes (${data.build.commit})`);
  }
  let changed = [];
  try {
    changed = git("diff", "--name-only", `${data.build.commit}..HEAD`, "--", ...PRODUCT_CODE)
      .split("\n")
      .filter(Boolean);
  } catch {
    problems.push(`measured at ${data.build.commit}, which this checkout doesn't have`);
  }
  if (changed.length > 0) {
    problems.push(
      `product code changed since the measured commit ${data.build.commit}: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? `, and ${changed.length - 5} more` : ""}`
    );
  }

  const reference = data.sizes.find((s) => s.seeded === REFERENCE_PAGES);
  if (!reference) throw new Error(`no ${REFERENCE_PAGES}-page size in ${DATA}`);
  for (const size of data.sizes) {
    for (const [key, instant] of [["launch", false], ...INTERACTIONS.map((k) => [k, true])]) {
      const ms = size[key]?.ms;
      const base = reference[key]?.ms;
      if (ms == null || base == null) {
        problems.push(`no ${key} at ${size.seeded} pages`);
        continue;
      }
      const limit = allowed(base, instant);
      if (ms > limit) {
        problems.push(
          `${key} at ${size.seeded.toLocaleString("en-US")} pages: ${Math.round(ms)} ms, over ${Math.round(limit)} ms`
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error("Speed gate (PKOS-0133) fails:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      'Refresh with `node apps/marketing/scripts/benchmark-app.mjs` on the release commit, or set SKIP_SPEED="<why>" for a release that changes no product code.'
    );
    process.exit(1);
  }
  const largest = Math.max(...data.sizes.map((s) => s.seeded));
  console.log(
    `Speed gate passed: every action within PKOS-0133 from ${data.sizes[0].seeded} to ${largest.toLocaleString("en-US")} pages, measured ${data.measured} at ${data.build.commit}.`
  );
}

main();
