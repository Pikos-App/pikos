#!/usr/bin/env node
// Fail when an e2e spec declares a test that no Playwright project would pick up.
//
// Every project in playwright.config.ts (and playwright.perf.config.ts) is
// grep-scoped by tag — tier1/tier2/perf/recording/perf-prod. A test whose title
// carries none of those tags therefore runs in *no* project: it is not skipped,
// not reported, not failed. It simply never executes, and nothing in the suite
// says so. This guard is the thing that says so.
//
// Deliberately a text scan rather than `playwright test --list`: listing boots
// the Playwright runtime and wants browsers installed, which makes it unusable
// as a pre-commit gate. The specs are prettier-formatted, so the shapes below
// are stable enough to match mechanically.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "apps/desktop/e2e");

// Keep in sync with the `grep` of every project across both Playwright configs.
const KNOWN_TAGS = ["@tier1", "@tier2", "@perf-prod", "@perf", "@recording"];

// `test(`, `appTest(`, and their modifier chains (.only/.skip/.fixme/...).
// `.describe(`/`.use(`/`.beforeEach(` are handled separately below.
const MODIFIERS = "(?:only|skip|fixme|fail|slow)";
const TEST_RE = new RegExp(`^(\\s*)(?:appTest|test)(?:\\.${MODIFIERS})*\\s*\\(`);
const DESCRIBE_RE = new RegExp(
  `^(\\s*)(?:appTest|test)\\.describe(?:\\.${MODIFIERS}|\\.serial|\\.parallel|\\.configure)*\\s*\\(`
);

const hasTag = (text) => KNOWN_TAGS.some((tag) => text.includes(tag));

/**
 * The title is the first string literal after the opening paren — on the same
 * line for short declarations, on the next line once prettier wraps them. Only
 * the *first* literal is considered so a tag appearing in the test body (e.g. a
 * quick-add fixture string) can never satisfy the guard for a bare title.
 */
function titleAt(lines, index) {
  const head = lines[index].slice(lines[index].indexOf("(") + 1);
  const source = head.trim() === "" ? (lines[index + 1] ?? "") : head;
  return /(["'`])((?:\\.|(?!\1).)*)\1/.exec(source)?.[2] ?? "";
}

const failures = [];

for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"))) {
  const lines = readFileSync(join(E2E_DIR, file), "utf8").split("\n");
  // Open describe blocks, innermost last. A tag on a describe title covers every
  // test nested under it, so a block is only "untagged" if no ancestor is tagged.
  // Depth is tracked by indentation: prettier guarantees the closing `})` of a
  // block sits at the same column as its opening call.
  const describes = [];

  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    while (describes.length > 0 && line.trimStart().startsWith("}")) {
      if (indent > describes.at(-1).indent) break;
      describes.pop();
    }

    const describeMatch = DESCRIBE_RE.exec(line);
    if (describeMatch) {
      describes.push({ indent: describeMatch[1].length, tagged: hasTag(titleAt(lines, i)) });
      return;
    }

    if (!TEST_RE.test(line)) return;
    if (describes.some((d) => d.tagged)) return;
    const title = titleAt(lines, i);
    if (hasTag(title)) return;
    failures.push(`  apps/desktop/e2e/${file}:${i + 1}  ${title || "<unparsed title>"}`);
  });
}

if (failures.length > 0) {
  console.error(
    `${failures.length} e2e test(s) carry no project tag, so no Playwright project runs them:\n` +
      `${failures.join("\n")}\n\n` +
      `Add one of ${KNOWN_TAGS.join(", ")} to the test title (or to an enclosing describe).`
  );
  process.exit(1);
}
