#!/usr/bin/env node
// Write a release's QA copy: the master with every row marked, and the counts on top.
//
//   pnpm qa:release <version> [--kind patch|minor|major] [--since <rev>] [--until <rev>]
//                             [--driven-on <rev>] [--macos-update] [--force]
//
// A row is touched when a changed file matches its paths (its own, or else its section's),
// when a file importing a changed module does, when a changed spec carries the row's tag, or
// when a library it serves moved. A manual row is also on the list when it checks the release
// build, when the ledger says nobody has driven it for six months, or after a major macOS
// update (`PKOS-0145`). Touched rows are marked automated (from `qa-marks.mjs`, never typed) or
// manual; the rest are untouched. The result is a candidate set for a person to judge before
// anyone drives a row.
//
// Run again on a copy that exists, it keeps what a person has done: a ticked row, or a row
// marked both or judged untouched with its reason, stays so unless a commit since the build the
// rows were driven on reaches it; a deferred row stays deferred. `--driven-on` names that build,
// and the copy remembers it; without it, the commit the copy was last written at stands in.
// `--force` starts over.
//
// Reads the master and writes the copy in the working tree, so it runs where the
// release is cut, not in CI.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  automatedRows,
  git,
  importGraph,
  isTouched,
  readCopy,
  readLedger,
  readMaster,
  RELEASE_BUILD_ROWS,
  ROOT,
  touches,
} from "./lib/qa-rows.mjs";

const KINDS = ["patch", "minor", "major"];

