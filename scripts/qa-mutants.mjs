#!/usr/bin/env node
// Mutation-test a release's changed code, so that a row marked automated has tests that
// were seen failing when its code broke.
//
//   pnpm qa:mutants <version> [--since <rev>] [--unit-only] [--reuse-unit] [--retry] [--limit <n>]
//                             [--uncommitted] [--swift-only]
//
// Two stages. Stryker (TypeScript) and cargo-mutants (Rust) break each changed line and
// run the unit tests. A mutant they miss is then applied to the working tree, and the
// real-writer e2e tests tagged with the rows its file reaches run against it; the first
// failure kills it. Most changed lines are interface code that only the e2e tests look
// at, so the unit stage alone would demote nearly every row it reached. What survives
// both is written to `releases/<version>/mutants.json`, each survivor with the automated
// rows its file reaches.
//
// The iPhone app's Swift gets the same two stages, from mutants generated here
// (`lib/swift-mutants.mjs`). A mutant in a package is applied and run against that package's
// host tests with `swift test`. What they miss, and every mutant in the app's own code, goes to
// the tier-1 UI tests on a simulator the run makes and deletes, after an incremental build. Only
// the UI tests whose coverage reaches the mutant's line run, which one coverage run per test
// measures and `mutants/ios-coverage.jsonl` keeps while the Swift is unchanged. A Swift
// survivor's rows are the ones its reaching UI tests, and its package's host tests, claim
// with `// qa:`. `--swift-only` runs just these stages, and `--limit` samples the mutants the
// simulator tries. Every Swift verdict is kept as it lands, so a stopped run carries on where
// it was. The app needs `scripts/build-ios-framework.sh` and `scripts/build-editor-bundle.sh`
// run first; the Xcode project is generated and built under `build/ios-mutants`.
//
// A survivor that changes nothing anyone could observe goes on the skip list where it
// lives, with the reason, so it is judged once rather than every release:
// `// Stryker disable next-line <Mutator>: <why>`, or an `exclude_re` in
// `.cargo/mutants.toml`. Where a comment can't single it out, `qa-mutants-skip.json`
// names it by what it changes, with the same reason.
//
// Stryker cannot load its vitest plugin from pnpm's linked store, so it runs from a flat
// install of pinned versions in `~/.cache`, made on first use. Outside the repo: inside it,
// pnpm adopts the folder into the workspace and rewrites the lockfile.
//
// Runs at the release candidate, where the release is cut, with its source committed: it
// edits source files in place, in the desktop crate's cargo-mutants stage, the e2e stage and
// both Swift stages, and puts each one back.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";

import {
  automatedRows,
  git,
  importGraph,
  isNoBehaviour,
  readMaster,
  ROOT,
  sectionsReachedBy,
} from "./lib/qa-rows.mjs";
import { swiftMutants } from "./lib/swift-mutants.mjs";

const STRYKER_HOME = join(homedir(), ".cache/pikos-stryker");
const STRYKER_PACKAGES = [
  "@stryker-mutator/core@10.0.0",
  "@stryker-mutator/vitest-runner@10.0.0",
  "typescript@5.9.3",
];

/** The source a run mutates, which must match the commit it reports on. */
const MUTATED = ["packages/core/src", "apps/desktop/src", "crates", "apps/desktop/src-tauri/src"];

/** Shipped code the run leaves alone because something else already proves it. The list cache
 *  only decides what to fetch and when: every bridge-lane test runs with the shadow check, which
 *  rereads each list in full and fails on any row the cache shows differently, and the speed gate
 *  measures the rest. Its survivors are fetches and timings no one using the app can see, and
 *  through the shared files it reaches they demoted nearly every row. */
const PROVEN_ELSEWHERE = [
  "apps/desktop/src/shared/viewCache/**",
  "packages/core/src/cache/**",
  "packages/core/src/storageReads.ts",
];

/** A logging call or a logger's name: nothing a person using the app sees, so a mutant there is
 *  never a gap in a row's test. */
