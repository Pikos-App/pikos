#!/usr/bin/env node
// Fail when an e2e spec carries a lane tag that no longer means anything.
//
// Every test runs in the everyday suite against the real writer, `@smoke` adds it
// to pre-push, and `@mock-only` keeps it off the real writer. The tags these
// replaced still read as meaningful, so a test written from habit would carry
// `@tier1` expecting pre-push to run it, and nothing would say it didn't.
//
// A text scan rather than `playwright test --list`, which boots the Playwright
// runtime and wants browsers installed: too heavy for a pre-commit gate.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "apps/desktop/e2e");

const RETIRED = {
  "@bridge": "drop it: every test runs on the real writer unless tagged @mock-only",
  "@tier1": "use @smoke",
  "@tier2": "drop it: an untagged test is in the full suite",
};
const LITERAL_RE = /(["'`])(?:(?!\1).)*\1/g;
const RETIRED_RE = /@tier1\b|@tier2\b|@bridge\b/g;

const failures = [];
for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"))) {
  readFileSync(join(E2E_DIR, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const [literal] of line.matchAll(LITERAL_RE)) {
        for (const [tag] of literal.matchAll(RETIRED_RE)) {
          failures.push(`  apps/desktop/e2e/${file}:${i + 1}  ${tag}: ${RETIRED[tag]}`);
        }
      }
    });
}

if (failures.length > 0) {
  console.error(`${failures.length} retired lane tag(s) in the e2e specs:\n${failures.join("\n")}`);
  process.exit(1);
}
