// What the QA scripts share: the master's sections and rows, which files ship behaviour,
// and how a changed file reaches a section or a row. Imports are followed one step, because
// further reaches everything through the shared state layer. `@pikos/core` resolves to
// its index for every importer, so a core module is followed only into files whose
// import from it names one of the module's exports, and the index itself into nothing.
//
// A manual row reaches only through its own code (PKOS-0145): a row with a `paths:` line of
// its own ignores its section's, and its paths match only the files they name, never a file
// one import away. Section paths stay for the rows a test takes.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MASTER = join(ROOT, ".agent/qa/full-qa-checklist.md");
/** Row → the day a person last drove it, written when a release copy is signed off. */
export const LEDGER = join(ROOT, ".agent/qa/ledger.json");
const CORE_INDEX = "packages/core/src/index.ts";

/** Files nearly everything is imported into, so importing a changed file is no evidence a row
 *  changed. A row reaches one only through a change to the file itself. */
const HUBS = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/main.tsx",
  "apps/desktop/src-tauri/src/lib.rs",
  "apps/desktop/src-tauri/src/db/commands.rs",
  "apps/desktop/src-tauri/src/db/mod.rs",
];

/** Rows that check the signed artifact, which is new every release whatever the code did. */
export const RELEASE_BUILD_ROWS = ["INST-02", "UPD-02", "UPD-03", "CLI-01"];

/** The rows each library underlies, keyed by row or whole section. A library that moved and
 *  matches nothing here is listed on the copy for a person to judge, not swept onto every row. */
export const LIBRARIES = [
  {
    keys: ["WIN", "NOTIF", "INST", "UPD"],
    packages: ["tauri", "tauri-*", "@tauri-apps/*", "wry", "tao"],
    why: "Tauri",
  },
  {
    keys: ["SYNC-01", "SYNC-02", "SYNC-04", "PRIV-01"],
    packages: [
      "rustls*",
      "webpki*",
      "reqwest",
      "hyper",
      "hyper-*",
      "h2",
      "quinn*",
      "tokio-rustls",
      "security-framework*",
      "openssl*",
    ],
    why: "the HTTPS stack",
  },
  {
    keys: ["SYNC-05", "SYNC-28"],
    packages: ["keyring*", "security-framework*"],
    why: "the keychain",
  },
  {
    keys: ["EDIT-13", "EDIT-14", "EDIT-15", "EDIT-16", "EDIT-19", "PERF-04"],
    packages: ["@tiptap/*", "prosemirror-*"],
    why: "the editor",
  },
  {
    keys: ["IMP-03", "EXP-04"],
    packages: ["pulldown-cmark", "markdown-it*"],
    why: "Markdown",
  },
  { keys: ["UPD-01"], packages: ["sqlx*", "libsqlite3-sys"], why: "SQLite" },
];

const LOCKFILES = "{pnpm-lock.yaml,**/Cargo.lock}";

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

/**
 * A row's own path: a glob, or `glob#regex` when the file is shared and only the lines the
 * pattern names are this row's.
 */
function rowPath(entry) {
  const at = entry.indexOf("#");
  if (at === -1) return { glob: entry, pattern: null };
  return { glob: entry.slice(0, at), pattern: new RegExp(entry.slice(at + 1)) };
}

