#!/usr/bin/env node
// Print which QA checklist rows a test takes, and fail on a claim that can't hold.
//
// A test takes a row by carrying the row's ID as a Playwright tag:
//   appTest("title", { tag: ["@GOLD-01"] }, async ({ app }) => { … })
// or, for a Rust test, which runs on the real writer by definition, an annotation on the line
// above its attribute:
//   // qa: NOTIF-02
//   #[tokio::test]
// or the same annotation above a unit test's `it(` or `test(`, which every commit and CI run.
// A row that takes N tests together says so on each of them, `@GOLD-01:2` or `qa: GOLD-01:2`,
// counted across both kinds. The release copy's automated marks are built from this output,
// never typed.
//
// A claim fails when the row isn't in the master, when the row is marked manual
// for good, when the test doesn't run on the real writer, or when a row's tests
// don't number what they declare. The writer check stops a mock-only pass from
// counting as a person's; the count stops a deleted test from leaving its
// partner claiming the whole row.
//
// Reads the master from the working tree, so it runs where the release is cut,
// not in CI.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = process.argv[2] ?? join(ROOT, ".agent/qa/full-qa-checklist.md");
const ROW_TAG = /^([A-Z]+-\d+)(?::(\d+))?$/;

function readMaster(path) {
  const rows = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^- \[[ x]\] \*\*([A-Z]+-\d+)\*\*/.exec(line);
    if (match) rows.set(match[1], { manualForGood: line.includes("· 🧑") });
  }
  return rows;
}

/** Every test a config would run, with its tags, without running anything. */
function listTests(config) {
  const dir = mkdtempSync(join(tmpdir(), "qa-marks-"));
  const out = join(dir, "list.json");
  try {
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@pikos/desktop",
        "exec",
        "playwright",
        "test",
        "--config",
        config,
        "--list",
        "--reporter=json",
      ],
      {
        cwd: ROOT,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
        stdio: ["ignore", "ignore", "inherit"],
      }
    );
    const tests = [];
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) {
        tests.push({ id: `${spec.file}:${spec.line} ${spec.title}`, tags: spec.tags });
      }
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of JSON.parse(readFileSync(out, "utf8")).suites) walk(suite);
    return tests;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** The scripts a CI workflow runs. A test that needs a real OS service is ignored by default and
 *  run by name from one of these, so its name appearing here is what makes its claim hold. */
function ciScriptText() {
  const dir = join(ROOT, ".github/workflows");
  const workflows = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  return [...new Set(workflows.match(/scripts\/[\w.-]+\.sh/g) ?? [])]
    .filter((script) => existsSync(join(ROOT, script)))
    .map((script) => readFileSync(join(ROOT, script), "utf8"))
    .join("\n");
}

/** Rust tests that claim a row, from the `// qa:` line above each one's test attribute. Every
 *  crate's tests run in CI and on push, so a claim needs a test that isn't ignored, or one a CI
 *  script runs by name. */
function rustClaims() {
  const ciScripts = ciScriptText();
  const claims = [];
  const roots = ["crates", "apps/desktop/src-tauri/src", "apps/desktop/src-tauri/bins"];
  for (const root of roots) {
    for (const rel of readdirSync(join(ROOT, root), { recursive: true })) {
      if (!rel.endsWith(".rs") || rel.includes("target/")) continue;
      const file = `${root}/${rel}`;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const claim = /^\s*\/\/ qa: (.+)$/.exec(line);
        if (!claim) return;
        const below = lines.slice(i + 1, i + 6).join("\n");
        const fn = /fn (\w+)/.exec(below);
        const where = `${file}:${i + 2}${fn ? ` ${fn[1]}` : ""}`;
        const tags = claim[1].split(/,\s*/);
        if (!/#\[(tokio::)?test/.test(below) || !fn)
          claims.push({ bad: "isn't above a test", id: where, tags });
        else if (/#\[ignore/.test(below) && !new RegExp(`\\b${fn[1]}\\b`).test(ciScripts))
          claims.push({ bad: "is on an ignored test no CI script runs", id: where, tags });
        else claims.push({ id: where, tags });
      });
    }
  }
  return claims;
}

