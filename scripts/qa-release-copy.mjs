#!/usr/bin/env node
// Write a release's QA copy: the master with every row marked, and the counts on top.
//
//   pnpm qa:release <version> [--kind patch|minor|major] [--since <rev>] [--until <rev>]
//                             [--waive-sweep "<why>"] [--force]
//
// A row is touched when a changed file matches its section's `paths:` globs, when a
// file importing a changed module does, or when a changed spec carries the row's tag.
// Touched rows are marked automated (from `qa-marks.mjs`, never typed) or manual;
// the rest are untouched. The result is a candidate set, deliberately over-inclusive,
// for a person to judge before anyone drives a row.
//
// Run again on a copy that exists, it keeps what a person has done: a ticked row, or a row
// marked both with its reason, stays so unless a commit since the last run reaches it.
// `--force` starts over.
//
// Reads the master and writes the copy in the working tree, so it runs where the
// release is cut, not in CI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  automatedRows,
  git,
  importGraph,
  isTouched,
  readCopy,
  readMaster,
  ROOT,
  touches,
} from "./lib/qa-rows.mjs";

const KINDS = ["patch", "minor", "major"];

/** What a release kind adds to the touched set, whatever changed: a minor release runs the
 *  screen tour, a major one sweeps every row. */
function touchForKind(kind, sections, reasons) {
  const touch = (key, why) => (reasons.get(key) ?? reasons.set(key, new Set()).get(key)).add(why);
  for (const s of sections) {
    if (kind === "major") touch(s.key, "a major release sweeps every row");
    else if (kind === "minor" && s.key === "TOUR")
      touch(s.key, "a minor release runs the screen tour");
  }
}

function parseArgs(argv) {
  const opts = { force: false, since: null, until: "HEAD", version: null, waive: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--until") opts.until = argv[++i];
    else if (arg === "--waive-sweep") opts.waive = argv[++i];
    else if (arg === "--kind") opts.kind = argv[++i];
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version)
    throw new Error(
      "usage: qa-release-copy.mjs <version> [--kind patch|minor|major] [--since <rev>] [--until <rev>] [--waive-sweep <why>] [--force]"
    );
  if (opts.kind && !KINDS.includes(opts.kind))
    throw new Error(`--kind is one of ${KINDS.join(", ")}`);
  opts.since ??= git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  return opts;
}

/** The release's mutation run, when one covers exactly this range. A survivor demotes the
 *  automated rows its file reaches. */
function readMutationRun(version, range) {
  const none = (why) => ({
    summary: [
      "**Automated** means a test on the real writer carries the row's tag. " + why,
      "so none of those tests has been shown failing when its row's code breaks.",
    ],
    survivorsByRow: new Map(),
  });
  const path = join(ROOT, ".agent/releases", version, "mutants.json");
  if (!existsSync(path)) return none("No mutation run feeds these marks,");
  const run = JSON.parse(readFileSync(path, "utf8"));
  const resolve = (r) =>
    r
      .split("..")
      .map((rev) => git("rev-parse", rev))
      .join("..");
  if (!run.complete) return none("The last mutation run was a sample or work in progress,");
  if (resolve(run.range) !== resolve(range)) {
    return none(`The mutation run covers \`${run.range}\`, not this range,`);
  }
  const survivorsByRow = new Map();
  for (const s of run.survivors) {
    for (const row of s.rows) {
      (survivorsByRow.get(row) ?? survivorsByRow.set(row, []).get(row)).push(
        `\`${s.file}:${s.line}\` (${s.mutator})`
      );
    }
  }
  const { killedByE2e, killedByUnit, survived, total } = run.counts;
  const stages = run.e2e
    ? `${killedByUnit} by unit tests, ${killedByE2e} by e2e tests`
    : `${killedByUnit} by unit tests, the e2e stage skipped`;
  return {
    summary: [
      "**Automated** means a test on the real writer carries the row's tag, and no mutant survived in",
      `code the row reaches. The mutation run broke the changed code ${total} ways: ${stages},`,
      `${survived} survived. A row a survivor reaches is manual, with the survivor named.`,
    ],
    survivorsByRow,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const range = `${opts.since}..${opts.until}`;
  const dest = join(ROOT, ".agent/releases", opts.version, "qa.md");
  const previous = existsSync(dest) && !opts.force ? readCopy(dest) : null;
  const waive = opts.waive ?? previous?.waiver ?? null;
  const kind = opts.kind ?? previous?.kind ?? "patch";
  const { lines, sections } = readMaster();
  const automated = automatedRows();
  const graph = importGraph();
  const mutation = readMutationRun(opts.version, range);
  const { reasons, sweep, unmapped } = touches({ automated, graph, range, sections, waive });
  touchForKind(kind, sections, reasons);
  const head = git("rev-parse", "--short", opts.until);

  // What landed since the copy was last written. A row it reaches has to be driven again;
  // every other row keeps the tick, or the reason for driving it anyway, a person gave it.
  const since =
    previous?.sha && git("rev-parse", previous.sha) !== git("rev-parse", opts.until)
      ? touches({ automated, graph, range: `${previous.sha}..${opts.until}`, sections, waive })
          .reasons
      : new Map();
  let carried = 0;
  let reset = 0;

  const marks = new Map();
  for (const s of sections) {
    for (const row of s.rows) {
      const touched = isTouched(reasons, s, row);
      const survived = mutation.survivorsByRow.get(row.id) ?? [];
      let mark = !touched
        ? "untouched"
        : automated[row.id] && !row.manualForGood && survived.length === 0
          ? "automated"
          : "manual";
      let tail =
        mark === "automated"
          ? `(${automated[row.id].map((t) => t.split(" ")[0]).join(", ")})`
          : touched && survived.length > 0
            ? `(tests missed a mutant at ${survived.join(", ")})`
            : "";
      let ticked = mark !== "manual";

      const before = previous?.rows.get(row.id);
      if (touched && before && (before.ticked || before.mark === "both")) {
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
  const sweepLine =
    sweep.length === 0
      ? "Full sweep: not triggered."
      : waive
        ? `Full sweep: triggered by ${sweep.join("; ")}. Waived: ${waive}`
        : `Full sweep: triggered by ${sweep.join("; ")}. Every section is touched.`;

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
    `Generated by \`scripts/qa-release-copy.mjs\` from \`${range}\` at \`${head}\`, for a ${kind} release. The marks are a`,
    "computed candidate set: judge them against the commits before driving a row. Tick a manual",
    "row when a person has driven it; mark a row **both**, with the reason, when a person drives an",
    "automated row anyway.",
    "",
    ...mutation.summary,
    "",
    "| Rows | Count |",
    "| --- | --- |",
    `| In the master | ${marks.size} |`,
    `| Touched | ${touchedCount} |`,
    `| Automated, so nobody drives them | ${count("automated")} |`,
    `| For a person to drive | ${count("manual") + count("both")} |`,
    `| Untouched | ${count("untouched")} |`,
    "",
    sweepLine,
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
