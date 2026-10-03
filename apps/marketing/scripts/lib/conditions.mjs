// What both speed benchmarks share: the corpus sizes, the scratch workspaces, and the
// conditions written beside every figure, because a number without them is not one anybody can
// check.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SIZES = [50, 2_000, 20_000, 200_000, 500_000];
/** The laptop these were built for is fanless, so it rests between sizes rather than measure its
 *  own heat. */
export const REST_SECONDS = 30;
const FRESH_UP_TO = 20_000;

export function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

export const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });

export const rest = (seconds = REST_SECONDS) => {
  if (seconds > 0) execFileSync("sleep", [String(seconds)]);
};

/** The scratch workspace for one size, seeded with `pikos stress seed` if it isn't there. The CLI
 *  bench adds pages each run, which a big corpus never notices and a small one does, so the small
 *  ones are seeded fresh; reseeding 500,000 pages takes minutes, so those are reused. */
export function corpus(pikos, dir, pages) {
  const db = join(dir, `stress-${pages}.db`);
  if (pages <= FRESH_UP_TO) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
  }
  if (!existsSync(db)) {
    console.log(`seeding ${pages} pages`);
    run(pikos, [
      "--db",
      db,
      "stress",
      "seed",
      "--pages",
      String(pages),
      "--large-pages",
      "0",
      "--json",
    ]);
  }
  return db;
}

/** The app benchmark's workspace for one size: folders, dates around today, done pages and
 *  series, so the views it switches between have something in them. Seeded again each day, since
 *  its dates are spread around the day it was seeded, or when the seeder changes, and copied fresh
 *  for every launch. */
export function appCorpus(pikos, dir, pages) {
  const today = new Date().toLocaleDateString("en-CA");
  const seeder = createHash("sha256")
    .update(readFileSync(join(ROOT, "crates/pikos-cli/src/stress.rs")))
    .digest("hex")
    .slice(0, 12);
  const name = `app-${pages}-${today}-${seeder}.db`;
  const db = join(dir, name);
  for (const old of readdirSync(dir)) {
    if (old.startsWith(`app-${pages}-`) && !old.startsWith(name)) {
      rmSync(join(dir, old), { force: true });
    }
  }
  if (!existsSync(db)) {
    console.log(`seeding ${pages} pages`);
    const building = `${db}.building`;
    run(pikos, [
      "--db",
      building,
      "stress",
      "seed",
      "--pages",
      String(pages),
      "--large-pages",
      "0",
      "--shape",
      "mixed",
      "--today",
      today,
      "--json",
    ]);
    renameSync(building, db);
  }
  return db;
}

export function conditions() {
  const hardware = JSON.parse(run("system_profiler", ["-json", "SPHardwareDataType"]))
    .SPHardwareDataType[0];
  // The CLI crate keeps its own version number, so the release is named by the app's.
  const appVersion = JSON.parse(
    readFileSync(join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
  ).version;
  return {
    measured: new Date().toISOString().slice(0, 10),
    machine: {
      model: hardware.machine_name,
      chip: hardware.chip_type,
      memory: hardware.physical_memory,
      os: `macOS ${run("sw_vers", ["-productVersion"]).trim()}`,
    },
    build: {
      version: `Pikos ${appVersion}`,
      commit: run("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).trim(),
      dirty: run("git", ["-C", ROOT, "status", "--porcelain"]).trim() !== "",
      profile: "release",
    },
  };
}
