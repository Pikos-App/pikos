#!/usr/bin/env node
// Write a release's QA copy: the master with every row marked, and the counts on top.
//
//   pnpm qa:release <version> [--since <rev>] [--until <rev>] [--waive-sweep "<why>"] [--force]
//
// A row is touched when a changed file matches its section's `paths:` globs, when a
// file importing a changed module does, or when a changed spec carries the row's tag.
// Touched rows are marked automated (from `qa-marks.mjs`, never typed) or manual;
// the rest are untouched. The result is a candidate set, deliberately over-inclusive,
// for a person to judge before anyone drives a row.
//
// Imports are followed one step, because further reaches everything through the
// shared state layer. `@pikos/core` resolves to its index for every importer, so a
// core module is followed only into files whose import from it names one of the
// module's exports.
//
// Reads the master and writes the copy in the working tree, so it runs where the
// release is cut, not in CI.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = join(ROOT, ".agent/qa/full-qa-checklist.md");
const CORE_INDEX = "packages/core/src/index.ts";

/** Files that ship no behaviour a row could see. Anything else that changes and maps
 *  to no section is listed, because it is a row the master is missing. */
const NO_BEHAVIOUR = [
  ".github/**",
  ".husky/**",
  "docs/**",
  "scripts/**",
  "apps/marketing/**",
  "apps/brand/**",
  "**/*.md",
  "**/.gitkeep",
  "**/.gitignore",
  "**/{vite,vitest}.config.ts",
  "**/tsconfig*.json",
  "{eslint.config.js,.dependency-cruiser.cjs,.prettierrc*,.prettierignore}",
  "**/*.{test,testHelpers}.{ts,tsx}",
  "**/*_tests.rs",
  "**/tests/**",
  "apps/desktop/{e2e,seeds,bridge}/**",
  "apps/desktop/playwright.*",
  "apps/desktop/src/test/**",
  "packages/core/src/adapters/{MockStorage,Noop}*",
  "apps/desktop/src/shared/adapters/{inMemoryStorage,mockStorageChunk}*",
  "apps/desktop/src-tauri/src/{e2e_*.rs,bin/e2e_*.rs}",
  "apps/desktop/src-tauri/src/db/dev/seed*.rs",
];

/** The master's header: these touch every section. */
const FULL_SWEEP = [
  { glob: "{pnpm-lock.yaml,**/Cargo.lock}", why: "a dependency changed" },
  { glob: "crates/pikos-db/migrations/**", why: "a migration changed" },
  {
    glob: "apps/desktop/src-tauri/tauri.conf.json",
    why: "the CSP may have changed",
    diff: /"csp"|"security"/,
  },
];

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const opts = { force: false, since: null, until: "HEAD", version: null, waive: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--until") opts.until = argv[++i];
    else if (arg === "--waive-sweep") opts.waive = argv[++i];
    else if (!arg.startsWith("--") && !opts.version) opts.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.version)
    throw new Error(
      "usage: qa-release-copy.mjs <version> [--since <rev>] [--until <rev>] [--waive-sweep <why>] [--force]"
    );
  opts.since ??= git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  return opts;
}

/** Sections in master order, each with its globs and rows. Lines are kept so the copy
 *  can be written back with only the marks added. */
function readMaster() {
  const lines = readFileSync(MASTER, "utf8").split("\n");
  const sections = [];
  for (const [i, line] of lines.entries()) {
    const heading = /^## ([A-Z0-9]+) · /.exec(line);
    if (heading) sections.push({ globs: [], key: heading[1], rows: [] });
    const section = sections.at(-1);
    if (!section) continue;
    if (line.startsWith("paths: ")) {
      section.globs = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    }
    const row = /^- \[[ x]\] \*\*([A-Z]+-\d+)\*\*/.exec(line);
    if (row) section.rows.push({ id: row[1], line: i, manualForGood: line.includes("· 🧑") });
  }
  return { lines, sections };
}

/** Row → tests, and the failures that make a claim void. A void claim stops the copy:
 *  a release can't report automation it can't stand behind. */
