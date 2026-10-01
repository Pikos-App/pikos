#!/usr/bin/env node
// Mutation-test a release's changed code, so that a row marked automated has tests that
// were seen failing when its code broke.
//
//   pnpm qa:mutants <version> [--since <rev>] [--unit-only] [--reuse-unit] [--limit <n>]
//
// Two stages. Stryker (TypeScript) and cargo-mutants (Rust) break each changed line and
// run the unit tests. A mutant they miss is then applied to the working tree, and the
// real-writer e2e tests tagged with the rows its file reaches run against it; the first
// failure kills it. Most changed lines are interface code that only the e2e tests look
// at, so the unit stage alone would demote nearly every row it reached. What survives
// both is written to `releases/<version>/mutants.json`, where `qa-release-copy.mjs`
// demotes the automated rows each survivor's file reaches.
//
// A survivor that changes nothing anyone could observe goes on the skip list where it
// lives, with the reason, so it is judged once rather than every release:
// `// Stryker disable next-line <Mutator>: <why>`, or an `exclude_re` in
// `.cargo/mutants.toml`.
//
// Stryker cannot load its vitest plugin from pnpm's linked store, so it runs from a flat
// install of pinned versions in `node_modules/.cache`, made on first use.
//
// Runs at the release candidate, where the release is cut, with its source committed: it
// edits source files in place during the e2e stage and puts each one back.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  automatedRows,
  git,
  importGraph,
  isNoBehaviour,
  readMaster,
  ROOT,
  sectionsReachedBy,
} from "./lib/qa-rows.mjs";

const STRYKER_HOME = join(ROOT, "node_modules/.cache/pikos-stryker");
const STRYKER_PACKAGES = [
  "@stryker-mutator/core@10.0.0",
  "@stryker-mutator/vitest-runner@10.0.0",
  "typescript@5.9.3",
];

/** The source a run mutates, which must match the commit it reports on. */
const MUTATED = ["packages/core/src", "apps/desktop/src", "crates", "apps/desktop/src-tauri/src"];

/** Where each TypeScript package's unit tests run from. */
const TS_PACKAGES = ["packages/core", "apps/desktop"];

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

/** Rust roots: the crates workspace, and the desktop crate, which it excludes. */
const RUST_ROOTS = [
  { dir: ".", prefix: "crates/" },
  { dir: "apps/desktop/src-tauri", prefix: "apps/desktop/src-tauri/" },
];

const WORK = mkdtempSync(join(tmpdir(), "qa-mutants-"));

/** Must match the ports and zone in `playwright.bridge.config.ts`. */
const BRIDGE_PORT = 1423;
const VITE_PORT = 1428;
const ZONE = "America/New_York";
const DESKTOP = join(ROOT, "apps/desktop");
const BRIDGE_BIN = join(DESKTOP, "src-tauri/target/debug/pikos-e2e-bridge");

function parseArgs(argv) {
  const opts = { limit: null, reuseUnit: false, since: null, unitOnly: false, version: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--unit-only") opts.unitOnly = true;
    else if (arg === "--reuse-unit") opts.reuseUnit = true;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version)
    throw new Error(
      "usage: qa-mutants.mjs <version> [--since <rev>] [--unit-only] [--reuse-unit] [--limit <n>]"
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
    if (!hunk || !file || isNoBehaviour(file)) continue;
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
    ["--dir", STRYKER_HOME, "add", "--config.node-linker=hoisted", ...STRYKER_PACKAGES],
    {
      stdio: "inherit",
    }
  );
  return bin;
}

/** One Stryker run per package over its changed lines, its report kept in `reports` so a
 *  later run can `--reuse-unit` it. Returns every mutant, each with the text it replaces,
 *  so the e2e stage can apply it. */
