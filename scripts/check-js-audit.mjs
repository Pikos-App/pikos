#!/usr/bin/env node
// Fail on a high or critical advisory in a JS dependency that ships, unless it has been
// judged and written down.
//
//   node scripts/check-js-audit.mjs
//
// `pnpm audit` has no ignore list, so run bare it either fails forever on toolchain noise
// or reports into a log nobody reads. This compares its findings, runtime dependencies
// only (`--prod`; nothing under devDependencies ships), against
// `js-audit-accepted.json`: each entry is an advisory someone judged, why it doesn't
// reach a user, and the date the judgment runs out. A new advisory fails the day it
// lands, and an expired judgment fails until someone looks again.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPTED = join(ROOT, "scripts/js-audit-accepted.json");
const GATED = new Set(["high", "critical"]);

const run = spawnSync("pnpm", ["audit", "--prod", "--json"], { cwd: ROOT, encoding: "utf8" });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`pnpm audit returned no report:\n${run.stderr || run.stdout}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const accepted = new Map(JSON.parse(readFileSync(ACCEPTED, "utf8")).map((e) => [e.id, e]));
const found = new Map();
for (const advisory of Object.values(report.advisories ?? {})) {
  if (GATED.has(advisory.severity)) found.set(advisory.github_advisory_id, advisory);
}

const problems = [];
for (const [id, advisory] of found) {
  const entry = accepted.get(id);
  const what = `${id} ${advisory.severity} in ${advisory.module_name}: ${advisory.title}`;
  if (!entry) problems.push(`new: ${what}`);
  else if (entry.until < today) problems.push(`judged until ${entry.until}, look again: ${what}`);
}
const gone = [...accepted.keys()].filter((id) => !found.has(id));

if (gone.length > 0) {
  console.log(`No longer reported, so these can leave js-audit-accepted.json: ${gone.join(", ")}`);
}
if (problems.length > 0) {
  console.error(
    `${problems.length} advisory(ies) in shipped dependencies need a decision:\n  ${problems.join("\n  ")}\n` +
      "Upgrade past it, or add it to scripts/js-audit-accepted.json with why it doesn't reach a user and an until date."
  );
  process.exit(1);
}
console.log(`[js-audit] ${found.size} high or critical advisory(ies), all judged`);
