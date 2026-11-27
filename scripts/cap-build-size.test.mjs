import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { plan, unitOf } from "./cap-build-size.mjs";

test("a file belongs to its build unit or incremental cache", () => {
  assert.equal(unitOf("debug/build/tauri/2512bc14/out/x.rs"), "debug/build/tauri/2512bc14");
  assert.equal(
    unitOf("aarch64-apple-ios/release/build/pikos-core/ab12/deps/lib.rlib"),
    "aarch64-apple-ios/release/build/pikos-core/ab12"
  );
  assert.equal(unitOf("debug/incremental/pikos-1x2y/s-abc/dep-graph.bin"), "debug/incremental/pikos-1x2y");
  assert.equal(unitOf("debug/pikos"), null);
  assert.equal(unitOf("release/bundle/macos/Pikos.app/Contents/Info.plist"), null);
});

const unit = (path, bytes, usedMs) => ({ bytes, path, usedMs });

test("under the cap, nothing goes", () => {
  assert.deepEqual(plan({ cap: 10, total: 10, units: [unit("a", 5, 1)] }), {
    cleanAll: false,
    remove: [],
  });
});

test("over the cap, the least recently used units go first, only as many as it takes", () => {
  const units = [unit("new", 4, 300), unit("old", 3, 100), unit("mid", 3, 200)];
  assert.deepEqual(plan({ cap: 10, total: 15, units }), { cleanAll: false, remove: ["old", "mid"] });
});

test("when every unit isn't enough, the whole folder goes", () => {
  assert.deepEqual(plan({ cap: 10, total: 30, units: [unit("a", 5, 1)] }), {
    cleanAll: true,
    remove: [],
  });
});

test("a layout with no units the sweep recognises is cleaned whole once over the cap", () => {
  assert.deepEqual(plan({ cap: 10, total: 11, units: [] }), { cleanAll: true, remove: [] });
});

test("on a real folder, the least recently used unit goes, counting a read as a use", () => {
  const target = mkdtempSync(join(tmpdir(), "cap-build-size-"));
  try {
    const mb = Buffer.alloc(1024 * 1024, 1);
    const daysAgo = (n) => Date.now() / 1000 - n * 86400;
    const file = (rel, { builtDaysAgo, readDaysAgo }) => {
      const path = join(target, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, mb);
      utimesSync(path, daysAgo(readDaysAgo), daysAgo(builtDaysAgo));
    };
    // A dependency built a month ago that today's build still reads, a variant built last week
    // that nothing has read since, and the uplifted binary, which is in no unit.
    file("debug/build/serde/dep/deps/a", { builtDaysAgo: 30, readDaysAgo: 0 });
    file("debug/build/pikos/stale/deps/a", { builtDaysAgo: 7, readDaysAgo: 7 });
    file("debug/pikos", { builtDaysAgo: 0, readDaysAgo: 0 });
    // 3 MB in all against a cap of 2.5 MB: removing one unit is enough.
    const capGb = String((2.5 * 1024 * 1024) / 1024 ** 3);
    execFileSync("node", [join(import.meta.dirname, "cap-build-size.mjs"), target, "--max-gb", capGb]);
    assert.equal(existsSync(join(target, "debug/build/pikos/stale")), false);
    assert.equal(existsSync(join(target, "debug/build/serde/dep")), true);
    assert.equal(existsSync(join(target, "debug/pikos")), true);
  } finally {
    rmSync(target, { force: true, recursive: true });
  }
});
