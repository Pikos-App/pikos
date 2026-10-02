// Measures the numbers /speed shows and writes them to src/data/benchmark.json.
//
//   node apps/marketing/scripts/benchmark.mjs [--pikos <binary>] [--dir <scratch dir>] [--runs N]
//
// Seeds one scratch workspace per corpus size with `pikos stress seed` (reusing any already in
// --dir), times each with `pikos stress bench --runs N`, and records the machine, the build and
// the date beside the figures, because a number without its conditions is not one anybody can
// check. The laptop it was built for is fanless, so it rests between corpora rather than measure
// its own heat.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = join(ROOT, "apps/marketing/src/data/benchmark.json");
const SIZES = [50, 2_000, 20_000, 200_000, 500_000];
const REST_SECONDS = 30;
const FRESH_UP_TO = 20_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const pikos = arg("--pikos", join(ROOT, "target/release/pikos"));
const dir = arg("--dir", join(tmpdir(), "pikos-bench"));
const runs = Number(arg("--runs", "20"));
mkdirSync(dir, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });

const hardware = JSON.parse(run("system_profiler", ["-json", "SPHardwareDataType"]))
  .SPHardwareDataType[0];
const machine = {
  model: hardware.machine_name,
  chip: hardware.chip_type,
  memory: hardware.physical_memory,
  os: `macOS ${run("sw_vers", ["-productVersion"]).trim()}`,
};
// The CLI crate keeps its own version number, so the release is named by the app's.
const appVersion = JSON.parse(
  readFileSync(join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
).version;
const commit = run("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).trim();
const dirty = run("git", ["-C", ROOT, "status", "--porcelain"]).trim() !== "";

const corpora = [];
for (const [i, pages] of SIZES.entries()) {
  const db = join(dir, `stress-${pages}.db`);
  // Each bench run adds pages of its own, which a big corpus never notices and a small one does,
  // so the small ones are seeded fresh. Reseeding 500,000 pages takes minutes, so those are reused.
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
  if (i > 0) execFileSync("sleep", [String(REST_SECONDS)]);
  console.log(`timing ${pages} pages, ${runs} runs`);
  const bench = JSON.parse(
    run(pikos, ["--db", db, "stress", "bench", "--runs", String(runs), "--json"])
  );
  corpora.push({
    seeded: pages,
    pages: bench.pages,
    ops: Object.fromEntries(
      bench.timings.map((t) => [t.op, { ms: t.ms, p95: t.p95_ms, max: t.max_ms }])
    ),
  });
}

const data = {
  measured: new Date().toISOString().slice(0, 10),
  machine,
  build: { version: `Pikos ${appVersion}`, commit, dirty, profile: "release" },
  runs,
  corpora,
};
writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${OUT}`);
