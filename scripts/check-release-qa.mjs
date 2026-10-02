#!/usr/bin/env node
// The QA half of the release gate: refuse a tag until the release's QA copy is finished.
//
//   pnpm qa:gate <version> [--kind patch|minor|major] [--hotfix]   check; prints the record line
//   node scripts/check-release-qa.mjs <version> [--hotfix] --pass-date   the day the pass ran
//   node scripts/check-release-qa.mjs <version> --record "<line>"   add a line to the record
//
// A copy is finished when it was written for this commit (or nothing since reaches a row),
// holds every row of the master with a mark, every row a person drives is ticked, every row
// marked both says why, every automated row still has its tests, and the sign-off names who
// ran the pass. A hotfix signs the copy's hotfix block instead of driving the rows.
//
// `release.sh` runs the check before it bumps the version and writes the record after it
// tags, so an aborted release records nothing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  automatedRows,
  git,
  importGraph,
  readCopy,
  readMaster,
  ROOT,
  touches,
} from "./lib/qa-rows.mjs";

const UNFILLED = /___/;
/** The sign-off ends with the day the pass ran, which the release's log check starts from. */
const PASS_DATE = /on (\d{4}-\d{2}-\d{2})\s*$/;

function parseArgs(argv) {
  const opts = { hotfix: false, kind: null, passDate: false, record: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hotfix") opts.hotfix = true;
    else if (arg === "--record") opts.record = argv[++i];
    else if (arg === "--pass-date") opts.passDate = true;
    else if (arg === "--kind") opts.kind = argv[++i];
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version) {
    throw new Error("usage: check-release-qa.mjs <version> [--hotfix] [--record <line>]");
  }
  return opts;
}

/** Add a line under the release page's "Release record" heading. */
function record(version, line) {
  const page = join(ROOT, ".agent/releases", version, "README.md");
  if (!existsSync(page)) throw new Error(`no release page at ${page}`);
  const lines = readFileSync(page, "utf8").split("\n");
  const heading = lines.findIndex((l) => l === "## Release record");
  if (heading === -1) throw new Error(`${page} has no "## Release record" section`);
  const next = lines.findIndex((l, i) => i > heading && l.startsWith("## "));
  let end = next === -1 ? lines.length : next;
  while (end > heading + 1 && lines[end - 1] === "") end--;
  lines.splice(end, 0, ...(lines[end - 1]?.startsWith("- ") ? [] : [""]), `- ${line}`);
  writeFileSync(page, lines.join("\n"));
}

/** The lines of the sign-off block after `heading`, up to the next blank line. */
function block(signOff, heading) {
  const at = signOff.findIndex((l) => l.startsWith(heading));
  if (at === -1) return null;
  const out = [];
  for (const line of signOff.slice(at + 1)) {
    if (line.startsWith("- ")) out.push(line);
    else if (out.length > 0) break;
  }
  return out;
}

function check(opts) {
  const path = join(ROOT, ".agent/releases", opts.version, "qa.md");
  if (!existsSync(path)) {
    return { problems: [`no QA copy at ${path}; write it with pnpm qa:release ${opts.version}`] };
  }
  const copy = readCopy(path);
  const problems = [];

  if (opts.hotfix) {
    const lines = block(copy.signOff, "A hotfix");
    if (!lines) return { problems: ["the copy has no hotfix block to sign"] };
    for (const line of lines) {
      if (line.startsWith("- [ ]")) problems.push(`hotfix check not done: ${line.slice(6)}`);
      else if (UNFILLED.test(line))
        problems.push(`hotfix sign-off not filled in: ${line.slice(2)}`);
      else if (line.startsWith("- Hotfix run by") && !PASS_DATE.test(line))
        problems.push("the hotfix sign-off has to end with the day it ran, as YYYY-MM-DD");
    }
    return {
      line: "Cut as a hotfix: signed the hotfix block, not the rows (`PKOS-0117`).",
      problems,
    };
  }

  if (opts.kind && copy.kind !== opts.kind) {
    problems.push(
      `the copy was written for a ${copy.kind ?? "patch"} release; run pnpm qa:release ${opts.version} --kind ${opts.kind}`
    );
  }

  const head = git("rev-parse", "HEAD");
  if (!copy.sha) {
    problems.push("the copy doesn't say which commit it was written at");
  } else if (git("rev-parse", copy.sha) !== head) {
    const { sections } = readMaster();
    const since = touches({
      automated: automatedRows(),
      graph: importGraph(),
      range: `${copy.sha}..${head}`,
      sections,
      waive: copy.waiver,
    });
    if (since.reasons.size > 0 || since.unmapped.length > 0) {
      problems.push(
        `commits since the copy (${copy.sha}) reach rows; run pnpm qa:release ${opts.version} again`
      );
    }
  }

  const { sections } = readMaster();
  const master = new Set(sections.flatMap((s) => s.rows.map((r) => r.id)));
  for (const id of master)
    if (!copy.rows.has(id)) problems.push(`${id} is in the master but not the copy`);
  for (const id of copy.rows.keys())
    if (!master.has(id)) problems.push(`${id} is in the copy but not the master`);

  const automated = automatedRows();
  const count = { automated: 0, driven: 0, touched: 0 };
  for (const [id, row] of copy.rows) {
    if (!row.mark) {
      problems.push(`${id} has no mark`);
      continue;
    }
    if (row.mark !== "untouched") count.touched++;
    if (row.mark === "automated") {
      count.automated++;
      if (!automated[id]) problems.push(`${id} is marked automated, but no test claims it now`);
    }
    if (row.mark === "manual" || row.mark === "both") {
      if (row.ticked) count.driven++;
      else
        problems.push(`${id} is ${row.mark === "both" ? "marked both" : "manual"} and not ticked`);
      if (row.mark === "both" && !row.tail) problems.push(`${id} is marked both without a reason`);
    }
  }

  const runBy = copy.signOff.find((l) => l.startsWith("- Run by"));
  if (!runBy || UNFILLED.test(runBy)) problems.push("the sign-off doesn't say who ran the pass");
  else if (!PASS_DATE.test(runBy))
    problems.push("the sign-off has to end with the day the pass ran, as YYYY-MM-DD");

  const mutants = join(ROOT, ".agent/releases", opts.version, "mutants.json");
  const run = existsSync(mutants) ? JSON.parse(readFileSync(mutants, "utf8")) : null;
  const mutation = run?.complete
    ? ` Mutation run: ${run.counts.total} mutants, ${run.counts.survived} survived.`
    : " No complete mutation run.";
  const line =
    `QA at \`${head.slice(0, 8)}\`: ${count.touched} of ${copy.rows.size} rows touched, ` +
    `${count.automated} automated, ${count.driven} driven by a person.${mutation}`;
  return { line, problems };
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.record) {
    record(opts.version, opts.record);
  } else if (opts.passDate) {
    const copy = readCopy(join(ROOT, ".agent/releases", opts.version, "qa.md"));
    const prefix = opts.hotfix ? "- Hotfix run by" : "- Run by";
    const date = PASS_DATE.exec(copy.signOff.find((l) => l.startsWith(prefix)) ?? "")?.[1];
    if (!date) throw new Error("the sign-off has no date the pass ran");
    console.log(date);
  } else {
    const { line, problems } = check(opts);
    if (problems.length > 0) {
      console.error(`The ${opts.version} QA copy isn't finished:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log(line);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
