import { describe, expect, it } from "vitest";

import {
  isStorageError,
  StorageError,
  type StorageErrorKind,
  storageErrorUserMessage,
  toStorageError,
} from "./errors";

describe("toStorageError", () => {
  it("passes an existing StorageError through unchanged", () => {
    const original = new StorageError("Conflict", "raw");
    expect(toStorageError(original)).toBe(original);
  });

  it.each<StorageErrorKind>(["Db", "NotFound", "Conflict", "Io", "Serde", "Invalid", "Internal"])(
    "recognises the Rust AppError wire shape with kind=%s",
    (kind) => {
      const result = toStorageError({ kind, message: "raw backend text" });
      expect(result).toBeInstanceOf(StorageError);
      expect(result.kind).toBe(kind);
      expect(result.message).toBe("raw backend text");
    }
  );

  it("preserves the original payload as cause for log scrubbing", () => {
    const raw = { kind: "Db", message: "near WHERE: syntax error" };
    expect(toStorageError(raw).cause).toBe(raw);
  });

  it("downgrades an unrecognised kind string to Unknown", () => {
    const result = toStorageError({ kind: "Banana", message: "x" });
    expect(result.kind).toBe("Unknown");
    expect(result.message).toBe("x");
  });

  it("downgrades a non-string kind to Unknown", () => {
    const result = toStorageError({ kind: 42, message: "x" });
    expect(result.kind).toBe("Unknown");
  });

  it("stringifies a non-string message field", () => {
    const result = toStorageError({ kind: "Db", message: 500 });
    expect(result.kind).toBe("Db");
    expect(result.message).toBe("500");
  });

  it("wraps a plain Error as Unknown with the original message", () => {
    const err = new Error("boom");
    const result = toStorageError(err);
    expect(result.kind).toBe("Unknown");
    expect(result.message).toBe("boom");
    expect(result.cause).toBe(err);
  });

  it("wraps a plain string thrown value as Unknown", () => {
    const result = toStorageError("oops");
    expect(result.kind).toBe("Unknown");
    expect(result.message).toBe("oops");
  });

  it("wraps null as Unknown", () => {
    const result = toStorageError(null);
    expect(result.kind).toBe("Unknown");
  });

  it("wraps undefined as Unknown", () => {
    const result = toStorageError(undefined);
    expect(result.kind).toBe("Unknown");
  });
});

describe("isStorageError", () => {
  it("returns true for StorageError instances", () => {
    expect(isStorageError(new StorageError("Db", "x"))).toBe(true);
  });

  it("returns false for plain Error instances", () => {
    expect(isStorageError(new Error("x"))).toBe(false);
  });

  it("returns false for the raw wire shape", () => {
    expect(isStorageError({ kind: "Db", message: "x" })).toBe(false);
  });
});

describe("storageErrorUserMessage", () => {
  function err(kind: StorageErrorKind, message = "raw"): StorageError {
    return new StorageError(kind, message);
  }

  it("interpolates the verb for kind-specific copy", () => {
    expect(storageErrorUserMessage(err("Conflict"), "saving page")).toContain("saving page");
    expect(storageErrorUserMessage(err("Io"), "exporting CSV")).toContain("exporting CSV");
    expect(storageErrorUserMessage(err("Db"), "running the import")).toContain(
      "running the import"
    );
  });

  it("uses a generic default verb when omitted", () => {
    expect(storageErrorUserMessage(err("Db"))).toContain("the operation");
  });

  it("returns kind-specific copy distinct between kinds", () => {
    const seen = new Set<string>();
    for (const kind of [
      "NotFound",
      "Conflict",
      "Io",
      "Db",
      "Serde",
      "Invalid",
      "Internal",
      "Unknown",
    ] as StorageErrorKind[]) {
      seen.add(storageErrorUserMessage(err(kind), "doing X"));
    }
    // Internal and Unknown deliberately share the generic fallback (7 unique copies).
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it("returns NotFound copy without the verb (refresh framing only)", () => {
    expect(storageErrorUserMessage(err("NotFound"), "saving page")).not.toContain("saving page");
  });

  it("never echoes the raw backend message (which may contain user input or SQL)", () => {
    const leaky = err("Db", "near 'DROP': syntax error in user-supplied title");
    const friendly = storageErrorUserMessage(leaky, "saving page");
    expect(friendly).not.toContain("DROP");
    expect(friendly).not.toContain("syntax error");
    expect(friendly).not.toContain("user-supplied title");
  });
});
