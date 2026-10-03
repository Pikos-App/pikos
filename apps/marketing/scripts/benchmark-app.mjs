// Measures the app figures /speed shows and writes them to src/data/app.json.
//
//   node apps/marketing/scripts/benchmark-app.mjs [--launches N] [--sizes 2000,20000]
//     [--out <file>] [--baseline <file>] [--dir <scratch dir>] [--build | --skip-build]
//
//   node apps/marketing/scripts/benchmark-app.mjs --quick [--only open,switch] [--sizes 200000]
//
// --quick is for iterating: one launch per size with no warm-up or rests, five samples an action,
// printed beside the last quick run's. --only times just those areas: switch, open, search,
// scroll, edit and calendar. The app is rebuilt when its source is newer than the last build.
//
// Builds the desktop app with the in-app benchmark compiled in (a separate identity, so it never
// reads or writes your own app's settings), then launches it against each scratch workspace. Each
// launch times start-up, opening pages, searching and switching views in the real window, writes
// what it saw, and quits. benchmark.mjs times the database alone.
//
// Every launch starts from an untouched copy of its workspace, sizes take turns so a slow hour
// lands on all of them, and the first round is a discarded warm-up. Each size is then compared
// with 2,000 pages, the workspace most people have, launch by launch.

import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appCorpus,
  arg,
  conditions,
  REST_SECONDS,
  rest,
  ROOT,
  run,
  SIZES,
} from "./lib/conditions.mjs";

const out = arg("--out", join(ROOT, "apps/marketing/src/data/app.json"));
const DESKTOP = join(ROOT, "apps/desktop");
const APP = join(DESKTOP, "src-tauri/target/release/pikos");
const pikos = arg("--pikos", join(ROOT, "target/release/pikos"));
const dir = arg("--dir", join(tmpdir(), "pikos-bench"));
const quick = process.argv.includes("--quick");
const launches = Number(arg("--launches", quick ? "1" : "7"));
const warmUps = quick ? 0 : 1;
const restSeconds = Number(arg("--rest", quick ? "0" : String(REST_SECONDS)));
const sizes = arg("--sizes", quick ? "2000,200000" : SIZES.join(","))
  .split(",")
  .map(Number);
const only = arg("--only", "");
const samples = arg("--samples", quick ? "5" : "");
const baselinePath = arg("--baseline", null);
/** Lists, counts, the calendar and pages read a window at a time, with no full load at launch. */
const viewCache = process.argv.includes("--view-cache");
const flavor = viewCache ? "view-cache" : "full";
const LAST_QUICK = join(dir, viewCache ? "last-quick-view-cache.json" : "last-quick.json");
/** Which flavour the app at APP was built as, so switching flavours rebuilds. */
const BUILT_FLAVOR = join(dir, "built-flavor");
/** A launch that hasn't reported by then has hung, which is itself the result. */
const LAUNCH_TIMEOUT_MS = 10 * 60_000;
const REFERENCE_PAGES = 2_000;
/** A size passes when it's within the larger of these of 2,000 pages: a ratio, or two frames. */
const GATE_RATIO = 1.5;
const GATE_FRAMES_MS = 2 * (1000 / 60);
/** What each launch reports, keyed as the speed page reads them. */
const METRICS = {
  complete: (r) => r.completeMs,
  openDirect: (r) => r.openDirectMs,
  openPage: (r) => r.openHoveredMs,
  rename: (r) => r.renameMs,
  scroll: (r) => r.scrollMs,
  search: (r) => r.searchMs,
  switchCold: (r) => r.switchColdMs,
  switchSmartCold: (r) => r.switchSmartColdMs,
  switchSmartWarm: (r) => r.switchSmartWarmMs,
  switchView: (r) => [...(r.switchColdMs ?? []), ...(r.switchWarmMs ?? [])],
  switchWarm: (r) => r.switchWarmMs,
  weekCold: (r) => r.weekColdMs,
  weekWarm: (r) => r.weekWarmMs,
};
mkdirSync(dir, { recursive: true });