function automatedRows() {
  const out = execFileSync("node", [join(ROOT, "scripts/qa-marks.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out).automated;
}

function importGraph() {
  const out = execFileSync(
    "pnpm",
    [
      "exec",
      "depcruise",
      "apps/desktop/src",
      "packages/core/src",
      "--config",
      ".dependency-cruiser.cjs",
      "--output-type",
      "json",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  return new Map(JSON.parse(out).modules.map((m) => [m.source, m.dependents ?? []]));
}

function exportedNames(file) {
  if (!existsSync(join(ROOT, file))) return [];
  const text = readFileSync(join(ROOT, file), "utf8");
  const names = [
    ...text.matchAll(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)/gm
    ),
  ].map((m) => m[1]);
  for (const m of text.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    names.push(
      ...m[1]
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .at(-1)
        )
        .filter(Boolean)
    );
  }
  return names;
}

/** The files one import step from `file` that a row could see. */
function importers(file, graph) {
  const direct = (graph.get(file) ?? []).filter((f) => !isNoBehaviour(f));
  if (!direct.includes(CORE_INDEX)) return direct;
  const names = new Set(exportedNames(file));
  const viaCore = (graph.get(CORE_INDEX) ?? []).filter((f) => {
    if (isNoBehaviour(f) || !existsSync(join(ROOT, f))) return false;
    const text = readFileSync(join(ROOT, f), "utf8");
    return [
      ...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@pikos\/core["']/g),
    ].some((m) =>
      m[1].split(",").some((s) =>
        names.has(
          s
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
        )
      )
    );
  });
  return [...direct.filter((f) => f !== CORE_INDEX), ...viaCore];
}

function isNoBehaviour(file) {
  return NO_BEHAVIOUR.some((glob) => matchesGlob(file, glob));
}

function sectionsMatching(file, sections) {
  return sections.filter((s) => s.globs.some((glob) => matchesGlob(file, glob)));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const range = `${opts.since}..${opts.until}`;
  const changed = git("diff", "--name-only", range).split("\n").filter(Boolean);
  const { lines, sections } = readMaster();
  const automated = automatedRows();
  const graph = importGraph();

  /** Section key or row ID → why it is touched. */
  const reasons = new Map();
  const touch = (key, why) => (reasons.get(key) ?? reasons.set(key, new Set()).get(key)).add(why);

  const sweep = FULL_SWEEP.flatMap(({ diff, glob, why }) =>
    changed
      .filter((f) => matchesGlob(f, glob))
      .filter((f) => !diff || diff.test(git("diff", range, "--", f)))
      .map((f) => `${why} (\`${f}\`)`)
  );
  if (sweep.length > 0 && !opts.waive) {
    for (const s of sections) touch(s.key, "full sweep");
  }

  // A changed spec touches every row its tests take: a proof lasts only until the test changes.
  const testsByFile = new Map();
  for (const [row, tests] of Object.entries(automated)) {
    for (const test of tests) {
      const file = `apps/desktop/e2e/${test.split(":")[0]}`;
      (testsByFile.get(file) ?? testsByFile.set(file, new Set()).get(file)).add(row);
    }
  }

  const unmapped = [];
  for (const file of changed) {
    for (const row of testsByFile.get(file) ?? []) touch(row, `\`${file}\` changed`);
    if (isNoBehaviour(file)) continue;
    const direct = sectionsMatching(file, sections);
    for (const s of direct) touch(s.key, `\`${file}\``);
    let reached = direct.length > 0;
    for (const importer of importers(file, graph)) {
      for (const s of sectionsMatching(importer, sections)) {
        touch(s.key, `\`${importer}\` imports \`${file}\``);
        reached = true;
      }
    }
    if (!reached && !FULL_SWEEP.some(({ glob }) => matchesGlob(file, glob))) unmapped.push(file);
  }

  const marks = new Map();
  for (const s of sections) {
    for (const row of s.rows) {
      const touched = reasons.has(s.key) || reasons.has(row.id);
      const mark = !touched
        ? "untouched"
        : automated[row.id] && !row.manualForGood
          ? "automated"
          : "manual";
      marks.set(row.id, mark);
      const tests =
        mark === "automated"
          ? ` (${automated[row.id].map((t) => t.split(" ")[0]).join(", ")})`
          : "";
      const box = mark === "manual" ? "- [ ]" : "- [x]";
      lines[row.line] = `${lines[row.line].replace(/^- \[[ x]\]/, box)} · **${mark}**${tests}`;
    }
  }

  const count = (mark) => [...marks.values()].filter((m) => m === mark).length;
  const touchedCount = count("automated") + count("manual");
  const head = git("rev-parse", "--short", opts.until);
  const sweepLine =
    sweep.length === 0
      ? "Full sweep: not triggered."
      : opts.waive
        ? `Full sweep: triggered by ${sweep.join("; ")}. Waived: ${opts.waive}`
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
  const copy = [
    `# QA — ${opts.version}`,
    "",
    `Generated by \`scripts/qa-release-copy.mjs\` from \`${range}\` at \`${head}\`. The marks are a`,
    "computed candidate set: judge them against the commits before driving a row. Tick a manual",
    "row when a person has driven it; mark a row **both**, with the reason, when a person drives an",
    "automated row anyway.",
    "",
    "**Automated** means a test on the real writer carries the row's tag. No mutation run feeds these",
    "marks, so none of those tests has been shown failing when its row's code breaks.",
    "",
    "| Rows | Count |",
    "| --- | --- |",
    `| In the master | ${marks.size} |`,
    `| Touched | ${touchedCount} |`,
    `| Automated, so nobody drives them | ${count("automated")} |`,
    `| For a person to drive | ${count("manual")} |`,
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
    ...lines.slice(firstSection),
  ].join("\n");

  const dest = join(ROOT, ".agent/releases", opts.version, "qa.md");
  if (existsSync(dest) && !opts.force) {
    throw new Error(
      `${dest} exists and may carry ticks and judgments; pass --force to regenerate it`
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, copy);
  console.log(
    `${dest}\n${touchedCount} of ${marks.size} rows touched: ${count("automated")} automated, ${count("manual")} to drive, ${unmapped.length} changed file(s) map to no row.`
  );
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