/** Unit tests that claim a row, from the `// qa:` line above each `it(` or `test(`. */
function unitClaims() {
  const claims = [];
  for (const root of ["apps/desktop/src", "packages/core/src"]) {
    for (const rel of readdirSync(join(ROOT, root), { recursive: true })) {
      if (!/\.test\.tsx?$/.test(rel)) continue;
      const file = `${root}/${rel}`;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const claim = /^\s*\/\/ qa: (.+)$/.exec(line);
        if (!claim) return;
        const next = lines[i + 1] ?? "";
        const title = /^\s*(?:it|test)(\.\w+)?\(\s*(["'`])(.*?)\2/.exec(next);
        const where = `${file}:${i + 2}${title ? ` ${title[3]}` : ""}`;
        const tags = claim[1].split(/,\s*/);
        if (!title) claims.push({ bad: "isn't above an it( or test(", id: where, tags });
        else if (title[1] && title[1] !== ".each")
          claims.push({ bad: `is on a ${title[1]} test`, id: where, tags });
        else claims.push({ id: where, tags });
      });
    }
  }
  return claims;
}

const rows = readMaster(MASTER);
const realWriterTests = listTests("playwright.bridge.config.ts");
const onRealWriter = new Set(realWriterTests.map((t) => t.id));
/** The production bundle under the shipped policy, which only this lane loads; what the PROD rows
 *  check is a property of that bundle, not of the writer, so they are proven here instead. */
const onReleaseBundle = listTests("playwright.csp.config.ts");
const onMockLane = listTests("playwright.config.ts");
const mockIds = new Set(onMockLane.map((t) => t.id));
const everyTest = [
  ...onMockLane,
  // `@large` tests run on the real writer alone, so the mock lane's list never names them.
  ...realWriterTests.filter((t) => !mockIds.has(t.id)),
  ...onReleaseBundle.map((t) => ({ ...t, releaseBundle: true })),
];

const automated = {};
const declared = new Map();
const failures = [];
for (const test of everyTest) {
  for (const match of test.tags.map((tag) => ROW_TAG.exec(tag)).filter(Boolean)) {
    const [, row, parts = "1"] = match;
    if (!rows.has(row)) failures.push(`${row} is not a row in the master: ${test.id}`);
    else if (rows.get(row).manualForGood) failures.push(`${row} is manual for good: ${test.id}`);
    else if (test.releaseBundle && !row.startsWith("PROD-"))
      failures.push(
        `${row} is claimed by the release-bundle lane, which proves only PROD rows: ${test.id}`
      );
    else if (!test.releaseBundle && !onRealWriter.has(test.id))
      failures.push(`${row} is claimed by a test off the real writer: ${test.id}`);
    else {
      (automated[row] ??= []).push(test.id);
      (declared.get(row) ?? declared.set(row, new Set()).get(row)).add(Number(parts));
    }
  }
}
for (const test of [...rustClaims(), ...unitClaims()]) {
  for (const match of test.tags.map((tag) => ROW_TAG.exec(tag))) {
    if (!match) {
      failures.push(`a qa: line names something that isn't a row: ${test.id}`);
      continue;
    }
    const [, row, parts = "1"] = match;
    if (test.bad) failures.push(`${row}'s claim ${test.bad}: ${test.id}`);
    else if (!rows.has(row)) failures.push(`${row} is not a row in the master: ${test.id}`);
    else if (rows.get(row).manualForGood) failures.push(`${row} is manual for good: ${test.id}`);
    else {
      (automated[row] ??= []).push(test.id);
      (declared.get(row) ?? declared.set(row, new Set()).get(row)).add(Number(parts));
    }
  }
}
for (const [row, counts] of declared) {
  const found = automated[row].length;
  if (counts.size > 1) {
    failures.push(`${row}'s tests disagree on how many take it: ${[...counts].join(", ")}`);
  } else if (!counts.has(found)) {
    failures.push(
      `${row} declares ${[...counts][0]} test(s) and ${found} claim it: ${automated[row].join("; ")}`
    );
  } else {
    continue;
  }
  delete automated[row];
}

console.log(JSON.stringify({ automated }, null, 2));
if (failures.length > 0) {
  console.error(`${failures.length} row claim(s) can't hold:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
