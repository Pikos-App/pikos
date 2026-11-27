import assert from "node:assert/strict";
import { test } from "node:test";
import { prBodyProblems } from "./check-pr-body.mjs";

const GOOD = `Main's iOS job failed on runners that list no simulator yet. This makes the job wait for one.

## What changes

- **The iOS job waits for a simulator.** It polls \`simctl\` for two minutes and builds for the one it finds by id.

## Evidence

Main failed twice on "Unable to find a device", and a rerun on the same image passed.

## Try by hand

A runner with no simulator at all can't be forced, so the timeout branch hasn't run.
`;

test("a description in the shape passes", () => {
  assert.deepEqual(prBodyProblems("ci(ios): the iOS job waits for a simulator", GOOD), []);
});

test("the title follows the commit convention", () => {
  assert.equal(prBodyProblems("Fix the iOS job", GOOD).length, 1);
  assert.equal(prBodyProblems("ci(ios): Waits for a simulator", GOOD).length, 1);
  assert.deepEqual(prBodyProblems("release: v1.0.0", GOOD), []);
});

test("the opening is one or two plain sentences with no code", () => {
  const long = GOOD.replace("This makes the job wait for one.", "This makes it wait. It picks by id. It times out.");
  assert.match(prBodyProblems("ci: x", long).join(), /runs 4 sentences/);
  const coded = GOOD.replace("no simulator yet", "no `simctl` device yet");
  assert.match(prBodyProblems("ci: x", coded).join(), /names code/);
  assert.match(prBodyProblems("ci: x", GOOD.replace(/^.*\n\n/, "")).join(), /has to open/);
});

test("abbreviations and code don't count as sentence ends", () => {
  const body = GOOD.replace("This makes the job wait for one.", "This makes it wait, e.g. for two minutes.");
  assert.deepEqual(prBodyProblems("ci: x", body), []);
});

test("Evidence and What changes are required, and other headings aren't allowed", () => {
  assert.match(prBodyProblems("ci: x", GOOD.replace("## Evidence", "## Testing")).join(), /"## Testing" isn't one/);
  assert.match(prBodyProblems("ci: x", GOOD.replace("## Evidence", "## Testing")).join(), /"## Evidence" is missing/);
  assert.match(prBodyProblems("ci: x", GOOD.replace("## What changes", "## What changed")).join(), /"## What changes" is missing/);
});

test("sections keep their order and aren't left empty", () => {
  const swapped = GOOD.replace("## Evidence", "## TMP").replace("## Try by hand", "## Evidence").replace("## TMP", "## Try by hand");
  assert.match(prBodyProblems("ci: x", swapped).join(), /in this order/);
  assert.match(prBodyProblems("ci: x", `${GOOD}\n## Migrations\n`).join(), /is empty/);
});

test("Evidence has to say more than that the checks passed", () => {
  const thin = GOOD.replace(/## Evidence\n\n.*\n/, "## Evidence\n\nTests pass.\n");
  assert.match(prBodyProblems("ci: x", thin).join(), /only says the checks passed/);
});

test("a long bullet and an em dash are flagged, but a table's dash isn't", () => {
  const long = GOOD.replace("It polls", `${"word ".repeat(60)}It polls`);
  assert.match(prBodyProblems("ci: x", long).join(), /over 60/);
  const many = GOOD.replace("## Evidence", `${"- **Another change.**\n".repeat(7)}\n## Evidence`);
  assert.match(prBodyProblems("ci: x", many).join(), /8 bullets, over 7/);
  const seven = GOOD.replace("## Evidence", `${"- **Another change.**\n".repeat(6)}\n## Evidence`);
  assert.deepEqual(prBodyProblems("ci: x", seven), []);
  const dashed = GOOD.replace("and a rerun", "— a rerun");
  assert.match(prBodyProblems("ci: x", dashed).join(), /em dash/);
  const table = GOOD.replace("## Try by hand", "| Job | Before |\n|---|---|\n| iOS | — |\n\n## Try by hand");
  assert.deepEqual(prBodyProblems("ci: x", table), []);
});