const LOGGING = /\b(?:log|logger|console)\.(?:trace|debug|info|warn|error)\(|\bcreateLogger\(/;

function mutated(file) {
  return !isNoBehaviour(file) && !PROVEN_ELSEWHERE.some((glob) => matchesGlob(file, glob));
}

/** Where each TypeScript package's unit tests run from, and the source its results depend on:
 *  its own, and what its tests import. */
const TS_PACKAGES = [
  { dir: "packages/core", source: ["packages/core/src"] },
  { dir: "apps/desktop", source: ["packages/core/src", "apps/desktop/src"] },
];

/** The sandbox Stryker copies a package into skips these: the Rust build alone is tens
 *  of gigabytes, and none of them holds a unit test. */
const STRYKER_IGNORE = [
  "src-tauri/target",
  "src-tauri/gen",
  "e2e",
  "test-results",
  "playwright-report*",
  "blob-report",
  "dist",
  "coverage",
];

/** Rust roots: the crates workspace, and the desktop crate, which it excludes.
 *
 *  The desktop crate is mutated in place, one mutant at a time. cargo-mutants 27 tests a copy
 *  of the crate and makes its `[dependencies]` paths absolute but not its `[dev-dependencies]`,
 *  so `pikos-db`, declared in both (the dev one adds `test-support`), points two ways in the
 *  copy and the unmutated build fails. Declaring it once would ship the test fixtures. */
const RUST_ROOTS = [
  { dir: ".", inPlace: false, prefix: "crates/", source: ["crates"] },
  {
    dir: "apps/desktop/src-tauri",
    inPlace: true,
    prefix: "apps/desktop/src-tauri/",
    source: ["crates", "apps/desktop/src-tauri/src"],
  },
];

/** The Swift a run mutates, by where its tests run. A package's own tests run on the host, in
 *  seconds; the app's code needs a simulator. `PikosCore`'s own target is generated bindings, and the
 *  widgets are left out because no per-change test runs the extension, so every mutant there would
 *  survive unseen. */
const SWIFT_PACKAGES = [
  {
    dir: "apps/ios/PikosCore",
    source: "apps/ios/PikosCore/Sources/PikosSupport",
    tests: "PikosSupportTests",
  },
  {
    dir: "apps/ios/PikosEditorBridge",
    source: "apps/ios/PikosEditorBridge/Sources",
    tests: "PikosEditorBridgeTests",
  },
];
const SWIFT_SOURCE = [...SWIFT_PACKAGES.map((p) => p.source), "apps/ios/Pikos/Sources"];

/** The flows run on every change. The screen tour is a release's, and the speed run needs a phone. */
const UI_TEST_FILES = [
  "apps/ios/PikosUITests/Sources/TierOneTests.swift",
  "apps/ios/PikosUITests/Sources/TierOneWideTests.swift",
];
const SIMULATOR = { device: "iPhone 17 Pro", name: "Pikos Mutants" };
/** Seconds a UI test may take before it counts as hung; xcodebuild rounds it up to a minute. The
 *  slowest unmutated test, a monthly repeat, takes about three minutes under coverage. */
const UI_TEST_ALLOWANCE = 300;
const IOS_BUILD = join(ROOT, "build/ios-mutants");
const IOS_DERIVED = join(IOS_BUILD, "DerivedData");
const IOS_PROJECT = join(ROOT, "apps/ios/Pikos/Pikos.xcodeproj");
/** Build artifacts the app needs and no Xcode build makes, each from a script in `scripts/`. */
const IOS_PREREQUISITES = [
  ["build-ios-framework.sh", "apps/ios/PikosCore/Frameworks/PikosFFI.xcframework"],
  [
    "build-editor-bundle.sh",
    "apps/ios/PikosEditorBridge/Sources/PikosEditorBridge/Resources/editor.html",
  ],
];

const WORK = mkdtempSync(join(tmpdir(), "qa-mutants-"));
const SKIPPED = new Map(
  JSON.parse(readFileSync(join(ROOT, "scripts/qa-mutants-skip.json"), "utf8")).map((s) => [
    mutantKey(s),
    s.why,
  ])
);

/** The golden flow, which passes whenever the servers work. */
const SMOKE_GREP = tagPattern(["GOLD-01"]);

/** Must match the ports and zone in `playwright.bridge.config.ts`. */
const BRIDGE_PORT = 1423;
const VITE_PORT = 1428;
const ZONE = "America/New_York";
const DESKTOP = join(ROOT, "apps/desktop");
const BRIDGE_BIN = join(DESKTOP, "src-tauri/target/debug/pikos-e2e-bridge");

function parseArgs(argv) {
  const opts = {
    limit: null,
    resume: false,
    retry: false,
    uncommitted: false,
    reuseUnit: false,
    since: null,
    swiftOnly: false,
    unitOnly: false,
    version: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--unit-only") opts.unitOnly = true;
    else if (arg === "--reuse-unit") opts.reuseUnit = true;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--retry") opts.retry = true;
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--uncommitted") opts.uncommitted = true;
    else if (arg === "--swift-only") opts.swiftOnly = true;
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version)
    throw new Error(
      "usage: qa-mutants.mjs <version> [--since <rev>] [--unit-only] [--reuse-unit] [--retry] [--resume] [--limit <n>] [--uncommitted] [--swift-only]"
    );
  opts.since ??= git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  return opts;
}

/** Changed line ranges per shipped file, from a zero-context diff. */
function changedRanges(range, paths) {
  const diff = git("diff", "-U0", range, "--", ...paths);
  const ranges = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : null;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file || !mutated(file)) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0)
      (ranges.get(file) ?? ranges.set(file, []).get(file)).push([start, start + count - 1]);
  }
  return ranges;
}

function ensureStryker() {
  const bin = join(STRYKER_HOME, "node_modules/.bin/stryker");
  if (existsSync(bin)) return bin;
  mkdirSync(STRYKER_HOME, { recursive: true });
  writeFileSync(
    join(STRYKER_HOME, "package.json"),
    '{ "name": "pikos-stryker", "private": true }\n'
  );
  execFileSync(
    "pnpm",
    [
      "--dir",
      STRYKER_HOME,
      "add",
      "--ignore-workspace",
      "--config.node-linker=hoisted",
      ...STRYKER_PACKAGES,
    ],
    {
      stdio: "inherit",
    }
  );
  return bin;
}

/** The committed source a unit report measured, stamped beside it. `--reuse-unit` takes a
 *  report only while this still matches: a report from older source names lines that have
 *  since moved, and its mutants would land on rewritten code in the e2e stage. Per stage, so a
 *  fix in one package reruns that package alone. Null for a run of uncommitted work, so that
 *  run's reports are never reused. */
function sourceStamp(dirs, uncommitted) {
  return uncommitted
    ? null
    : dirs.map((dir) => `${dir} ${git("rev-parse", `HEAD:${dir}`)}`).join("\n");
}

function stampMatches(file, stamp) {
  try {
    return stamp !== null && readFileSync(file, "utf8") === stamp;
  } catch {
    return false;
  }
}

/** One Stryker run per package over its changed lines, its report kept in `reports` so a
 *  later run can `--reuse-unit` it; a package with no current report runs anyway. Returns every
 *  mutant, each with the text it replaces, so the e2e stage can apply it. */
function strykerStage(ranges, reports, reuse, uncommitted) {
  const mutants = [];
  for (const { dir: pkg, source } of TS_PACKAGES) {
    const mutate = [...ranges]
      .filter(([file]) => file.startsWith(`${pkg}/`) && /\.tsx?$/.test(file))
      .flatMap(([file, spans]) => spans.map(([a, b]) => `${file.slice(pkg.length + 1)}:${a}-${b}`));
    if (mutate.length === 0) continue;
    const report = join(reports, `${pkg.replace("/", "-")}.json`);
    const config = join(WORK, `${pkg.replace("/", "-")}.stryker.json`);
    const stamp = sourceStamp(source, uncommitted);
    if (!reuse || !existsSync(report) || !stampMatches(`${report}.source`, stamp)) {
      rmSync(`${report}.source`, { force: true });
      writeFileSync(
        config,
        JSON.stringify({
          cleanTempDir: true,
          concurrency: 2,
          coverageAnalysis: "perTest",
          ignorePatterns: STRYKER_IGNORE,
          jsonReporter: { fileName: report },
          mutate,
          plugins: [
            join(STRYKER_HOME, "node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"),
          ],
          reporters: ["progress", "json"],
          testRunner: "vitest",
        })
      );
      console.log(`\nStryker: ${mutate.length} changed span(s) in ${pkg}`);
      execFileSync(ensureStryker(), ["run", config], { cwd: join(ROOT, pkg), stdio: "inherit" });
      if (stamp !== null) writeFileSync(`${report}.source`, stamp);
    }
    for (const [file, entry] of Object.entries(JSON.parse(readFileSync(report, "utf8")).files)) {
      const lines = entry.source.split("\n");
      for (const m of entry.mutants) {
        const { end, start } = m.location;
        mutants.push({
          end,
          file: `${pkg}/${file}`,
          line: start.line,
          mutator: m.mutatorName,
          original: lines[start.line - 1].trim(),
          replacement: m.replacement ?? "",
          start,
          status: m.status,
        });
      }
    }
  }
  return mutants;
}

