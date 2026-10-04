// A 20,000-page workspace for `@large` tests, built once and copied per test.
//
// `pikos stress seed --shape mixed` writes through the same writer the app uses, so building
// one takes seconds, too long to repeat per test. The first test that asks builds a template
// on disk; the bridge copies it for each `__large` token, which takes milliseconds. The file
// name carries everything that would make an old template wrong: the migrations, the
// seeder's source, the size, and the date its dates are spread around.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CACHE = join(ROOT, "apps/desktop/.e2e-cache");
const PAGES = 20_000;
/** A build takes well under a minute once the CLI is built; a lock older than this is a dead one. */
const LOCK_STALE_MS = 10 * 60_000;

/** The token suffix that tells the bridge to start from the template. */
export const LARGE_TOKEN_SUFFIX = "__large";

/** Where today's template lives for a lane whose clock reads `zone`. */
export function largeTemplatePath(zone: string): string {
  const hash = createHash("sha256");
  const migrations = join(ROOT, "crates/pikos-db/migrations");
  for (const file of readdirSync(migrations).sort()) {
    hash.update(file).update(readFileSync(join(migrations, file)));
  }
  hash.update(readFileSync(join(ROOT, "crates/pikos-cli/src/stress.rs")));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  return join(CACHE, `large-${PAGES}-${today}-${hash.digest("hex").slice(0, 12)}.sqlite`);
}

/**
 * Build the template if it isn't there. Workers race to it, so a directory made with `mkdir`
 * acts as the lock: one builds, the rest wait for the file to appear.
 */
export function ensureLargeTemplate(zone: string): string {
  const path = largeTemplatePath(zone);
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    // Another worker is building it. If that build died, its lock vanishes or goes stale
    // without the file appearing, and this worker takes over.
    while (!existsSync(path)) {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // The lock is gone: the build ended, and the next check sees whether it left a file.
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { force: true, recursive: true });
        if (!existsSync(path)) return ensureLargeTemplate(zone);
      }
      execFileSync("sleep", ["1"]);
    }
    return path;
  }
  try {
    execFileSync("cargo", ["build", "--release", "-p", "pikos-cli"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    const building = `${path}.building`;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${building}${suffix}`, { force: true });
    const today = path.match(/large-\d+-(\d{4}-\d{2}-\d{2})-/)![1]!;
    execFileSync(
      join(ROOT, "target/release/pikos"),
      [
        "--db",
        building,
        "stress",
        "seed",
        "--pages",
        String(PAGES),
        "--large-pages",
        "0",
        "--shape",
        "mixed",
        "--today",
        today,
        "--json",
      ],
      { stdio: "ignore" }
    );
    renameSync(building, path);
  } finally {
    rmSync(lock, { force: true, recursive: true });
  }
  return path;
}
