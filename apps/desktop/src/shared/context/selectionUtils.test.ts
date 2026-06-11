import { describe, expect, it } from "vitest";

import { computeRangeSelection } from "./selectionUtils";

describe("computeRangeSelection", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("selects range from anchor to target (forward)", () => {
    const result = computeRangeSelection(ids, "b", "d");
    expect(result).toEqual(new Set(["b", "c", "d"]));
  });

  it("selects range from anchor to target (reversed)", () => {
    const result = computeRangeSelection(ids, "d", "b");
    expect(result).toEqual(new Set(["b", "c", "d"]));
  });

  it("selects single item when anchor equals target", () => {
    const result = computeRangeSelection(ids, "c", "c");
    expect(result).toEqual(new Set(["c"]));
  });

  it("selects entire list from first to last", () => {
    const result = computeRangeSelection(ids, "a", "e");
    expect(result).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("returns empty set when anchor not in list", () => {
    const result = computeRangeSelection(ids, "z", "c");
    expect(result).toEqual(new Set());
  });

  it("returns empty set when target not in list", () => {
    const result = computeRangeSelection(ids, "a", "z");
    expect(result).toEqual(new Set());
  });

  it("returns empty set when both not in list", () => {
    const result = computeRangeSelection(ids, "x", "z");
    expect(result).toEqual(new Set());
  });

  it("returns empty set for empty visible list", () => {
    const result = computeRangeSelection([], "a", "b");
    expect(result).toEqual(new Set());
  });
});