/** Sections in master order, each with its globs and rows, and a row with its own `paths:`
 *  line, indented under it, with those. Lines are kept so the copy can be written back with
 *  only the marks added. */
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
    const lastRow = section.rows.at(-1);
    const isRowPaths = line.startsWith("  paths: ") && lastRow?.line === i - 1;
    if (isRowPaths) lastRow.paths = [...line.matchAll(/`([^`]+)`/g)].map((m) => rowPath(m[1]));
    const row = /^- \[[ x]\] \*\*([A-Z]+-\d+)\*\*/.exec(line);
    if (row) {
      section.rows.push({
        id: row[1],
        line: i,
        manualForGood: line.includes("· 🧑"),
        packagedApp: line.includes("· 🧑 (packaged app)"),
        paths: null,
      });
    }
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
  if (file === CORE_INDEX) return [];
  const direct = (graph.get(file) ?? []).filter((f) => !isNoBehaviour(f) && !HUBS.includes(f));
  if (!direct.includes(CORE_INDEX)) return direct;
  const names = new Set(exportedNames(file));
  const viaCore = (graph.get(CORE_INDEX) ?? []).filter((f) => {
    if (isNoBehaviour(f) || HUBS.includes(f) || !existsSync(join(ROOT, f))) return false;
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

export function readLedger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
}

export function isNoBehaviour(file) {
  return NO_BEHAVIOUR.some((glob) => matchesGlob(file, glob));
}

/** A `cfg` attribute for a build no release carries. */
const NON_SHIPPING_CFG = /^#\[cfg\(feature = "(bench|e2e-bridge)"\)\]$/;

/** A changed line no person could see: a comment, or a hook only tests read. */
const SHIPS_NOTHING = /^(\/\/|\/\*|\*|data-testid=)/;

const diffs = new Map();

/** The lines `file` added or removed over `range`, trimmed. */
function changedLines(file, range) {
  const key = `${range}\0${file}`;
  if (!diffs.has(key)) {
    const lines = git("diff", "--unified=0", range, "--", file)
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
      .map((l) => l.slice(1).trim());
    diffs.set(key, lines);
  }
  return diffs.get(key);
}

/**
 * Whether every line a Rust file changed over `range` is a non-shipping `cfg` attribute or the
 * one line it guards, so the file changed only in builds no release carries.
 */
export function changedOnlyInNonShippingBuilds(file, range) {
  if (!file.endsWith(".rs")) return false;
  const lines = changedLines(file, range);
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

/** Whether a change to `file` reaches a row's own path: a line it changed ships and, when the
 *  path has a pattern, matches it. A diff with no lines, like an image's, reaches. */
function reachesRowPath(file, range, { pattern }) {
  const lines = changedLines(file, range).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.some((l) => !SHIPS_NOTHING.test(l) && (!pattern || pattern.test(l)));
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

/** Package name → the versions a lockfile pins at `rev`. */
function lockedVersions(path, rev) {
  let text;
  try {
    text = execFileSync("git", ["-C", ROOT, "show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Map();
  }
  const versions = new Map();
  const add = (name, version) =>
    (versions.get(name) ?? versions.set(name, new Set()).get(name)).add(version);
  if (path.endsWith("Cargo.lock")) {
    // A crate of this workspace has no `source`; its changes reach rows as files.
    const fetched = /^name = "([^"]+)"\nversion = "([^"]+)"\nsource = /gm;
    for (const m of text.matchAll(fetched)) add(m[1], m[2]);
    return versions;
  }
  const packages = text.split(/^packages:$/m)[1]?.split(/^\S/m)[0] ?? "";
  for (const m of packages.matchAll(/^ {2}'?((?:@[^/\s]+\/)?[^@\s']+)@([^':\s(]+)/gm)) {
    add(m[1], m[2]);
  }
  return versions;
}

/** The libraries added, removed or moved to another version across `range`. */
function movedLibraries(changed, range) {
  const [from, to] = range.split("..");
  const moved = new Set();
  for (const lockfile of changed.filter((f) => matchesGlob(f, LOCKFILES))) {
    const before = lockedVersions(lockfile, from);
    const after = lockedVersions(lockfile, to);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const was = [...(before.get(name) ?? [])].sort().join();
      const is = [...(after.get(name) ?? [])].sort().join();
      if (was !== is) moved.add(name);
    }
  }
  return [...moved].sort();
}

const MIGRATIONS = "crates/pikos-db/migrations/**";
const TAURI_CONF = "apps/desktop/src-tauri/tauri.conf.json";
/** What the shipped policy reads: the CSP, the asset protocol's scope and the capabilities. */
const POLICY_LINE = /"(csp|assetProtocol|scope|capabilities)"/;

/**
 * What a range of commits touches. `reasons` maps a section key, reached through the section's
 * paths, or a row ID to why. A changed spec touches every row its tests take, because a proof
 * lasts only until the test changes. A migration touches the upgrade row, and the shipped policy
 * the rows that need the packaged app. `libraries` lists what moved in a lockfile and reached no
 * row; `unmapped`, changed files that ship behaviour and reach nothing.
 */
export function touches({ automated, graph, range, sections }) {
  const changed = git("diff", "--name-only", range).split("\n").filter(Boolean);
  const reasons = new Map();
  const touch = (key, why) => (reasons.get(key) ?? reasons.set(key, new Set()).get(key)).add(why);
  const rows = sections.flatMap((s) => s.rows);
  const rowsOf = (key) => sections.find((s) => s.key === key)?.rows.map((r) => r.id) ?? [key];

  const libraries = [];
  for (const name of movedLibraries(changed, range)) {
    const served = LIBRARIES.filter(({ packages }) => packages.some((p) => matchesGlob(name, p)));
    if (served.length === 0) libraries.push(name);
    for (const { keys, why } of served) {
      for (const id of keys.flatMap(rowsOf)) touch(id, `${why} moved (\`${name}\`)`);
    }
  }

  for (const file of changed.filter((f) => matchesGlob(f, MIGRATIONS))) {
    touch("UPD-01", `a migration changed (\`${file}\`)`);
  }

  const policyChanged =
    changed.includes(TAURI_CONF) &&
    changedLines(TAURI_CONF, range).some((l) => POLICY_LINE.test(l));
  if (policyChanged) {
    for (const id of [...rows.filter((r) => r.packagedApp).map((r) => r.id), ...rowsOf("PROD")]) {
      touch(id, "the shipped policy changed");
    }
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
    for (const row of rows.filter((r) => r.paths)) {
      const isOwn = row.paths.some(
        (p) => matchesGlob(file, p.glob) && reachesRowPath(file, range, p)
      );
      if (isOwn) touch(row.id, `\`${file}\``);
      reached ||= isOwn;
    }
    if (!reached && !matchesGlob(file, LOCKFILES)) unmapped.push(file);
  }
  return { libraries, reasons, unmapped };
}

/** A row with its own paths is reached only through them, never through its section's. */
export function isTouched(reasons, section, row) {
  return reasons.has(row.id) || (!row.paths && reasons.has(section.key));
}

/** Whether `reasons` reaches any row of the master. */
export function reachesAnyRow(reasons, sections) {
  return sections.some((s) => s.rows.some((row) => isTouched(reasons, s, row)));
}

/** The marks a person can add to a copy: untouched, automated, manual, both or deferred. */
const MARK = /· \*\*(untouched|automated|manual|both|deferred)\*\*(.*)$/;

/**
 * A release copy as a person has left it: per row whether its box is ticked, its mark and
 * what follows the mark (the tests, or the reason a row is driven anyway or deferred); the commit it
 * was generated at; the build its ticked rows were driven on, when the copy names one; the lines
 * of its sign-off section; and the release kind it was written for.
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
  const drivenOn = /driven on `([0-9a-f]+)`/.exec(text)?.[1] ?? null;
  const kind = /for a (patch|minor|major) release/.exec(text)?.[1] ?? null;
  return { drivenOn, kind, rows, sha, signOff };
}
