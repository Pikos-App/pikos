#!/usr/bin/env node
// Print which QA checklist rows a test takes, and fail on a claim that can't hold.
//
// A test takes a row by carrying the row's ID as a Playwright tag:
//   appTest("title", { tag: ["@GOLD-01"] }, async ({ app }) => { … })
// A row that takes N tests together says so on each of them, `@GOLD-01:2`. The
// release copy's automated marks are built from this output, never typed.
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      ["--filter", "@pikos/desktop", "exec", "playwright", "test", "--config", config, "--list", "--reporter=json"],
      { cwd: ROOT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdio: ["ignore", "ignore", "inherit"] }
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

const rows = readMaster(MASTER);
const onRealWriter = new Set(listTests("playwright.bridge.config.ts").map((t) => t.id));
const everyTest = listTests("playwright.config.ts");

const automated = {};
const declared = new Map();
const failures = [];
for (const test of everyTest) {
  for (const match of test.tags.map((tag) => ROW_TAG.exec(tag)).filter(Boolean)) {
    const [, row, parts = "1"] = match;
    if (!rows.has(row)) failures.push(`${row} is not a row in the master: ${test.id}`);
    else if (rows.get(row).manualForGood) failures.push(`${row} is manual for good: ${test.id}`);
    else if (!onRealWriter.has(test.id)) failures.push(`${row} is claimed by a test off the real writer: ${test.id}`);
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
    failures.push(`${row} declares ${[...counts][0]} test(s) and ${found} claim it: ${automated[row].join("; ")}`);
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
