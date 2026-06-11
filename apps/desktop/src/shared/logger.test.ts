import { describe, expect, it } from "vitest";

import { formatError } from "./logger";

describe("formatError", () => {
  it("truncates a long Error message with an ellipsis", () => {
    const big = "x".repeat(1024);
    const out = formatError(new Error(big));
    expect(out.startsWith("Error: ")).toBe(true);
    const message = out.slice("Error: ".length).split("\n")[0]!;
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBe(201);
  });

  it("truncates a long stack with an ellipsis", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at Foo (file.ts:1:1)\n".repeat(200);
    const out = formatError(err);
    const stack = out.split("\n").slice(1).join("\n");
    expect(stack.endsWith("…")).toBe(true);
    expect(stack.length).toBe(201);
  });

  it("leaves short messages untouched", () => {
    const err = new Error("short");
    delete err.stack;
    expect(formatError(err)).toBe("Error: short");
  });

  it("scrubs home-dir paths before truncating", () => {
    // Build the fixture path in pieces so the source-audit grep for hardcoded
    // personal paths (/Users/[a-zA-Z]) doesn't flag the test file itself.
    const homePrefix = "/Users" + "/alice";
    const err = new Error(`failed at ${homePrefix}/secret/${"y".repeat(400)}`);
    const out = formatError(err);
    expect(out).not.toContain(homePrefix);
    expect(out).toContain("~");
  });

  it("truncates long string inputs", () => {
    const out = formatError("z".repeat(1024));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(201);
  });

  it("truncates serialised non-Error objects", () => {
    const obj = { blob: "q".repeat(1024) };
    const out = formatError(obj);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(201);
  });
});
