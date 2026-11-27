#!/usr/bin/env node
// Names every Playwright test that passed only on a retry, from a merged JSON report.
//
//   node scripts/flaky-tests.mjs results.json
//
// Writes the list to the GitHub job summary when there is one. With FAIL_ON_FLAKY=true it
// exits non-zero when any test was flaky, which is how a scheduled run turns a flake into an issue.

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** "file › title (project)" for each test the report marks flaky, in report order. */
export function flakyTests(report) {
  const found = [];
  const walk = (suite, file) => {
    const where = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === "flaky") found.push(`${where} › ${spec.title} (${test.projectName})`);
      }
    }
    for (const child of suite.suites ?? []) walk(child, where);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/flaky-tests.mjs <playwright-json-report>");
    process.exit(2);
  }
  const flaky = flakyTests(JSON.parse(readFileSync(path, "utf8")));
  const lines = flaky.length
    ? ["### E2E tests that passed only on a retry", "", ...flaky.map((name) => `- ${name}`)]
    : ["No e2e test needed a retry."];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (flaky.length && process.env.FAIL_ON_FLAKY === "true") {
    console.error(`${flaky.length} flaky test(s); give each one a backlog item and fix it rather than lean on the retry.`);
    process.exit(1);
  }
}
