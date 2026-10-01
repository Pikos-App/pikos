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
  "packages/core/src/adapters/{MockStorage,Noop}*",
  "apps/desktop/src/shared/adapters/{inMemoryStorage,mockStorageChunk}*",
  "apps/desktop/src-tauri/src/{e2e_*.rs,bin/e2e_*.rs}",
  "apps/desktop/src-tauri/src/db/dev/seed*.rs",
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
