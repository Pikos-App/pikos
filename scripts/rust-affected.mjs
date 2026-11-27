#!/usr/bin/env node
// Which Rust gates a push needs, from the paths it changes (one per line on stdin).
//
// A crate is tested when the push changes it, or changes anything it depends on, or changes
// a file outside it that its tests read. The graph comes from `cargo metadata`, so a new
// dependency is picked up without editing this file. The files read across crate boundaries
// cannot come from Cargo, so they are listed below; a test that starts reading another one
// needs a line here, or a push changing only that file skips it. CI runs every crate on every
// pull request, so a gap here costs a later failure, never a missed one.
//
// Prints tab-separated lines for .husky/pre-push:
//   crates   all | space-separated workspace packages | empty
//   desktop  1 when the desktop crate (apps/desktop/src-tauri) needs its gates
//   swift    1 when the committed Swift bindings need regenerating and comparing
//   bridge   1 when pikos-cli is selected, whose tests run the parser bridge bundle
//   summary  one line for the hook to print

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP = "desktop crate";
const DESKTOP_DIR = "apps/desktop/src-tauri";

// Changing one of these can move every crate's outcome: the lockfiles and toolchain decide what
// compiles, and the hook and this script decide what runs.
const EVERYTHING = [
  /^Cargo\.(toml|lock)$/,
  /^\.cargo\//,
  /^rust-toolchain(\.toml)?$/,
  /^\.?rustfmt\.toml$/,
  /^clippy\.toml$/,
  /^scripts\/clippy\.sh$/,
  /^\.husky\/pre-push$/,
  /^scripts\/rust-affected\.mjs$/,
];

// Files outside a crate that its tests or build read, found by searching the crates for
// include_str!, CARGO_MANIFEST_DIR joins and relative paths.
const READ_ACROSS = [
  // pikos-core's markdown conformance test reads pikos-db's export table.
  [/^crates\/pikos-db\/tests\/fixtures\//, ["pikos-core"]],
  // pikos-db checks its content schema version against the TypeScript mirror.
  [/^packages\/core\/src\/types\.ts$/, ["pikos-db"]],
  // pikos-core's page menu is graded against the cases the TypeScript menu uses.
  [/^packages\/core\/src\/pages\/pageActions\.cases\.json$/, ["pikos-core"]],
  // pikos-db checks the CloudKit schema, and the desktop build links the Swift transport.
  [/^apps\/apple\/PikosSync\//, ["pikos-db", DESKTOP]],
  // The desktop crate's IPC tests read the read-command list out of the adapter.
  [/^apps\/desktop\/src\/shared\/adapters\/TauriSQLiteAdapter\.ts$/, [DESKTOP]],
  // pikos-cli's tests drive the parser bridge bundle, which esbuild builds from these.
  [
    /^(packages\/(pikos-bridge|core|recurrence-wasm)\/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|package\.json$)/,
    ["pikos-cli"],
  ],
];

// The bindings check compares generated output with what is committed, so a change to either
// side of the comparison needs it even when no crate changed.
const SWIFT_INPUTS = [
  /^apps\/ios\/PikosCore\/(Sources|generated)\//,
  /^scripts\/gen-swift-bindings\.sh$/,
];

function metadata(manifest) {
  const out = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--offline", "--manifest-path", manifest],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(out).packages;
}

// Every crate Pikos owns, keyed by name: its directory relative to the repo, and the crates it
// uses (normal, dev and build dependencies alike, since any of them can fail its tests).
export function loadGraph(root = ROOT) {
  const crates = new Map();
  const add = (pkg, name = pkg.name) =>
    crates.set(name, {
      dir: relative(root, dirname(pkg.manifest_path)),
      uses: pkg.dependencies.filter((d) => d.path).map((d) => relative(root, d.path)),
    });
  for (const pkg of metadata(resolve(root, "Cargo.toml"))) add(pkg);
  for (const pkg of metadata(resolve(root, DESKTOP_DIR, "Cargo.toml"))) add(pkg, DESKTOP);

  const byDir = new Map([...crates].map(([name, c]) => [c.dir, name]));
  for (const c of crates.values()) c.uses = c.uses.map((dir) => byDir.get(dir)).filter(Boolean);
  return crates;
}

export function select(paths, graph) {
  const everything = (path) => ({
    crates: "all",
    desktop: true,
    swift: true,
    bridge: true,
    summary: `Rust gates: every crate, because ${path} changed`,
  });
  const workspace = [...graph.keys()].filter((name) => name !== DESKTOP);
  const byDir = new Map([...graph].map(([name, c]) => [c.dir, name]));

  const changed = new Set();
  let swift = false;
  for (const path of paths) {
    if (EVERYTHING.some((re) => re.test(path))) return everything(path);
    if (SWIFT_INPUTS.some((re) => re.test(path))) swift = true;
    for (const [re, names] of READ_ACROSS) if (re.test(path)) names.forEach((n) => changed.add(n));

    if (path.startsWith(`${DESKTOP_DIR}/`)) changed.add(DESKTOP);
    const crateDir = path.match(/^crates\/[^/]+/)?.[0];
    if (crateDir) {
      const name = byDir.get(crateDir);
      // A directory under crates/ that is no workspace member: nothing says what reads it.
      if (!name) return everything(path);
      changed.add(name);
    }
  }

  // Everything that uses a changed crate, directly or through another.
  const selected = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, c] of graph) {
      if (!selected.has(name) && c.uses.some((u) => selected.has(u))) {
        selected.add(name);
        grew = true;
      }
    }
  }

  const crates = workspace.filter((n) => selected.has(n));
  const desktop = selected.has(DESKTOP);
  swift ||= selected.has("pikos-ffi");
  const chosen = desktop ? [...crates, DESKTOP] : crates;
  const skipped = graph.size - chosen.length;
  const summary =
    chosen.length === 0
      ? swift
        ? "Rust gates: Swift bindings only, no crate reads what the push changed"
        : "Rust gates skipped: nothing pushed that they read"
      : `Rust gates: ${chosen.join(", ")}` +
        (skipped ? `. Skipped ${skipped} crate(s) the push doesn't reach` : "");

  return {
    crates: crates.length === workspace.length ? "all" : crates.join(" "),
    desktop,
    swift,
    bridge: crates.includes("pikos-cli"),
    summary,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0, "utf8").split("\n").filter(Boolean);
  const s = select(paths, loadGraph());
  const line = (key, value) => process.stdout.write(`${key}\t${value}\n`);
  line("crates", s.crates);
  line("desktop", s.desktop ? 1 : 0);
  line("swift", s.swift ? 1 : 0);
  line("bridge", s.bridge ? 1 : 0);
  line("summary", s.summary);
}
