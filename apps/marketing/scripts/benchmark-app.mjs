// Measures the app figures /speed shows and writes them to src/data/app.json.
//
//   node apps/marketing/scripts/benchmark-app.mjs [--skip-build] [--launches N] [--dir <scratch dir>]
//
// Builds the desktop app with the in-app benchmark compiled in (a separate identity, so it never
// reads or writes your own app's settings), then launches it against each scratch workspace. Each
// launch times start-up, opening pages, searching and switching views in the real window, writes
// what it saw, and quits. benchmark.mjs times the database alone.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { arg, conditions, corpus, rest, ROOT, run, SIZES } from "./lib/conditions.mjs";

const OUT = join(ROOT, "apps/marketing/src/data/app.json");
const DESKTOP = join(ROOT, "apps/desktop");
const APP = join(DESKTOP, "src-tauri/target/release/pikos");
const pikos = arg("--pikos", join(ROOT, "target/release/pikos"));
const dir = arg("--dir", join(tmpdir(), "pikos-bench"));
const launches = Number(arg("--launches", "3"));
/** A launch that hasn't reported by then has hung, which is itself the result. */
const LAUNCH_TIMEOUT_MS = 5 * 60_000;
mkdirSync(dir, { recursive: true });

if (!process.argv.includes("--skip-build")) {
  console.log("building the bench app");
  run(
    "pnpm",
    [
      "tauri",
      "build",
      "--no-bundle",
      "--features",
      "bench",
      "--config",
      "src-tauri/tauri.conf.bench.json",
    ],
    { cwd: DESKTOP, env: { ...process.env, VITE_BENCH: "true" }, stdio: "inherit" }
  );
}

function summary(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.round(p * (sorted.length - 1))];
  return { ms: at(0.5), p99: at(0.99), max: sorted.at(-1), runs: sorted.length };
}

const sizes = [];
for (const [i, pages] of SIZES.entries()) {
  const db = corpus(pikos, dir, pages);
  if (i > 0) rest();
  const pooled = { launch: [], openPage: [], search: [], switchView: [] };
  const errors = [];
  let openPages = null;
  for (let n = 0; n < launches; n++) {
    // Every launch rests first, not only each size: a launch at half a million pages leaves the
    // laptop hot and short of memory, and the next one would measure that.
    if (n > 0) rest();
    console.log(`launching against ${pages} pages, ${n + 1} of ${launches}`);
    const out = join(dir, `app-${pages}-${n}.json`);
    rmSync(out, { force: true });
    const started = Date.now();
    const result = spawnSync(APP, [], {
      env: { ...process.env, PIKOS_BENCH_DB: db, PIKOS_BENCH_OUT: out },
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: LAUNCH_TIMEOUT_MS,
    });
    let report;
    try {
      report = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      const seconds = Math.round((Date.now() - started) / 1000);
      errors.push(
        result.error
          ? `no report after ${seconds} s (${result.error.code})`
          : `exited without a report after ${seconds} s`
      );
      continue;
    }
    if (report.error) errors.push(report.error);
    openPages = report.openPages ?? openPages;
    if (report.launchMs != null) pooled.launch.push(report.launchMs);
    pooled.openPage.push(...(report.openPageMs ?? []));
    pooled.search.push(...(report.searchMs ?? []));
    pooled.switchView.push(...(report.switchViewMs ?? []));
  }
  sizes.push({
    seeded: pages,
    openPages,
    ...Object.fromEntries(Object.entries(pooled).map(([k, v]) => [k, summary(v)])),
    errors,
  });
}

writeFileSync(OUT, `${JSON.stringify({ ...conditions(), launches, sizes }, null, 2)}\n`);
console.log(`wrote ${OUT}`);
