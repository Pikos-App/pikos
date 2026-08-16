// Reading a scenario table the Rust writers also run, without the silent half.
//
// The Rust structs carry `#[serde(deny_unknown_fields)]`, so a fixture that grows
// a step op or an expectation key stops that runner dead until someone handles it.
// `JSON.parse` behind an `as` cast gives this side nothing of the kind: an op the
// switch has no arm for falls through as a no-op, an expectation key nothing reads
// is simply never asserted, and the row passes either way — against a mock that
// never did the work the row describes.
//
// The asymmetry is what makes it dangerous rather than merely uneven. The Rust
// failure is what prompts the edit, so the fixture and the Rust runner move
// together while this side stays behind, and the table quietly becomes a
// one-sided test that still reads like a two-sided one.

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

/**
 * Load `<name>-lifecycle.json` and reject any expectation key this runner does not
 * read. Callers pass `Object.keys(CHECKS)` — the keys of the record that holds the
 * assertions — so the set cannot name a key nothing asserts.
 *
 * Step ops are deliberately *not* checked here: a `default:` arm that throws covers
 * them at the point of dispatch, where the set is the switch itself.
 */
export function readConformanceTable<T extends Scenario>(
  name: string,
  expectKeys: readonly string[]
): { scenarios: T[] } & Record<string, unknown> {
  const table = JSON.parse(readFileSync(resolve(FIXTURES, `${name}-lifecycle.json`), "utf8")) as {
    scenarios: T[];
  } & Record<string, unknown>;

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

/** The `default:` arm every step switch needs. Returning instead would make an
 *  op the Rust runner enforces into a no-op here, and the scenario would pass. */
export function unhandledStep(table: string, op: string): never {
  throw new Error(
    `${table}-lifecycle.json uses the step "${op}", which this runner has no arm for. ` +
      `The Rust runner enforces it; skipping it here would pass the row without doing the work.`
  );
}
