// The mock's copied guard messages, checked against the writers they came from —
// in both directions, because only one of them is the direction that bites.
//
// These strings are the ones a user actually reads when a write is refused, and
// the mock is the only place any test sees them. Reword the Rust side and nothing
// fails by itself: the mock keeps answering with the old wording and every
// assertion against it still passes, so the drift surfaces in the product rather
// than in CI. Reading the Rust source is the point — an exported constant on the
// TypeScript side could only ever agree with itself.
//
// The reverse direction is the one that already cost a divergence. A guard the
// writers raise and the mock has never heard of leaves no stale string to catch:
// the mock simply allows the write, and an e2e written against it asserts the
// permissive behavior as if it were the product's. So the sweep below is over the
// Rust source, not over the mock's table, and a new `AppError::Conflict` fails
// here until the mock either mirrors it or is recorded as out of reach.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIRRORED_GUARD_MESSAGES } from "./MockStorageAdapter";

const CRATE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../crates/pikos-db/src");

/** Every writer module. Deliberately not a hand-listed subset: the guard that
 *  prompted this check lived in the one file the list had left out. */
function rustSources(): { file: string; text: string }[] {
  return readdirSync(CRATE, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".rs") && !e.name.includes("_tests"))
    .map((e) => ({
      file: e.name,
      text: readFileSync(join(e.parentPath ?? CRATE, e.name), "utf8"),
    }));
}

/** `AppError::Conflict` is the refusal a user reads; the other variants are
 *  plumbing (`Db`, `Io`, `Serde`) or carry an interpolated id rather than a
 *  message the mock could reproduce. Its argument is either the literal or a
 *  `const … : &str` one or more call sites share, so both are resolved. */
function rustGuardMessages(): Map<string, string> {
  const sources = rustSources();
  const blob = sources.map((s) => s.text).join("\n");

  const consts = new Map<string, string>();
  for (const m of blob.matchAll(
    /const\s+([A-Z0-9_]+)\s*:\s*&'?\w*\s*str\s*=\s*"((?:[^"\\]|\\.)*)"/g
  )) {
    consts.set(m[1]!, m[2]!);
  }

  const found = new Map<string, string>();
  for (const { file, text } of sources) {
    for (const m of text.matchAll(
      /AppError::Conflict\(\s*(?:crate::[\w:]*::)?([A-Z][A-Z0-9_]*|"(?:[^"\\]|\\.)*")/g
    )) {
      const token = m[1]!;
      const message = token.startsWith('"') ? token.slice(1, -1) : consts.get(token);
      if (message) found.set(message, file);
    }
  }
  return found;
}

/** A refusal the mock cannot meaningfully reach, with the reason it can't. Empty
 *  is the healthy state — an entry here is a hole in mock fidelity that has been
 *  looked at and accepted, not a place to silence a failure. */
const OUT_OF_MOCK_REACH: Record<string, string> = {};

describe("mirrored guard messages", () => {
  const rustMessages = rustGuardMessages();
  const mirrored = new Set<string>(Object.values(MIRRORED_GUARD_MESSAGES));

  it("finds the writers' refusals at all", () => {
    expect(
      rustMessages.size,
      "the AppError::Conflict sweep matched nothing — the extraction has drifted from the Rust source, not the guards"
    ).toBeGreaterThanOrEqual(8);
  });

  for (const [name, message] of Object.entries(MIRRORED_GUARD_MESSAGES)) {
    it(`${name} still matches the writer's wording`, () => {
      expect(
        rustMessages.has(message),
        `MockStorageAdapter answers with a message pikos-db no longer raises:\n  ${message}`
      ).toBe(true);
    });
  }

  for (const [message, file] of rustMessages) {
    it(`the mock reproduces the refusal ${file} raises: "${message}"`, () => {
      if (message in OUT_OF_MOCK_REACH) return;
      expect(
        mirrored.has(message),
        `${file} refuses a write the mock allows. Every e2e and adapter test runs ` +
          `against the mock, so the guard is invisible to all of them until it is ` +
          `mirrored in MIRRORED_GUARD_MESSAGES and enforced on the matching method ` +
          `— or recorded in OUT_OF_MOCK_REACH with why it can't be.`
      ).toBe(true);
    });
  }
});