/** The newest change to anything the bench app is built from. */
function newestSource() {
  const roots = ["apps/desktop/src", "apps/desktop/src-tauri/src", "crates", "packages/core/src"];
  let newest = 0;
  for (const root of roots) {
    for (const file of readdirSync(join(ROOT, root), { recursive: true })) {
      if (String(file).includes("target")) continue;
      newest = Math.max(newest, statSync(join(ROOT, root, String(file))).mtimeMs);
    }
  }
  return newest;
}

const built = existsSync(APP) ? statSync(APP).mtimeMs : 0;
const builtFlavor = existsSync(BUILT_FLAVOR) ? readFileSync(BUILT_FLAVOR, "utf8").trim() : "full";
const build =
  process.argv.includes("--build") ||
  (!process.argv.includes("--skip-build") && (newestSource() > built || builtFlavor !== flavor));
run("cargo", ["build", "--release", "-p", "pikos-cli"], { cwd: ROOT, stdio: "ignore" });
if (build) {
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
    {
      cwd: DESKTOP,
      env: { ...process.env, VITE_BENCH: "true", VITE_VIEW_CACHE: String(viewCache) },
      stdio: "inherit",
    }
  );
  writeFileSync(BUILT_FLAVOR, flavor);
}

function quantile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.round(p * (sorted.length - 1))];
}

function summary(samples) {
  if (samples.length === 0) return null;
  return {
    ms: quantile(samples, 0.5),
    p99: quantile(samples, 0.99),
    max: Math.max(...samples),
    runs: samples.length,
  };
}

/** A fixed seed, so the same launches give the same interval. */
function seeded() {
  let state = 0x5eed;
  return (n) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % n;
  };
}

/**
 * How a size compares with 2,000 pages: the ratio of their launch medians and its 95% interval,
 * resampling whole launches, because a launch's samples share its machine state and aren't
 * independent of each other.
 */
function ratio(size, reference) {
  if (size.length === 0 || reference.length === 0) return null;
  const pick = seeded();
  const resample = (xs) =>
    quantile(
      Array.from(xs, () => xs[pick(xs.length)]),
      0.5
    );
  const ratios = Array.from({ length: 2_000 }, () => resample(size) / resample(reference));
  const base = quantile(reference, 0.5);
  const allowed = Math.max(GATE_RATIO, (base + GATE_FRAMES_MS) / base);
  const high = quantile(ratios, 0.975);
  return {
    ratio: quantile(size, 0.5) / base,
    low: quantile(ratios, 0.025),
    high,
    allowed,
    passes: high < allowed,
  };
}

