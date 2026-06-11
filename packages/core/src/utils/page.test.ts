import { describe, expect, it } from "vitest";

import { isDone, isOpen } from "./page";

describe("isOpen", () => {
  it("returns true for not_started", () => {
    expect(isOpen({ status: "not_started" })).toBe(true);
  });

  it("returns false for done", () => {
    expect(isOpen({ status: "done" })).toBe(false);
  });
});

describe("isDone", () => {
  it("returns true for done", () => {
    expect(isDone({ status: "done" })).toBe(true);
  });

  it("returns false for not_started", () => {
    expect(isDone({ status: "not_started" })).toBe(false);
  });
});
