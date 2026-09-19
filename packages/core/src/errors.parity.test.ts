// The two halves of the error contract live in different languages and nothing
// compiles them together: `AppError::kind()` in Rust decides what goes on the
// wire, and `StorageErrorKind` here decides what the UI can branch on. A kind in
// one and not the other is not a type error, it is a downgrade to "Unknown" and a
// user told "Something went wrong" about a problem the backend had named.
//
// That is not hypothetical: `Network` reached the frontend for months as
// "Unknown", so an offline calendar connect read exactly like a bug.
//
// Read from the Rust source for the same reason the adapter's command test does:
// a list maintained by hand here would go stale in precisely the case worth
// catching.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { storageErrorUserMessage, toStorageError } from "./errors";

const ERROR_RS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/pikos-db/src/error.rs"
);

/** The string literals `AppError::kind()` maps its variants to. */
function rustKinds(): string[] {
  const source = readFileSync(ERROR_RS, "utf8");
  const body = source.split("pub fn kind(&self)")[1];
  if (!body) throw new Error("AppError::kind() not found — did error.rs move?");
  const arms = body.split("}")[0] ?? "";
  return [...arms.matchAll(/=>\s*"([A-Za-z]+)"/g)].map((m) => m[1]!).sort();
}

describe("StorageErrorKind matches AppError", () => {
  it("covers every kind the backend can send", () => {
    const fromRust = rustKinds();
    expect(fromRust.length).toBeGreaterThan(5);

    const missing = fromRust.filter((kind) => toStorageError({ kind, message: "x" }).kind !== kind);

    expect(missing, `these reach the UI as "Unknown": ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every kind copy of its own, never the catch-all", () => {
    const generic = storageErrorUserMessage(
      toStorageError({ kind: "Unknown", message: "x" }),
      "saving"
    );

    // Internal is deliberately the catch-all's twin: there is nothing useful to
    // say about it that "something went wrong" does not already say.
    const share = rustKinds().filter(
      (kind) =>
        kind !== "Internal" &&
        storageErrorUserMessage(toStorageError({ kind, message: "x" }), "saving") === generic
    );

    expect(
      share,
      `no written copy, so these read as a generic failure: ${share.join(", ")}`
    ).toEqual([]);
  });
});