function webContentPids() {
  try {
    return execFileSync("pgrep", ["-f", "com.apple.WebKit.WebContent"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .join(",");
  } catch {
    return "";
  }
}

function launch(pages, template, label) {
  const db = join(dir, `launch-${pages}.db`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
  copyFileSync(template, db, constants.COPYFILE_FICLONE);
  const report = join(dir, `report-${pages}.json`);
  rmSync(report, { force: true });
  console.log(`launching against ${pages} pages, ${label}`);
  const started = Date.now();
  const result = spawnSync(APP, [], {
    env: {
      ...process.env,
      PIKOS_BENCH_DB: db,
      PIKOS_BENCH_KNOWN_WEBKIT: webContentPids(),
      PIKOS_BENCH_ONLY: only,
      PIKOS_BENCH_OUT: report,
      PIKOS_BENCH_SAMPLES: samples,
    },
    killSignal: "SIGKILL",
    stdio: "ignore",
    timeout: LAUNCH_TIMEOUT_MS,
  });
  try {
    return JSON.parse(readFileSync(report, "utf8"));
  } catch {
    const seconds = Math.round((Date.now() - started) / 1000);
    return {
      error: result.error
        ? `no report after ${seconds} s (${result.error.code})`
        : `exited without a report after ${seconds} s`,
    };
  }
}

const templates = new Map(sizes.map((pages) => [pages, appCorpus(pikos, dir, pages)]));
const reports = new Map(sizes.map((pages) => [pages, []]));
let first = true;
for (let round = 1 - warmUps; round <= launches; round++) {
  // Each round starts one size further along, so no size always follows the heaviest one.
  const order = sizes.map((_, i) => sizes[(i + round + sizes.length) % sizes.length]);
  for (const pages of order) {
    // Every launch rests first: a launch at half a million pages leaves the laptop hot and short
    // of memory, and the next one would measure that.
    if (!first) rest(restSeconds);
    first = false;
    const label = round === 0 ? "warm-up" : `${round} of ${launches}`;
    const report = launch(pages, templates.get(pages), label);
    if (report.error) console.log(`  ${report.error}`);
    if (round > 0) reports.get(pages).push(report);
  }
}

const launchMedians = (pages, metric) =>
  (reports.get(pages) ?? [])
    .map((r) =>
      metric === "launch" ? r.launch?.firstRow : quantile(METRICS[metric](r) ?? [], 0.5)
    )
    .filter((v) => v != null);
const median = (xs) => (xs.length === 0 ? null : quantile(xs, 0.5));

const results = sizes.map((pages) => {
  const rs = reports.get(pages);
  // A launch that failed partway still reports what it timed before the failure.
  const ok = rs.filter((r) => r.launch != null);
  const ops = Object.fromEntries(
    Object.entries(METRICS).map(([key, get]) => [key, summary(ok.flatMap((r) => get(r) ?? []))])
  );
  const stageNames = [...new Set(ok.flatMap((r) => Object.keys(r.launch ?? {})))];
  return {
    seeded: pages,
    openPages: ok[0]?.openPages ?? null,
    launch: summary(launchMedians(pages, "launch")),
    ...ops,
    launchStages: Object.fromEntries(
      stageNames.map((s) => [s, median(ok.map((r) => r.launch?.[s]).filter((v) => v != null))])
    ),
    memory: {
      windowBytes: median(ok.map((r) => r.memory?.window?.bytes).filter((v) => v != null)),
      windowPeakBytes: median(ok.map((r) => r.memory?.window?.peakBytes).filter((v) => v != null)),
      appBytes: median(ok.map((r) => r.memory?.app?.bytes).filter((v) => v != null)),
    },
    vsReference: sizes.includes(REFERENCE_PAGES)
      ? Object.fromEntries(
          ["launch", ...Object.keys(METRICS)].map((m) => [
            m,
            ratio(launchMedians(pages, m), launchMedians(REFERENCE_PAGES, m)),
          ])
        )
      : null,
    errors: rs.filter((r) => r.error).map((r) => r.error),
  };
});

// The rebuild's other promise: nothing at 2,000 pages gets slower than it was before it.
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).sizes.find(
    (s) => s.seeded === REFERENCE_PAGES
  );
  const now = results.find((s) => s.seeded === REFERENCE_PAGES);
  if (baseline && now) {
    now.vsBaseline = Object.fromEntries(
      ["launch", ...Object.keys(METRICS)]
        .filter((m) => baseline[m] && now[m])
        .map((m) => [
          m,
          { before: baseline[m].ms, now: now[m].ms, passes: now[m].ms <= baseline[m].ms },
        ])
    );
  }
}

const record = { ...conditions(), launches, warmUps, sizes: results };
const previous =
  quick && existsSync(LAST_QUICK) ? JSON.parse(readFileSync(LAST_QUICK, "utf8")) : null;
if (quick) {
  writeFileSync(LAST_QUICK, `${JSON.stringify(record, null, 2)}\n`);
} else {
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

// Medians in milliseconds, with the last quick run's beside them when there is one.
const shown = ["launch", ...Object.keys(METRICS).filter((m) => m !== "switchView")];
for (const s of results) {
  const before = previous?.sizes.find((p) => p.seeded === s.seeded);
  console.log(
    `\n${s.seeded.toLocaleString("en-US")} pages${s.errors.length ? ` (${s.errors.length} errors)` : ""}`
  );
  for (const m of shown) {
    if (!s[m]) continue;
    const now = Math.round(s[m].ms);
    const was = before?.[m] ? Math.round(before[m].ms) : null;
    console.log(
      `  ${m.padEnd(16)} ${String(now).padStart(7)}${was == null ? "" : `   was ${was}`}`
    );
  }
}
