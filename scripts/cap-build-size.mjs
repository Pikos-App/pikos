#!/usr/bin/env node
// Keep a Cargo build folder under a size cap by removing its least recently used units first.
//
//   node scripts/cap-build-size.mjs <target-dir> [--max-gb N] [--dry-run] [--quiet]
//
// Cargo's build-dir layout keeps each compiled unit in a folder of its own,
// `<profile>/build/<package>/<hash>/`, and every change of features, profile or dependency
// version adds a new one beside the old, which nothing ever removes. rustc's incremental caches
// pile up the same way under `<profile>/incremental/<crate>-<hash>/`. Removing a unit is safe:
// Cargo sees its fingerprint gone and rebuilds it, with whatever depends on it, on the next build.
//
// cargo-sweep can't do this: it reads the older layout and finds nothing to remove in this one.
// If removing every unit wouldn't bring the folder under the cap, or Cargo's layout changes again
// and no units are found, the whole folder goes, as `cargo clean` would.

import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const GB = 1024 ** 3;

/** The unit a path inside the target folder belongs to, as its folder relative to the target, or
 *  null for anything that isn't inside one (uplifted binaries, `.d` files, bundles). */
export function unitOf(rel) {
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "build" && i + 2 < parts.length) return parts.slice(0, i + 3).join(sep);
    if (parts[i] === "incremental" && i + 1 < parts.length) return parts.slice(0, i + 2).join(sep);
  }
  return null;
}

/**
 * What to remove to bring `total` bytes under `cap`. `units` is a list of { path, bytes, usedMs },
 * where usedMs is when the unit was last built or read, so the least recently used go first.
 * Returns { remove: [paths], cleanAll } where cleanAll means even every unit wouldn't be enough.
 */
export function plan({ total, units, cap }) {
  if (total <= cap) return { cleanAll: false, remove: [] };
  const unitBytes = units.reduce((sum, u) => sum + u.bytes, 0);
  if (total - unitBytes > cap) return { cleanAll: true, remove: [] };
  const remove = [];
  let left = total;
  for (const unit of [...units].sort((a, b) => a.usedMs - b.usedMs)) {
    if (left <= cap) break;
    remove.push(unit.path);
    left -= unit.bytes;
  }
  return { cleanAll: false, remove };
}

/** Bytes on disk for the whole folder, and bytes and last use for each unit in it. A hard link counts
 *  once toward the total, since Cargo links its uplifted binaries to a unit's output. */
function measure(target) {
  const seen = new Set();
  const units = new Map();
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const st = lstatSync(path);
      const bytes = st.blocks * 512;
      const key = `${st.dev}:${st.ino}`;
      if (!seen.has(key)) {
        seen.add(key);
        total += bytes;
      }
      const unit = unitOf(relative(target, path));
      if (!unit) continue;
      const u = units.get(unit) ?? { bytes: 0, path: unit, usedMs: 0 };
      u.bytes += bytes;
      // Cargo reads a unit's fingerprint on every build that uses it, so a dependency built
      // weeks ago and used today counts as today's, where its mtime alone would put it first out.
      u.usedMs = Math.max(u.usedMs, st.atimeMs, st.mtimeMs);
      units.set(unit, u);
    }
  };
  walk(target);
  return { total, units: [...units.values()] };
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      "max-gb": { default: "15", type: "string" },
      quiet: { type: "boolean" },
    },
  });
  const [target] = positionals;
  const maxGb = Number(values["max-gb"]);
  const dryRun = values["dry-run"];
  const quiet = values.quiet;
  const log = (line) => console.log(`[cap-build-size] ${line}`);
  const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

  if (!target || !(maxGb > 0)) {
    console.error("usage: node scripts/cap-build-size.mjs <target-dir> [--max-gb N] [--dry-run] [--quiet]");
    process.exit(2);
  }

  const { total, units } = measure(target);
  const cap = maxGb * GB;
  const { cleanAll, remove } = plan({ cap, total, units });

  if (cleanAll) {
    log(`${target} is ${gb(total)}, over the ${maxGb} GB cap even without its build units; ${dryRun ? "would remove" : "removing"} all of it`);
    if (!dryRun) rmSync(target, { force: true, recursive: true });
    return;
  }
  if (remove.length === 0) {
    if (!quiet) log(`${target} is ${gb(total)}, under the ${maxGb} GB cap`);
    return;
  }
  const byPath = new Map(units.map((u) => [u.path, u.bytes]));
  const freed = remove.reduce((sum, p) => sum + byPath.get(p), 0);
  log(`${target} is ${gb(total)}; ${dryRun ? "would remove" : "removing"} its ${remove.length} least recently used build units, ${gb(freed)}, to get under ${maxGb} GB`);
  if (!dryRun) for (const p of remove) rmSync(join(target, p), { force: true, recursive: true });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
