// Reads a scenario table the Rust writers also run, without the silent half. Their structs carry
// `#[serde(deny_unknown_fields)]`, so a fixture that grows a step op or expectation key stops the
// Rust runner until someone handles it. `JSON.parse` behind a cast does nothing of the kind: an
// unhandled op is a no-op and an unread expectation key is never asserted, so the row passes
// against a mock that never did the work. The Rust failure prompts the edit, so the fixture and
// Rust move together while this side lags, and the table becomes one-sided while reading two-sided.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/pikos-db/tests/fixtures"
);

interface Scenario {
  name: string;
  steps: { op: string }[];
  expect: Record<string, unknown>;
}

/** The shared fixture directory the Rust runners `include_str!`. */
export function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, fileName), "utf8")) as T;
}

/**
 * Loads `<name>-lifecycle.json` and rejects any expectation key this runner does not read.
 * Callers pass `Object.keys(CHECKS)` from a `Record<keyof Expect, ...>` of assertions, so a key
 * added to `Expect` does not compile until it has a checker, and the set can't name a key
 * nothing asserts.
 *
 * Step ops are not checked here: a throwing `default:` arm covers them where they dispatch.
 */
export function readConformanceTable<T extends Scenario>(
  name: string,
  expectKeys: readonly string[]
): { scenarios: T[] } & Record<string, unknown> {
  const table = readFixture<{ scenarios: T[] } & Record<string, unknown>>(`${name}-lifecycle.json`);

  if (!Array.isArray(table.scenarios) || table.scenarios.length === 0) {
    throw new Error(`${name}-lifecycle.json has no scenarios`);
  }

  const known = new Set(expectKeys);
  for (const scenario of table.scenarios) {
    for (const key of Object.keys(scenario.expect ?? {})) {
      if (known.has(key)) continue;
      throw new Error(
        `${name}-lifecycle.json scenario "${scenario.name}" expects "${key}", which this ` +
          `runner never reads — the row would pass against the mock without asserting it. ` +
          `Assert it here and add it to the runner's expectKeys.`
      );
    }
  }
  return table;
}

/** The `default:` arm every step switch needs: returning would make an op the Rust runner
 *  enforces a no-op here, and the scenario would pass. */
export function unhandledStep(table: string, op: string): never {
  throw new Error(
    `${table}-lifecycle.json uses the step "${op}", which this runner has no arm for. ` +
      `The Rust runner enforces it; skipping it here would pass the row without doing the work.`
  );
}
