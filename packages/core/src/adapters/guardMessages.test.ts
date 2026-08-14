// The mock's copied guard messages, checked against the writers they came from.
//
// These strings are the ones a user actually reads when a write is refused, and
// the mock is the only place any test sees them. Reword the Rust side and nothing
// here fails: the mock keeps answering with the old wording and every assertion
// against it still passes, so the drift surfaces in the product rather than in CI.
// Reading the Rust source is the point — an exported constant on the TypeScript
// side could only ever agree with itself.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIRRORED_GUARD_MESSAGES } from "./MockStorageAdapter";

const CRATE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../crates/pikos-db/src");

// The two writer modules that raise them. A message defined anywhere else is one
// the mock should not have been copying in the first place.
const RUST_SOURCE = ["sync.rs", "pages.rs"]
  .map((file) => readFileSync(resolve(CRATE, file), "utf8"))
  .join("\n");

describe("mirrored guard messages", () => {
  it("covers every guard the mock reproduces", () => {
    expect(Object.keys(MIRRORED_GUARD_MESSAGES).length).toBeGreaterThanOrEqual(8);
  });

  for (const [name, message] of Object.entries(MIRRORED_GUARD_MESSAGES)) {
    it(`${name} still matches the writer's wording`, () => {
      expect(
        RUST_SOURCE.includes(message),
        `MockStorageAdapter answers with a message pikos-db no longer raises:\n  ${message}`
      ).toBe(true);
    });
  }
});