/** cargo-mutants over the diff, per Rust root. A missed mutant keeps its patch for the
 *  e2e stage. `--reuse-unit` reruns a root whose report is missing or stale, or whose unmutated
 *  build failed, and a run whose unmutated build fails stops: its report holds no mutants,
 *  so carrying on would read as a crate with nothing to test. */
function cargoStage(range, reports, reuse, uncommitted) {
  const mutants = [];
  for (const root of RUST_ROOTS) {
    const files = git("diff", "--name-only", range, "--", `${root.prefix}**/*.rs`)
      .split("\n")
      .filter((f) => f && mutated(f));
    if (files.length === 0) continue;
    const diff = git("diff", range, "--", ...files);
    // cargo-mutants reads the diff's paths relative to the root it runs in.
    const rel = root.dir === "." ? diff : diff.replaceAll(`/${root.prefix}`, "/");
    const diffFile = join(WORK, `${root.dir.replaceAll("/", "-")}.diff`);
    const out = join(reports, `${root.dir === "." ? "crates" : "src-tauri"}-mutants`);
    const outcomes = join(out, "mutants.out/outcomes.json");
    const baselineFailed = () =>
      JSON.parse(readFileSync(outcomes, "utf8")).outcomes.some(
        (o) => o.scenario === "Baseline" && o.summary !== "Success"
      );
    const stampFile = join(out, "source");
    const stamp = sourceStamp(root.source, uncommitted);
    if (!reuse || !existsSync(outcomes) || !stampMatches(stampFile, stamp) || baselineFailed()) {
      rmSync(stampFile, { force: true });
      writeFileSync(diffFile, `${rel}\n`);
      console.log(`\ncargo-mutants: ${root.prefix}`);
      const args = ["mutants", "--in-diff", diffFile, "--output", out];
      args.push(...(root.inPlace ? ["--in-place"] : ["--jobs", "2"]));
      if (root.dir === ".") args.push("--workspace");
      const run = spawnSync("cargo", args, { cwd: join(ROOT, root.dir), stdio: "inherit" });
      if (!existsSync(outcomes) && run.status !== 0) {
        throw new Error(`cargo-mutants failed in ${root.dir}`);
      }
      if (existsSync(outcomes) && baselineFailed()) {
        throw new Error(
          `cargo-mutants couldn't build ${root.dir} unmutated: ${join(out, "mutants.out/log/baseline.log")}`
        );
      }
      if (stamp !== null && existsSync(outcomes)) writeFileSync(stampFile, stamp);
    }
    if (!existsSync(outcomes)) continue;
    for (const o of JSON.parse(readFileSync(outcomes, "utf8")).outcomes) {
      if (o.scenario === "Baseline") continue;
      const m = o.scenario.Mutant;
      const status =
        o.summary === "CaughtMutant"
          ? "Killed"
          : o.summary === "MissedMutant"
            ? "Survived"
            : o.summary;
      mutants.push({
        diff: o.diff_path ? readFileSync(join(out, "mutants.out", o.diff_path), "utf8") : null,
        dir: root.dir,
        file: root.dir === "." ? m.file : `${root.prefix}${m.file}`,
        line: m.span.start.line,
        mutator: m.genre ?? "cargo-mutants",
        original: readFileSync(join(ROOT, root.dir, m.file), "utf8")
          .split("\n")
          [m.span.start.line - 1].trim(),
        replacement: m.replacement,
        status,
      });
    }
  }
  return mutants;
}

/** The file a mutant is applied to and its text before, written before the edit. The e2e loop
 *  waits on each test run synchronously, so no signal handler can run while it does: a stopped run
 *  is killed outright, and the next run puts the file back from here before anything else. */
const APPLIED = join(tmpdir(), "pikos-qa-mutant-applied.json");

function putBackLeftover() {
  if (!existsSync(APPLIED)) return;
  const { before, path } = JSON.parse(readFileSync(APPLIED, "utf8"));
  writeFileSync(path, before);
  rmSync(APPLIED);
  console.log(`put back ${path}, left mutated by a run that was stopped`);
}

/** Apply a mutant to its file and return a function that puts the file back. */
function apply(mutant) {
  const path = join(ROOT, mutant.file);
  const before = readFileSync(path, "utf8");
  writeFileSync(APPLIED, JSON.stringify({ before, path }));
  if (mutant.diff) {
    const where = mutant.dir === "." ? [] : [`--directory=${mutant.dir}`];
    // cargo-mutants writes the mutation's description where the new file's name goes.
    const target = mutant.diff.match(/^--- (.*)$/m)[1];
    const patch = mutant.diff.replace(/^\+\+\+ .*$/m, `+++ ${target}`);
    execFileSync("git", ["apply", "-p0", ...where, "-"], { cwd: ROOT, input: patch });
  } else {
    const lines = before.split("\n");
    const { end, start } = mutant;
    const head = lines.slice(0, start.line - 1);
    const first = lines[start.line - 1].slice(0, start.column - 1);
    const last = lines[end.line - 1].slice(end.column - 1);
    const tail = lines.slice(end.line);
    writeFileSync(path, [...head, first + mutant.replacement + last, ...tail].join("\n"));
  }
  return () => {
    writeFileSync(path, before);
    rmSync(APPLIED, { force: true });
  };
}

/** Browsers the e2e stage runs at once. Playwright's default, four on this laptop, held it at three
 *  cores until macOS throttled it, and a throttled run's five-second waits time out under unbroken
 *  code, which reads as a kill. Two halved the heat and doubled the time per mutant. */
const E2E_WORKERS = 3;

/** The e2e tests a mutant's rows claim, as one Playwright grep. */
function tagPattern(rows) {
  return `@(${rows.join("|")})(:\\d+)?(\\s|$)`;
}

