// Runs against the real crate graph, so a new dependency between crates shows up here as a
// changed selection rather than as a push that quietly skips a crate it reaches.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP, loadGraph, select } from "./rust-affected.mjs";

const graph = loadGraph();
const pick = (...paths) => select(paths, graph);
const names = (s) => (s.crates === "all" ? "all" : s.crates.split(" ").filter(Boolean));

test("a change to the CLI alone tests the CLI alone", () => {
  const s = pick("crates/pikos-cli/src/main.rs");
  assert.deepEqual(names(s), ["pikos-cli"]);
  assert.equal(s.desktop, false);
  assert.equal(s.swift, false);
});

test("a change to the desktop crate alone leaves the workspace alone", () => {
  const s = pick("apps/desktop/src-tauri/src/lib.rs");
  assert.deepEqual(names(s), []);
  assert.equal(s.desktop, true);
  assert.equal(s.swift, false);
});

test("a change to the data layer reaches everything built on it, and nothing under it", () => {
  const s = pick("crates/pikos-db/src/reconciler.rs");
  for (const crate of ["pikos-db", "pikos-calendar-sync", "pikos-cli", "pikos-ffi"]) {
    assert.ok(names(s).includes(crate), `${crate} uses pikos-db`);
  }
  for (const crate of ["pikos-core", "pikos-recurrence", "pikos-replica"]) {
    assert.ok(!names(s).includes(crate), `pikos-db uses ${crate}, not the other way round`);
  }
  assert.equal(s.desktop, true);
  assert.equal(s.swift, true);
});

test("a change to the recurrence engine reaches every crate that uses it", () => {
  const s = pick("crates/pikos-recurrence/src/lib.rs");
  for (const crate of [
    "pikos-recurrence",
    "pikos-recurrence-wasm",
    "pikos-core",
    "pikos-db",
    "pikos-calendar-sync",
    "pikos-cli",
    "pikos-ffi",
  ]) {
    assert.ok(names(s).includes(crate), `${crate} uses pikos-recurrence`);
  }
  assert.ok(!names(s).includes("pikos-replica"));
  assert.equal(s.desktop, true);
});

test("a change to the FFI crate checks the Swift bindings and nothing else", () => {
  const s = pick("crates/pikos-ffi/src/lib.rs");
  assert.deepEqual(names(s), ["pikos-ffi"]);
  assert.equal(s.desktop, false);
  assert.equal(s.swift, true);
});

test("a lockfile, toolchain or gate change selects everything", () => {
  for (const path of [
    "Cargo.lock",
    "Cargo.toml",
    ".cargo/config.toml",
    ".husky/pre-push",
    "scripts/rust-affected.mjs",
  ]) {
    const s = pick(path);
    assert.equal(s.crates, "all", path);
    assert.equal(s.desktop, true, path);
    assert.equal(s.swift, true, path);
  }
});

test("a directory under crates/ that is no crate selects everything", () => {
  const s = pick("crates/pikos-something-new/src/lib.rs");
  assert.equal(s.crates, "all");
  assert.match(s.summary, /pikos-something-new/);
});

test("the TypeScript core reaches Rust only through the files Rust tests read", () => {
  assert.deepEqual(names(pick("packages/core/src/nlp/parser.ts")), []);

  const types = pick("packages/core/src/types.ts");
  assert.ok(names(types).includes("pikos-db"), "pikos-db reads the schema version mirror");

  const cases = pick("packages/core/src/pages/pageActions.cases.json");
  assert.ok(names(cases).includes("pikos-core"), "pikos-core reads the page menu cases");
});

test("files read across crate boundaries select their readers", () => {
  assert.ok(
    names(pick("crates/pikos-db/tests/fixtures/markdown-export.json")).includes("pikos-core")
  );
  assert.equal(pick("apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts").desktop, true);
  assert.ok(names(pick("apps/apple/PikosSync/cloudkit-schema.ckdb")).includes("pikos-db"));
});

test("the committed Swift bindings are checked when they change, with no crate", () => {
  const s = pick("apps/ios/PikosCore/Sources/PikosCore/pikos_ffi.swift");
  assert.deepEqual(names(s), []);
  assert.equal(s.desktop, false);
  assert.equal(s.swift, true);
});

test("a docs or app-only change runs no Rust gate", () => {
  for (const path of ["docs/sync.md", "apps/desktop/src/features/calendar/WeekGrid.tsx"]) {
    const s = pick(path);
    assert.deepEqual(names(s), [], path);
    assert.equal(s.desktop, false, path);
    assert.equal(s.swift, false, path);
    assert.match(s.summary, /skipped/, path);
  }
});

test("the desktop crate is in the graph with the crates it uses", () => {
  assert.ok(graph.get(DESKTOP)?.uses.includes("pikos-db"));
});
