// Nothing compiles the two halves together: `AppError::kind()` in Rust decides what goes on the
// wire and `StorageErrorKind` decides what the UI can branch on. A kind in one and not the other
// is not a type error but a downgrade to "Unknown" ("Something went wrong" about a problem the
// backend named), as `Network` once was. It reads the Rust source because a hand-kept list would
// go stale in exactly the case worth catching.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { storageErrorUserMessage, toStorageError } from "./errors";

const ERROR_RS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/pikos-db/src/error.rs"
);

function rustKinds(): string[] {
  const source = readFileSync(ERROR_RS, "utf8");
  const body = source.split("pub fn kind(&self)")[1];
  if (!body) throw new Error("AppError::kind() not found — did error.rs move?");
  const arms = body.split("impl Serialize")[0] ?? "";
  // Only `AppError::<Variant> => "X"` arms: a helper beside kind() returning its own names (the
  // sqlx classifier) is not a kind.
  return [...arms.matchAll(/AppError::\w+[^=]*=>\s*"([A-Za-z]+)"/g)].map((m) => m[1]!).sort();
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

    // Internal is the catch-all's twin: "something went wrong" already says everything about it.
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