function strykerStage(ranges, reports, reuse) {
  const mutants = [];
  for (const pkg of TS_PACKAGES) {
    const mutate = [...ranges]
      .filter(([file]) => file.startsWith(`${pkg}/`) && /\.tsx?$/.test(file))
      .flatMap(([file, spans]) => spans.map(([a, b]) => `${file.slice(pkg.length + 1)}:${a}-${b}`));
    if (mutate.length === 0) continue;
    const report = join(reports, `${pkg.replace("/", "-")}.json`);
    const config = join(WORK, `${pkg.replace("/", "-")}.stryker.json`);
    if (reuse) {
      if (!existsSync(report)) throw new Error(`no unit-stage report to reuse at ${report}`);
    } else {
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
 *  e2e stage. */
function cargoStage(range, reports, reuse) {
  const mutants = [];
  for (const root of RUST_ROOTS) {
    const files = git("diff", "--name-only", range, "--", `${root.prefix}**/*.rs`)
      .split("\n")
      .filter((f) => f && !isNoBehaviour(f));
    if (files.length === 0) continue;
    const diff = git("diff", range, "--", ...files);
    // cargo-mutants reads the diff's paths relative to the root it runs in.
    const rel = root.dir === "." ? diff : diff.replaceAll(`/${root.prefix}`, "/");
    const diffFile = join(WORK, `${root.dir.replaceAll("/", "-")}.diff`);
    const out = join(reports, `${root.dir === "." ? "crates" : "src-tauri"}-mutants`);
    const outcomes = join(out, "mutants.out/outcomes.json");
    if (!reuse) {
      writeFileSync(diffFile, `${rel}\n`);
      console.log(`\ncargo-mutants: ${root.prefix}`);
      const args = ["mutants", "--in-diff", diffFile, "--output", out, "--jobs", "2"];
      if (root.dir === ".") args.push("--workspace");
      const run = spawnSync("cargo", args, { cwd: join(ROOT, root.dir), stdio: "inherit" });
      if (!existsSync(outcomes) && run.status !== 0) {
        throw new Error(`cargo-mutants failed in ${root.dir}`);
      }
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

/** Apply a mutant to its file and return a function that puts the file back. */
function apply(mutant) {
  const path = join(ROOT, mutant.file);
  const before = readFileSync(path, "utf8");
  if (mutant.diff) {
    const where = mutant.dir === "." ? [] : [`--directory=${mutant.dir}`];
    execFileSync("git", ["apply", ...where, "-"], { cwd: ROOT, input: mutant.diff });
  } else {
    const lines = before.split("\n");
    const { end, start } = mutant;
    const head = lines.slice(0, start.line - 1);
    const first = lines[start.line - 1].slice(0, start.column - 1);
    const last = lines[end.line - 1].slice(end.column - 1);
    const tail = lines.slice(end.line);
    writeFileSync(path, [...head, first + mutant.replacement + last, ...tail].join("\n"));
  }
  return () => writeFileSync(path, before);
}

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
      "--reporter=dot",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, E2E_REUSE_BRIDGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return run.status === 0;
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
 *  in the bridge itself, so `rebuildBridge` builds and restarts it around one. */
function startServers() {
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
    bridge = spawn(BRIDGE_BIN, [], { cwd: DESKTOP, detached: true, env, stdio: "ignore" });
    waitForPort(BRIDGE_PORT);
  };
  build();
  startBridge();
  const vite = spawn("pnpm", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: DESKTOP,
    detached: true,
    env: { ...env, VITE_E2E_STORAGE: "bridge", VITE_TEST_MODE: "true" },
    stdio: "ignore",
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
 *  and not a flaky test's. */
function e2eStage(survivors, rowsFor) {
  const baselines = new Map();
  const servers = startServers();
  let restore = null;
  const putBack = () => restore?.();
  process.on("SIGINT", () => {
    putBack();
    servers.stop();
    process.exit(130);
  });
  try {
    for (const [i, mutant] of survivors.entries()) {
      const rows = rowsFor(mutant.file);
      if (rows.length === 0) continue;
      const grep = tagPattern(rows);
      if (!baselines.has(grep)) {
        const green = playwright(grep);
        baselines.set(grep, green);
        if (!green)
          console.log(`  baseline red for ${mutant.file}'s rows; its survivors stay survivors`);
      }
      if (!baselines.get(grep)) continue;
      restore = apply(mutant);
      try {
        // Vite's watcher has to see the edit before a page asks for the module.
        sleep(500);
        if (mutant.diff) servers.rebuildBridge();
        const started = Date.now();
        mutant.status = playwright(grep) ? "Survived" : "KilledByE2e";
        mutant.seconds = Math.round((Date.now() - started) / 1000);
      } finally {
        putBack();
        restore = null;
        sleep(500);
        if (mutant.diff) servers.rebuildBridge();
      }
      console.log(
        `  ${i + 1}/${survivors.length} ${mutant.status} in ${mutant.seconds}s, ${rows.length} rows: ${mutant.file}:${mutant.line} ${mutant.mutator}`
      );
    }
  } finally {
    servers.stop();
  }
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
  const until = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", ...MUTATED);
  if (dirty) throw new Error(`source under test has uncommitted changes:\n${dirty}`);
  const range = `${opts.since}..${until}`;
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
  const ranges = changedRanges(range, ["packages/core/src", "apps/desktop/src"]);
  const mutants = [
    ...strykerStage(ranges, reports, opts.reuseUnit),
    ...cargoStage(range, reports, opts.reuseUnit),
  ];
  const missed = mutants.filter((m) => m.status === "Survived" || m.status === "NoCoverage");
  const tried = opts.limit
    ? sample(
        missed.filter((m) => rowsFor(m.file).length > 0),
        opts.limit
      )
    : missed;
  if (!opts.unitOnly) {
    console.log(`\ne2e stage: ${tried.length} of ${missed.length} mutant(s) the unit tests missed`);
    e2eStage(tried, rowsFor);
  }

  const survivors = mutants
    .filter((m) => m.status === "Survived" || m.status === "NoCoverage")
    .map(({ file, line, mutator, original, replacement, status }) => ({
      file,
      line,
      mutator,
      original,
      replacement,
      rows: rowsFor(file),
      status,
    }));
  const count = (s) => mutants.filter((m) => m.status === s).length;
  const result = {
    counts: {
      killedByE2e: count("KilledByE2e"),
      killedByUnit: count("Killed") + count("Timeout"),
      survived: survivors.length,
      total: mutants.length,
      unviable:
        mutants.length -
        survivors.length -
        count("Killed") -
        count("Timeout") -
        count("KilledByE2e"),
    },
    // A sampled run measures the stage; it proves nothing about the rows it skipped.
    complete: !opts.limit,
    e2e: !opts.unitOnly,
    range,
    survivors,
  };
  const dest = join(ROOT, ".agent/releases", opts.version, "mutants.json");
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