function playwright(grep) {
  const run = spawnSync(
    "pnpm",
    [
      "--filter",
      "@pikos/desktop",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.bridge.config.ts",
      "--grep",
      grep,
      "--max-failures=1",
      `--workers=${E2E_WORKERS}`,
      "--reporter=dot",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, E2E_REUSE_BRIDGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPort(port) {
  for (let i = 0; i < 600; i++) {
    if (spawnSync("nc", ["-z", "localhost", String(port)]).status === 0) return;
    sleep(200);
  }
  throw new Error(`nothing listened on port ${port}`);
}

/** The e2e stage's two servers, started once rather than per mutant. A Rust mutant is
 *  in the bridge itself, so `rebuildBridge` builds and restarts it around one. Their output
 *  goes to `logDir`, the only record of why a run's tests started failing. */
function startServers(logDir) {
  for (const port of [BRIDGE_PORT, VITE_PORT]) {
    if (spawnSync("nc", ["-z", "localhost", String(port)]).status === 0) {
      throw new Error(`port ${port} is in use, likely a stopped run's server: stop it first`);
    }
  }
  const bridgeLog = openSync(join(logDir, "e2e-bridge.log"), "w");
  const viteLog = openSync(join(logDir, "e2e-vite.log"), "w");
  const build = () =>
    execFileSync(
      "cargo",
      [
        "build",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--features",
        "e2e-bridge",
        "--bin",
        "pikos-e2e-bridge",
      ],
      { cwd: DESKTOP, stdio: ["ignore", "ignore", "inherit"] }
    );
  const env = { ...process.env, TZ: ZONE };
  let bridge = null;
  const startBridge = () => {
    bridge = spawn(BRIDGE_BIN, [], {
      cwd: DESKTOP,
      detached: true,
      env,
      stdio: ["ignore", bridgeLog, bridgeLog],
    });
    waitForPort(BRIDGE_PORT);
  };
  build();
  startBridge();
  const vite = spawn("pnpm", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: DESKTOP,
    detached: true,
    env: { ...env, VITE_E2E_STORAGE: "bridge", VITE_TEST_MODE: "true" },
    stdio: ["ignore", viteLog, viteLog],
  });
  // Each server leads its own process group, so stopping it stops what `pnpm` started.
  const stop = (child) => child && process.kill(-child.pid);
  waitForPort(VITE_PORT);
  return {
    rebuildBridge() {
      stop(bridge);
      build();
      startBridge();
    },
    stop() {
      stop(bridge);
      stop(vite);
    },
  };
}

/** Run each unit survivor against the e2e tests of the rows its file reaches. The tests
 *  are first run on the unmutated tree, once per row set, so a failure is the mutant's
 *  and not a flaky test's.
 *
 *  A baseline that fails after others passed reruns the first one that passed. If that
 *  fails too, the servers broke rather than one row set's tests, and every kill since is
 *  suspect, so the stage stops. Without the check, broken servers read as every later
 *  mutant killed in the same few seconds and every later row set red. */
function e2eStage(survivors, rowsFor, logDir, progress) {
  const baselines = new Map();
  let canary = null;
  let reds = 0;
  const saveRed = (grep, output) => {
    const path = join(logDir, `e2e-red-${++reds}.log`);
    writeFileSync(path, `${grep}\n\n${output}`);
    return path;
  };
  const servers = startServers(logDir);
  let restore = null;
  const putBack = () => restore?.();
  try {
    for (const [i, mutant] of survivors.entries()) {
      const rows = rowsFor(mutant.file);
      if (rows.length === 0 || progress.done.has(i)) continue;
      const grep = tagPattern(rows);
      if (!baselines.has(grep)) {
        const { ok, output } = playwright(grep);
        baselines.set(grep, ok);
        if (ok) canary ??= grep;
        else {
          console.log(
            `  baseline red for ${mutant.file}'s rows; its survivors stay survivors (${saveRed(grep, output)})`
          );
          // Before any row set has passed, the smoke flow stands in for one.
          const check = canary ?? SMOKE_GREP;
          const recheck = playwright(check);
          if (!recheck.ok) {
            throw new Error(
              `the servers broke: ${check} fails too (${saveRed(check, recheck.output)}), so this run's e2e verdicts can't be trusted`
            );
          }
        }
      }
      if (!baselines.get(grep)) continue;
      restore = apply(mutant);
      try {
        // Vite's watcher has to see the edit before a page asks for the module.
        sleep(500);
        if (mutant.diff) servers.rebuildBridge();
        const started = Date.now();
        mutant.status = playwright(grep).ok ? "Survived" : "KilledByE2e";
        mutant.seconds = Math.round((Date.now() - started) / 1000);
      } finally {
        putBack();
        restore = null;
        sleep(500);
        if (mutant.diff) servers.rebuildBridge();
      }
      progress.record(i, mutant);
      console.log(
        `  ${i + 1}/${survivors.length} ${mutant.status} in ${mutant.seconds}s, ${rows.length} rows: ${mutant.file}:${mutant.line} ${mutant.mutator}`
      );
    }
  } finally {
    servers.stop();
  }
}

/** The e2e stage's verdicts, appended one per mutant as they land, so a run stopped partway
 *  resumes with `--resume` instead of starting the day over. A verdict counts only while the
 *  source and the specs match the run that wrote it, and a resumed entry must name the mutant
 *  now at its position, or the run refuses rather than pin a verdict on the wrong mutant. */
function e2eProgress(path, tried, resume, verdicts) {
  const header = JSON.stringify({
    count: tried.length,
    source: sourceStamp([...MUTATED, "apps/desktop/e2e"], false),
  });
  const done = new Set();
  if (resume) {
    const [first, ...entries] = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (first !== header) throw new Error(`${path} is from other source or another run`);
    for (const line of entries) {
      const e = JSON.parse(line);
      const m = tried[e.i];
      if (!m || m.file !== e.file || m.line !== e.line || m.mutator !== e.mutator) {
        throw new Error(`${path}: entry ${e.i + 1} names a different mutant than this run's`);
      }
      m.status = e.status;
      m.seconds = e.seconds;
      done.add(e.i);
      verdicts.record(e.i, m);
    }
  } else {
    writeFileSync(path, `${header}\n`);
  }
  let kept = 0;
  for (const [i, m] of tried.entries()) {
    const v = done.has(i) ? null : verdicts.kept(i);
    if (!v) continue;
    m.status = v.status;
    m.seconds = v.seconds;
    done.add(i);
    kept++;
  }
  if (kept > 0) console.log(`  kept ${kept} verdict(s) whose code and tests are unchanged`);
  return {
    done,
    record: (i, m) => {
      appendFileSync(
        path,
        `${JSON.stringify({ file: m.file, i, line: m.line, mutator: m.mutator, seconds: m.seconds, status: m.status })}\n`
      );
      verdicts.record(i, m);
    },
  };
}

function hashFile(file) {
  return createHash("sha1")
    .update(readFileSync(join(ROOT, file)))
    .digest("hex");
}

function hashOf(parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Every e2e verdict rests on the mutated file, the specs tagged with the rows the file reaches, and
 *  the e2e helpers every spec uses. */
function e2eVerdicts(path, tried, rowsFor) {
  const e2e = "apps/desktop/e2e";
  const files = readdirSync(join(ROOT, e2e), { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${e2e}/${f}`);
  const specs = files
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => ({
      hash: hashFile(f),
      rows: new Set(
        [...readFileSync(join(ROOT, f), "utf8").matchAll(/@([A-Z]+-\d+)/g)].map((t) => t[1])
      ),
    }));
  const helpers = files.filter((f) => !f.endsWith(".spec.ts")).map(hashFile);
  return verdictStore(path, tried, (m) => {
    const rows = rowsFor(m.file);
    const tied = specs.filter((s) => rows.some((r) => s.rows.has(r))).map((s) => s.hash);
    return hashOf([hashFile(m.file), ...helpers, ...tied]);
  });
}

/** Verdicts kept across runs and reused while `deps`, what a mutant's verdict rests on, is unchanged.
 *  Any of it changing re-proves the mutant, since a proof lasts only until its code or its test
 *  changes. A line can hold two identical mutants, so each is keyed by what it changes plus its
 *  occurrence. */
function verdictStore(path, tried, deps) {
  const seen = new Map();
  const keys = tried.map((m) => {
    const base = mutantKey(m);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
  const stored = new Map();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const v = JSON.parse(line);
      stored.set(v.key, v);
    }
  }
  return {
    kept(i) {
      const v = stored.get(keys[i]);
      return v && v.deps === deps(tried[i]) ? v : null;
    },
    record(i, m) {
      appendFileSync(
        path,
        `${JSON.stringify({ deps: deps(m), key: keys[i], seconds: m.seconds, status: m.status })}\n`
      );
    },
  };
}

/** Every Swift mutant on the changed lines, each with the package whose host tests can load it, or
 *  none for the app's own code, which only a simulator can run. */
function swiftMutantsIn(ranges) {
  const out = [];
  for (const [file, spans] of ranges) {
    if (!file.endsWith(".swift")) continue;
    const pkg = SWIFT_PACKAGES.find((p) => file.startsWith(`${p.source}/`)) ?? null;
    for (const m of swiftMutants(readFileSync(join(ROOT, file), "utf8"), spans)) {
      out.push({ ...m, file, pkg, status: pkg ? "Pending" : "NoCoverage" });
    }
  }
  return out;
}

function swiftFiles(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .filter((f) => f.endsWith(".swift") && !f.includes(".build/"))
    .map((f) => `${dir}/${f}`)
    .sort();
}

/** One mutant, or none, against a package's host tests. A mutant that hangs a test is a kill, as
 *  Stryker counts a timeout. */
function swiftPackageRun(pkg, log) {
  const out = openSync(log, "w");
  const run = (args) =>
    spawnSync("swift", [...args, "--package-path", pkg.dir], {
      cwd: ROOT,
      stdio: ["ignore", out, out],
      timeout: 600_000,
    });
  try {
    if (run(["build", "--build-tests"]).status !== 0) return "CompileError";
    const test = run(["test", "--skip-build", "--filter", pkg.tests]);
    if (test.error?.code === "ETIMEDOUT") return "Timeout";
    return test.status === 0 ? "Survived" : "Killed";
  } finally {
    closeSync(out);
  }
}

/** The Swift unit stage: every package mutant against its package's host tests, which take seconds
 *  where a simulator takes minutes. A verdict rests on the whole package, sources and tests. */
function swiftPackageStage(mutants, reports) {
  const log = join(reports, "swift-test.log");
  for (const pkg of SWIFT_PACKAGES) {
    const mine = mutants.filter((m) => m.pkg === pkg && m.status === "Pending");
    if (mine.length === 0) continue;
    console.log(`\nswift test: ${mine.length} mutant(s) in ${pkg.source}`);
    const tree = hashOf(swiftFiles(pkg.dir).map(hashFile));
    const verdicts = verdictStore(join(reports, "swift-unit-verdicts.jsonl"), mine, () => tree);
    let baselined = false;
    for (const [i, m] of mine.entries()) {
      const kept = verdicts.kept(i);
      if (kept) {
        m.status = kept.status;
        continue;
      }
      if (!baselined) {
        if (swiftPackageRun(pkg, log) !== "Survived") {
          throw new Error(`${pkg.dir}'s tests don't pass unmutated: ${log}`);
        }
        baselined = true;
      }
      const restore = apply(m);
      const started = Date.now();
      try {
        m.status = swiftPackageRun(pkg, log);
      } finally {
        restore();
      }
      m.seconds = Math.round((Date.now() - started) / 1000);
      verdicts.record(i, m);
      console.log(`  ${i + 1}/${mine.length} ${m.status} in ${m.seconds}s: ${m.file}:${m.line} ${m.mutator}`);
    }
  }
}

function xcrun(...args) {
  return execFileSync("xcrun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A simulator of the stage's own, made fresh: the UI tests leave state on the one they run on, and
 *  sharing one with a person's session moves it under them. One left by a stopped run is deleted. */
function createSimulator() {
  const { devices } = JSON.parse(xcrun("simctl", "list", "devices", "-j"));
  for (const d of Object.values(devices).flat()) {
    if (d.name === SIMULATOR.name) spawnSync("xcrun", ["simctl", "delete", d.udid]);
  }
  const runtime = JSON.parse(xcrun("simctl", "list", "runtimes", "-j"))
    .runtimes.filter((r) => r.isAvailable && r.platform === "iOS")
    .at(-1);
  if (!runtime) throw new Error("no iOS simulator runtime is installed");
  const id = xcrun("simctl", "create", SIMULATOR.name, SIMULATOR.device, runtime.identifier).trim();
  bootSimulator(id);
  return id;
}

function bootSimulator(id) {
  spawnSync("xcrun", ["simctl", "boot", id]);
  xcrun("simctl", "bootstatus", id, "-b");
}

function deleteSimulator(id) {
  spawnSync("xcrun", ["simctl", "shutdown", id]);
  spawnSync("xcrun", ["simctl", "delete", id]);
}

function xcodebuild(action, sim, args, log) {
  const out = openSync(log, "w");
  try {
    return spawnSync(
      "xcodebuild",
      [
        action,
        "-project",
        IOS_PROJECT,
        "-scheme",
        "Pikos",
        "-destination",
        `id=${sim}`,
        "-derivedDataPath",
        IOS_DERIVED,
        "-enableCodeCoverage",
        "YES",
        ...args,
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: ROOT, stdio: ["ignore", out, out], timeout: 1_800_000 }
    );
  } finally {
    closeSync(out);
  }
}

/** An incremental build of the app and its UI tests. xcodebuild now and then fails a build with no
 *  error at all, so a failure with no `error:` in it is tried once more before it counts. */
function buildApp(sim, log) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (xcodebuild("build-for-testing", sim, [], log).status === 0) return true;
    if (/\berror:/.test(readFileSync(log, "utf8"))) return false;
  }
  return false;
}

/** Runs UI tests, one simulator and one at a time, and returns each one's result from the bundle.
 *  Null when the bundle lacks one of them, which means the runner or the simulator failed rather
 *  than a test. */
function runUiTests(sim, tests, bundle, log) {
  rmSync(bundle, { force: true, recursive: true });
  xcodebuild(
    "test-without-building",
    sim,
    [
      ...tests.map((t) => `-only-testing:PikosUITests/${t.id}`),
      "-resultBundlePath",
      bundle,
      "-parallel-testing-enabled",
      "NO",
      "-test-timeouts-enabled",
      "YES",
      "-default-test-execution-time-allowance",
      String(UI_TEST_ALLOWANCE),
    ],
    log
  );
  if (!existsSync(bundle)) return null;
  const results = new Map();
  const walk = (node) => {
    if (node.nodeType === "Test Case") {
      results.set(node.nodeIdentifier.replace(/\(\)$/, ""), {
        result: node.result,
        seconds: node.durationInSeconds ?? 0,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  const run = spawnSync(
    "xcrun",
    ["xcresulttool", "get", "test-results", "tests", "--path", bundle],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (run.status !== 0) return null;
  for (const node of JSON.parse(run.stdout).testNodes) walk(node);
  return tests.every((t) => results.has(t.id)) ? results : null;
}

/** The UI tests a change is proven by on every commit, read from their sources. */
function uiTests() {
  return UI_TEST_FILES.flatMap((file) => {
    let suite = null;
    const tests = [];
    for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
      const opens = /^\s*(?:(?:final\s+)?class (\w+)\s*:|extension (\w+)\b)/.exec(line);
      if (opens) suite = opens[1] ?? opens[2];
      const fn = /^\s*(?:@MainActor\s+)?func (test\w+)\(/.exec(line)?.[1];
      if (fn && suite) tests.push({ file, fn, id: `${suite}/${fn}` });
    }
    return tests;
  });
}

function toRanges(lines) {
  const out = [];
  for (const n of lines) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
}

function fromRanges(text) {
  const out = new Set();
  for (const part of text.split(",").filter(Boolean)) {
    const [a, b = a] = part.split("-").map(Number);
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

/** The lines of mutated Swift a coverage bundle holds: which can run at all, and which ran. */
function coveredLines(bundle) {
  const run = spawnSync("xcrun", ["xccov", "view", "--archive", "--json", bundle], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`xccov couldn't read ${bundle}`);
  const executable = {};
  const executed = {};
  for (const [path, lines] of Object.entries(JSON.parse(run.stdout))) {
    const file = path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : null;
    if (!file || !SWIFT_SOURCE.some((dir) => file.startsWith(`${dir}/`))) continue;
    executable[file] = toRanges(lines.filter((l) => l.isExecutable).map((l) => l.line));
    const ran = lines.filter((l) => l.executionCount > 0).map((l) => l.line);
    if (ran.length > 0) executed[file] = toRanges(ran);
  }
  return { executable, executed };
}

/**
 * Which UI tests reach each line, from one coverage run per test, so a mutant runs only the tests
 * that can see it rather than the whole suite. Kept beside the reports and reused while every Swift
 * file the app builds from is unchanged, since a change anywhere can move what a test reaches; a run
 * stopped partway keeps the tests it finished.
 *
 * A test reaches a line when the nearest line at or above it that can run, ran: a condition split
 * over lines is counted at its first. A test that failed or skipped unmutated reaches nothing.
 */
function uiCoverage(sim, tests, reports) {
  const path = join(reports, "ios-coverage.jsonl");
  const source = hashOf(
    [...SWIFT_SOURCE, "apps/ios/PikosUITests/Sources"]
      .flatMap(swiftFiles)
      .concat("apps/ios/Pikos/project.yml")
      .map(hashFile)
  );
  const stored = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.source === source)
    : [];
  const byTest = new Map(stored.filter((e) => e.test).map((e) => [e.test, e]));
  let executable = stored.find((e) => e.executable)?.executable ?? null;
  const fresh = new Set();
  const bundle = join(IOS_BUILD, "coverage.xcresult");
  const todo = tests.filter((t) => !byTest.has(t.id));
  if (todo.length > 0) {
    console.log(`  coverage: ${todo.length} of ${tests.length} UI test(s) to measure`);
  }
  for (const t of todo) {
    const log = join(reports, "ios-test.log");
    const results = runUiTests(sim, [t], bundle, log);
    if (!results) throw new Error(`the coverage run of ${t.id} didn't finish: ${log}`);
    const { result, seconds } = results.get(t.id);
    const lines = coveredLines(bundle);
    if (!executable) {
      executable = lines.executable;
      appendFileSync(path, `${JSON.stringify({ executable, source })}\n`);
    }
    const entry = { executed: lines.executed, result, seconds, source, test: t.id };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    byTest.set(t.id, entry);
    fresh.add(t.id);
    console.log(`  ${t.id}: ${result} in ${Math.round(seconds)}s`);
  }
  rmSync(bundle, { force: true, recursive: true });
  const runnable = new Map(
    Object.entries(executable ?? {}).map(([file, r]) => [file, [...fromRanges(r)].sort((a, b) => b - a)])
  );
  const ran = new Map(
    tests.map((t) => [
      t.id,
      new Map(Object.entries(byTest.get(t.id).executed).map(([f, r]) => [f, fromRanges(r)])),
    ])
  );
  const passing = tests.filter((t) => byTest.get(t.id).result === "Passed");
  return {
    fresh,
    reach(file, line) {
      const at = runnable.get(file)?.find((n) => n <= line);
      if (at === undefined) return [];
      return passing.filter((t) => ran.get(t.id).get(file)?.has(at));
    },
    seconds: (t) => byTest.get(t.id).seconds,
  };
}

/** The rows each Swift test claims, from the `// qa:` lines the marks script reads. */
function swiftTestRows(automated) {
  const rows = new Map();
  for (const [row, ids] of Object.entries(automated)) {
    for (const id of ids) {
      const test = /^(apps\/ios\/\S+\.swift):\d+ (\w+)$/.exec(id);
      if (!test) continue;
      const key = `${test[1]}|${test[2]}`;
      (rows.get(key) ?? rows.set(key, new Set()).get(key)).add(row);
    }
  }
  return rows;
}

/**
 * The Swift UI stage: what the host tests missed, and the app's own code, against the UI tests that
 * reach it, on a simulator made for the run. Each mutant is applied, the app rebuilt incrementally,
 * and its tests run as `uiVerdict` orders them. Every test is baselined unmutated first; its coverage
 * run counts as that when it ran in this run. A red one is dropped, so its mutants survive unless
 * another test catches them.
 *
 * A run whose bundle is missing a test's result is the simulator failing, not a kill: the simulator
 * is restarted and the mutant tried again, and a second failure stops the stage rather than fill it
 * with kills nothing caused.
 */
function swiftUiStage(mutants, reports, opts) {
  const candidates = mutants.filter((m) => m.status === "Survived" || m.status === "NoCoverage");
  if (candidates.length === 0) return;
  for (const [what, file] of IOS_PREREQUISITES) {
    if (!existsSync(join(ROOT, file))) throw new Error(`the UI stage needs ${what}: ${file}`);
  }
  mkdirSync(IOS_BUILD, { recursive: true });
  execFileSync("xcodegen", ["generate", "--spec", "apps/ios/Pikos/project.yml", "--project", "apps/ios/Pikos"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const buildLog = join(reports, "ios-build.log");
  const testLog = join(reports, "ios-test.log");
  const bundle = join(IOS_BUILD, "mutant.xcresult");
  console.log(`\nUI stage: ${candidates.length} Swift mutant(s) the host tests missed or can't load`);
  const sim = createSimulator();
  let restore = null;
  try {
    if (!buildApp(sim, buildLog)) throw new Error(`the app doesn't build unmutated: ${buildLog}`);
    const tests = uiTests();
    const coverage = uiCoverage(sim, tests, reports);
    for (const m of candidates) m.tests = coverage.reach(m.file, m.line);
    const reached = candidates.filter((m) => m.tests.length > 0);
    const tried = opts.limit ? sample(reached, opts.limit) : reached;
    console.log(`  ${reached.length} reached by a UI test; trying ${tried.length}`);
    const uiFiles = swiftFiles("apps/ios/PikosUITests/Sources").map(hashFile);
    const verdicts = verdictStore(join(reports, "swift-ui-verdicts.jsonl"), tried, (m) =>
      hashOf([hashFile(m.file), ...uiFiles])
    );
    const todo = [];
    for (const [i, m] of tried.entries()) {
      const kept = verdicts.kept(i);
      if (kept) m.status = kept.status;
      else todo.push(i);
    }
    const unproven = [...new Set(todo.flatMap((i) => tried[i].tests))].filter(
      (t) => !coverage.fresh.has(t.id)
    );
    if (unproven.length > 0) {
      const results = runUiTests(sim, unproven, bundle, testLog);
      if (!results) throw new Error(`the baseline run didn't finish: ${testLog}`);
      const red = unproven.filter((t) => results.get(t.id).result !== "Passed");
      if (red.length > 0) {
        console.log(`  red unmutated, so dropped: ${red.map((t) => t.id).join(", ")}`);
        for (const m of tried) m.tests = m.tests.filter((t) => !red.includes(t));
      }
    }
    for (const i of todo) {
      const m = tried[i];
      if (m.tests.length === 0) continue;
      const started = Date.now();
      restore = apply(m);
      try {
        m.status = buildApp(sim, buildLog) ? uiVerdict(sim, m, coverage, bundle, testLog) : "CompileError";
      } finally {
        restore();
        restore = null;
      }
      m.seconds = Math.round((Date.now() - started) / 1000);
      verdicts.record(i, m);
      console.log(
        `  ${i + 1}/${tried.length} ${m.status} in ${m.seconds}s, ${m.tests.length} test(s): ${m.file}:${m.line} ${m.mutator}`
      );
    }
  } finally {
    restore?.();
    deleteSimulator(sim);
    rmSync(bundle, { force: true, recursive: true });
  }
}

/** xcodebuild can't stop at a test's first failure, so a mutant's tests run cheapest first in
 *  batches that double: a kill costs about the tests before it, and a survivor a handful of extra
 *  launches. */
function uiVerdict(sim, m, coverage, bundle, log) {
  const ordered = [...m.tests].sort((a, b) => coverage.seconds(a) - coverage.seconds(b));
  const batches = [];
  for (let at = 0, size = 1; at < ordered.length; at += size, size *= 2) {
    batches.push(ordered.slice(at, at + size));
  }
  for (const batch of batches) {
    let results = runUiTests(sim, batch, bundle, log);
    if (!results) {
      spawnSync("xcrun", ["simctl", "shutdown", sim]);
      bootSimulator(sim);
      results = runUiTests(sim, batch, bundle, log);
      if (!results) throw new Error(`the simulator failed twice running ${m.file}:${m.line}: ${log}`);
    }
    if (batch.some((t) => results.get(t.id).result === "Failed")) return "KilledByE2e";
  }
  return "Survived";
}

/** Names a mutant by what it changes rather than where, so a line moved by an edit above
 *  it is still the same mutant on the next run. */
function mutantKey(m) {
  return `${m.file}|${m.mutator}|${m.replacement}|${m.original}`;
}

/** The last run's outcome per mutant. A run written before outcomes were kept records only
 *  survivors, so every other mutant it saw counts as killed by e2e. */
function previousRun(path) {
  if (!existsSync(path)) throw new Error(`--retry needs a previous run at ${path}`);
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (run.outcomes) return new Map(Object.entries(run.outcomes));
  const survived = new Set(run.survivors.map(mutantKey));
  return { get: (key) => (survived.has(key) ? "Survived" : "KilledByE2e") };
}

/** Up to `n` mutants, taken a file at a time so a sample spans the diff. */
function sample(mutants, n) {
  const byFile = Map.groupBy(mutants, (m) => m.file);
  const picked = [];
  while (picked.length < n && [...byFile.values()].some((list) => list.length > 0)) {
    for (const list of byFile.values()) {
      if (list.length > 0 && picked.length < n) picked.push(list.shift());
    }
  }
  return picked;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  putBackLeftover();
  const until = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", ...MUTATED, ...SWIFT_SOURCE);
  if (dirty && !opts.uncommitted) {
    throw new Error(`source under test has uncommitted changes:\n${dirty}`);
  }
  const range = `${opts.since}..${until}`;
  // A check of work in progress mutates the files as they stand, not the commit.
  const diffBase = opts.uncommitted ? opts.since : range;
  const { sections } = readMaster();
  const automated = automatedRows();
  const graph = importGraph();

  const rowsByFile = new Map();
  const rowsFor = (file) => {
    if (!rowsByFile.has(file)) {
      const reached = sectionsReachedBy(file, sections, graph);
      rowsByFile.set(
        file,
        sections
          .filter((s) => reached.has(s.key))
          .flatMap((s) => s.rows.map((r) => r.id))
          .filter((id) => automated[id])
      );
    }
    return rowsByFile.get(file);
  };

  const reports = join(ROOT, ".agent/releases", opts.version, "mutants");
  mkdirSync(reports, { recursive: true });
  const ranges = changedRanges(diffBase, ["packages/core/src", "apps/desktop/src"]);
  const mutants = opts.swiftOnly
    ? []
    : [
        ...strykerStage(ranges, reports, opts.reuseUnit, opts.uncommitted),
        ...cargoStage(diffBase, reports, opts.reuseUnit, opts.uncommitted),
      ];
  // Reused reports can predate a scope change, so the scope is applied to them here too.
  const inScope = mutants.filter((m) => mutated(m.file));
  mutants.length = 0;
  mutants.push(...inScope);
  for (const m of mutants) {
    if (SKIPPED.has(mutantKey(m)) || LOGGING.test(m.original ?? "")) m.status = "Ignored";
  }
  const missed = mutants.filter((m) => m.status === "Survived" || m.status === "NoCoverage");
  const dest = join(ROOT, ".agent/releases", opts.version, "mutants.json");
  const previous = opts.retry ? previousRun(dest) : null;
  if (previous) {
    // The last run's e2e kills stand; only its survivors and anything new are tried again.
    for (const m of missed)
      if (previous.get(mutantKey(m)) === "KilledByE2e") m.status = "KilledByE2e";
  }
  const pending = missed.filter((m) => m.status !== "KilledByE2e");
  const tried = opts.limit
    ? sample(
        pending.filter((m) => rowsFor(m.file).length > 0),
        opts.limit
      )
    : pending;
  if (!opts.unitOnly && !opts.swiftOnly) {
    console.log(`\ne2e stage: ${tried.length} of ${missed.length} mutant(s) the unit tests missed`);
    const verdicts = e2eVerdicts(join(reports, "e2e-verdicts.jsonl"), tried, rowsFor);
    const progress = e2eProgress(join(reports, "e2e-progress.jsonl"), tried, opts.resume, verdicts);
    e2eStage(tried, rowsFor, reports, progress);
  }

  const swift = swiftMutantsIn(changedRanges(diffBase, SWIFT_SOURCE));
  for (const m of swift) {
    if (SKIPPED.has(mutantKey(m)) || LOGGING.test(m.original)) m.status = "Ignored";
  }
  swiftPackageStage(swift, reports);
  for (const m of swift) {
    const missedByHost = m.status === "Survived" || m.status === "NoCoverage";
    if (missedByHost && previous?.get(mutantKey(m)) === "KilledByE2e") m.status = "KilledByE2e";
  }
  if (!opts.unitOnly) swiftUiStage(swift, reports, opts);
  const testRows = swiftTestRows(automated);
  for (const m of swift) {
    const claims = (m.tests ?? []).map((t) => `${t.file}|${t.fn}`);
    if (m.pkg) claims.push(...[...testRows.keys()].filter((k) => k.startsWith(`${m.pkg.dir}/`)));
    m.rows = [...new Set(claims.flatMap((k) => [...(testRows.get(k) ?? [])]))].sort();
  }
  mutants.push(...swift);

  const survivors = mutants
    .filter((m) => m.status === "Survived" || m.status === "NoCoverage")
    .map((m) => ({
      file: m.file,
      line: m.line,
      mutator: m.mutator,
      original: m.original,
      replacement: m.replacement,
      rows: m.rows ?? rowsFor(m.file),
      status: m.status,
    }));
  const outcomes = Object.fromEntries(mutants.map((m) => [mutantKey(m), m.status]));
  const count = (s) => mutants.filter((m) => m.status === s).length;
  const result = {
    counts: {
      killedByE2e: count("KilledByE2e"),
      ignored: count("Ignored"),
      killedByUnit: count("Killed") + count("Timeout"),
      survived: survivors.length,
      total: mutants.length,
      unviable:
        mutants.length -
        survivors.length -
        count("Killed") -
        count("Timeout") -
        count("KilledByE2e") -
        count("Ignored"),
    },
    // A sample proves nothing about the rows it skipped, and work in progress nothing about
    // any commit, so the release copy reads neither.
    complete: !opts.limit && !opts.uncommitted && !opts.swiftOnly,
    e2e: !opts.unitOnly,
    outcomes,
    range,
    survivors,
  };
  mkdirSync(join(ROOT, ".agent/releases", opts.version), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(result, null, 2)}\n`);
  const demoted = new Set(survivors.flatMap((s) => s.rows));
  console.log(
    `\n${dest}\n${result.counts.total} mutants: ${result.counts.killedByUnit} killed by unit tests, ${result.counts.killedByE2e} by e2e, ${survivors.length} survived, demoting ${demoted.size} row(s).`
  );
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  rmSync(WORK, { force: true, recursive: true });
}