/** `date` (YYYY-MM-DD) less six months, to the day, comparable as a string. */
function sixMonthsBefore(date) {
  const [y, m, d] = date.split("-").map(Number);
  const months = y * 12 + (m - 1) - 6;
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(months / 12)}-${pad((months % 12) + 1)}-${pad(d)}`;
}

/**
 * What the release adds to the touched set, whatever changed: a minor release runs the screen
 * tour, a major one sweeps every row; a manual row that checks the release build, or that the
 * ledger hasn't seen driven since six months before `until`, comes back, and after a major macOS
 * update every manual row does.
 */
function touchForRelease({ automated, kind, macosUpdate, reasons, sections, until }) {
  const touch = (key, why) => (reasons.get(key) ?? reasons.set(key, new Set()).get(key)).add(why);
  const touchSection = (s, why) => {
    touch(s.key, why);
    for (const row of s.rows.filter((r) => r.paths)) touch(row.id, why);
  };
  const ledger = readLedger();
  const cutoff = sixMonthsBefore(git("log", "-1", "--format=%cs", until));

  for (const s of sections) {
    if (kind === "major") touchSection(s, "a major release sweeps every row");
    else if (kind === "minor" && s.key === "TOUR")
      touchSection(s, "a minor release runs the screen tour");

    for (const row of s.rows.filter((r) => r.manualForGood || !automated[r.id])) {
      const driven = ledger[row.id];
      if (RELEASE_BUILD_ROWS.includes(row.id)) touch(row.id, "it checks the release build");
      if (macosUpdate) touch(row.id, "a major macOS update");
      if (!driven) touch(row.id, "no drive recorded");
      else if (driven < cutoff) touch(row.id, `last driven ${driven}`);
    }
  }
}

function parseArgs(argv) {
  const opts = {
    drivenOn: null,
    force: false,
    macosUpdate: false,
    since: null,
    until: "HEAD",
    version: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--until") opts.until = argv[++i];
    else if (arg === "--driven-on") opts.drivenOn = git("rev-parse", "--short", argv[++i]);
    else if (arg === "--macos-update") opts.macosUpdate = true;
    else if (arg === "--kind") opts.kind = argv[++i];
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version)
    throw new Error(
      "usage: qa-release-copy.mjs <version> [--kind patch|minor|major] [--since <rev>] [--until <rev>] [--driven-on <rev>] [--macos-update] [--force]"
    );
  if (opts.kind && !KINDS.includes(opts.kind))
    throw new Error(`--kind is one of ${KINDS.join(", ")}`);
  opts.since ??= git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  return opts;
}

/** What an automated mark means, on top of the copy. Proving a test can fail is the author's
 *  job when the test is written or changes what it checks; no run here re-proves it. */
const MARK_SUMMARY = [
  "**Automated** means a test on the real writer carries the row's tag and passes, and was seen",
  "failing once, when it was written or last changed what it checks, against the behaviour broken on purpose.",
];

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const range = `${opts.since}..${opts.until}`;
  const dest = join(ROOT, ".agent/releases", opts.version, "qa.md");
  const previous = existsSync(dest) && !opts.force ? readCopy(dest) : null;
  const kind = opts.kind ?? previous?.kind ?? "patch";
  const drivenOn = opts.drivenOn ?? previous?.drivenOn ?? null;
  const { lines, sections } = readMaster();
  const automated = automatedRows();
  const graph = importGraph();
  const { libraries, reasons, unmapped } = touches({ automated, graph, range, sections });
  touchForRelease({
    automated,
    kind,
    macosUpdate: opts.macosUpdate,
    reasons,
    sections,
    until: opts.until,
  });
  const head = git("rev-parse", "--short", opts.until);

  // What landed since the build the rows were driven on. A row it reaches has to be driven
  // again; every other row keeps the tick, or the reason for driving it anyway, a person gave it.
  const base = drivenOn ?? previous?.sha;
  const since =
    previous && base && git("rev-parse", base) !== git("rev-parse", opts.until)
      ? touches({ automated, graph, range: `${base}..${opts.until}`, sections }).reasons
      : new Map();
  let carried = 0;
  let reset = 0;

  const marks = new Map();
  for (const s of sections) {
    for (const row of s.rows) {
      const touched = isTouched(reasons, s, row);
      let mark = !touched
        ? "untouched"
        : automated[row.id] && !row.manualForGood
          ? "automated"
          : "manual";
      let tail =
        mark === "automated" ? `(${automated[row.id].map((t) => t.split(" ")[0]).join(", ")})` : "";
      let ticked = mark !== "manual";

      const before = previous?.rows.get(row.id);
      if (mark === "manual" && before?.mark === "deferred") {
        // Nothing since can undo a drive that never happened, so the deferral holds.
        mark = "deferred";
        tail = before.tail;
        ticked = before.ticked;
        carried++;
      } else if (
        mark === "manual" &&
        before?.mark === "untouched" &&
        before.tail &&
        !isTouched(since, s, row)
      ) {
        // A person's untouched judgment, with its reason (PKOS-0145), until a commit reaches the row.
        mark = "untouched";
        tail = before.tail;
        carried++;
      } else if (touched && before && (before.ticked || before.mark === "both")) {
        if (isTouched(since, s, row)) {
          if (before.mark === "manual" || before.mark === "both") reset++;
        } else if (before.mark === "both") {
          mark = "both";
          tail = before.tail;
          ticked = before.ticked;
          carried++;
        } else if (before.mark === "manual" && mark === "manual") {
          ticked = true;
          carried++;
        }
      }
      marks.set(row.id, mark);
      const box = ticked ? "- [x]" : "- [ ]";
      lines[row.line] =
        `${lines[row.line].replace(/^- \[[ x]\]/, box)} · **${mark}**${tail ? ` ${tail}` : ""}`;
    }
  }

  const count = (mark) => [...marks.values()].filter((m) => m === mark).length;
  const touchedCount = marks.size - count("untouched");
  const librariesLine =
    libraries.length === 0
      ? "Every library that moved reaches a row, or none moved."
      : `Libraries that moved and reach no row, for a person to judge: ${libraries.map((l) => `\`${l}\``).join(", ")}.`;

  const reached = sections
    .filter((s) => reasons.has(s.key) || s.rows.some((r) => reasons.has(r.id)))
    .map((s) => {
      const why = [...(reasons.get(s.key) ?? [])];
      const rowWhy = s.rows
        .filter((r) => reasons.has(r.id))
        .map((r) => `${r.id} by ${[...reasons.get(r.id)].join(", ")}`);
      return `- **${s.key}**: ${[...why, ...rowWhy].join("; ")}`;
    });

  const firstSection = lines.findIndex((l) => /^## [A-Z0-9]+ · /.test(l));
  const body = lines.slice(firstSection);
  // The sign-off is a person's, so a regenerated copy keeps it as they left it.
  const signOffAt = body.findIndex((l) => l.startsWith("## Sign-off"));
  if (previous && previous.signOff.length > 0 && signOffAt !== -1) {
    body.splice(signOffAt, body.length - signOffAt, ...previous.signOff);
  }
  const copy = [
    `# QA — ${opts.version}`,
    "",
    `Generated by \`scripts/qa-release-copy.mjs\` from \`${range}\` at \`${head}\`, for a ${kind} release.${drivenOn ? ` Ticked rows were driven on \`${drivenOn}\`.` : ""} The marks are a`,
    "computed candidate set: judge them against the commits before driving a row. Tick a manual",
    "row when a person has driven it; mark a row **both**, with the reason, when a person drives an",
    "automated row anyway. Mark a manual row **deferred**, with the reason, when it can't be driven",
    "before the tag (it needs the published release, or hardware we don't have) or is skipped on",
    "risk; the release record names every one.",
    "",
    ...MARK_SUMMARY,
    "",
    "| Rows | Count |",
    "| --- | --- |",
    `| In the master | ${marks.size} |`,
    `| Touched | ${touchedCount} |`,
    `| Automated, so nobody drives them | ${count("automated")} |`,
    `| For a person to drive | ${count("manual") + count("both")} |`,
    `| Deferred | ${count("deferred")} |`,
    `| Untouched | ${count("untouched")} |`,
    "",
    librariesLine,
    "",
    "## Changed files no row covers",
    "",
    ...(unmapped.length > 0 ? unmapped.map((f) => `- \`${f}\``) : ["None."]),
    "",
    "## How each section was reached",
    "",
    ...(reached.length > 0 ? reached : ["Nothing was."]),
    "",
    "---",
    "",
    ...body,
  ].join("\n");

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, copy);
  console.log(
    `${dest}\n${touchedCount} of ${marks.size} rows touched: ${count("automated")} automated, ${count("manual") + count("both")} to drive, ${unmapped.length} changed file(s) map to no row.`
  );
  if (previous) {
    console.log(`Kept ${carried} row(s) a person had driven; ${reset} need driving again.`);
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
