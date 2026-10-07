// What the QA scripts share: the master's sections and rows, which files ship behaviour,
// and how a changed file reaches a section. Imports are followed one step, because
// further reaches everything through the shared state layer. `@pikos/core` resolves to
// its index for every importer, so a core module is followed only into files whose
// import from it names one of the module's exports.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MASTER = join(ROOT, ".agent/qa/full-qa-checklist.md");
const CORE_INDEX = "packages/core/src/index.ts";

/** Files that ship no behaviour a row could see. Anything else that changes and maps
 *  to no section is listed, because it is a row the master is missing. */
export const NO_BEHAVIOUR = [
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
  "packages/core/src/adapters/{MockStorage,Noop,mockViews}*",
  "apps/desktop/src/shared/adapters/{inMemoryStorage,mockStorageChunk}*",
  "apps/desktop/src-tauri/{src/e2e_*.rs,bins/**}",
  "apps/desktop/src/bench/**",
  "apps/desktop/src-tauri/src/bench.rs",
  "apps/desktop/src-tauri/tauri.conf.bench.json",
  "apps/desktop/src-tauri/src/db/dev/seed*.rs",
  "crates/pikos-cli/src/stress.rs",
];

export function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

/** Sections in master order, each with its globs and rows. Lines are kept so the copy
 *  can be written back with only the marks added. */
export function readMaster() {
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
export function automatedRows() {
  const out = execFileSync("node", [join(ROOT, "scripts/qa-marks.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out).automated;
}

export function importGraph() {
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
export function importers(file, graph) {
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

export function isNoBehaviour(file) {
  return NO_BEHAVIOUR.some((glob) => matchesGlob(file, glob));
}

/** A `cfg` attribute for a build no release carries. */
const NON_SHIPPING_CFG = /^#\[cfg\(feature = "(bench|e2e-bridge)"\)\]$/;

/**
 * Whether every line a Rust file changed over `range` is a non-shipping `cfg` attribute or the
 * one line it guards, so the file changed only in builds no release carries.
 */
export function changedOnlyInNonShippingBuilds(file, range) {
  if (!file.endsWith(".rs")) return false;
  const lines = git("diff", "--unified=0", range, "--", file)
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1).trim());
  if (lines.length === 0) return false;
  let guarded = false;
  for (const line of lines) {
    if (line === "") continue;
    if (NON_SHIPPING_CFG.test(line)) {
      guarded = true;
      continue;
    }
    if (!guarded) return false;
    guarded = false;
  }
  return true;
}

export function sectionsMatching(file, sections) {
  return sections.filter((s) => s.globs.some((glob) => matchesGlob(file, glob)));
}

/** The sections `file` reaches, directly or through a file one import away, each with why. */
export function sectionsReachedBy(file, sections, graph) {
  const reached = new Map();
  for (const s of sectionsMatching(file, sections)) reached.set(s.key, `\`${file}\``);
  for (const importer of importers(file, graph)) {
    for (const s of sectionsMatching(importer, sections)) {
      if (!reached.has(s.key)) reached.set(s.key, `\`${importer}\` imports \`${file}\``);
    }
  }
  return reached;
}

/** The master's header: these touch every section. */
export const FULL_SWEEP = [
  { glob: "{pnpm-lock.yaml,**/Cargo.lock}", why: "a dependency changed" },
  { glob: "crates/pikos-db/migrations/**", why: "a migration changed" },
  {
    diff: /"csp"|"security"/,
    glob: "apps/desktop/src-tauri/tauri.conf.json",
    why: "the CSP may have changed",
  },
];

/**
 * What a range of commits touches. `reasons` maps a section key, or a row ID a changed spec
 * claims, to why; a changed spec touches every row its tests take, because a proof lasts
 * only until the test changes. `sweep` names what triggered a full sweep, which touches
 * every section unless `waive` says why not. `unmapped` lists changed files that ship
 * behaviour and reach no section.
 */
export function touches({ automated, graph, range, sections, waive }) {
  const changed = git("diff", "--name-only", range).split("\n").filter(Boolean);
  const reasons = new Map();
  const touch = (key, why) => (reasons.get(key) ?? reasons.set(key, new Set()).get(key)).add(why);

  const sweep = FULL_SWEEP.flatMap(({ diff, glob, why }) =>
    changed
      .filter((f) => matchesGlob(f, glob))
      .filter((f) => !diff || diff.test(git("diff", range, "--", f)))
      .map((f) => `${why} (\`${f}\`)`)
  );
  if (sweep.length > 0 && !waive) {
    for (const s of sections) touch(s.key, "full sweep");
  }

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
    if (isNoBehaviour(file) || changedOnlyInNonShippingBuilds(file, range)) continue;
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
  return { reasons, sweep, unmapped };
}

export function isTouched(reasons, section, row) {
  return reasons.has(section.key) || reasons.has(row.id);
}

/** The marks a person can add to a copy: untouched, automated, manual or both. */
const MARK = /· \*\*(untouched|automated|manual|both)\*\*(.*)$/;

/**
 * A release copy as a person has left it: per row whether its box is ticked, its mark and
 * what follows the mark (the tests, or the reason a row is driven anyway); the commit it
 * was generated at; the lines of its sign-off section; any full-sweep waiver; and the
 * release kind it was written for.
 */
export function readCopy(path) {
  const text = readFileSync(path, "utf8");
  const sha = /at `([0-9a-f]+)`/.exec(text)?.[1] ?? null;
  const rows = new Map();
  for (const line of text.split("\n")) {
    const row = /^- \[([ x])\] \*\*([A-Z]+-\d+)\*\*/.exec(line);
    if (!row) continue;
    const mark = MARK.exec(line);
    rows.set(row[2], {
      mark: mark?.[1] ?? null,
      tail: mark?.[2].trim() ?? "",
      ticked: row[1] === "x",
    });
  }
  const signOffAt = text.indexOf("\n## Sign-off");
  const signOff = signOffAt === -1 ? [] : text.slice(signOffAt + 1).split("\n");
  const waiver = /Waived: (.*)$/m.exec(text)?.[1] ?? null;
  const kind = /for a (patch|minor|major) release/.exec(text)?.[1] ?? null;
  return { kind, rows, sha, signOff, waiver };
}
