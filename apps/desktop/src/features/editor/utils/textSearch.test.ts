import { describe, expect, it } from "vitest";

import { countTextMatches, findAllMatches } from "./textSearch";

describe("findAllMatches", () => {
  it("returns empty array for empty query", () => {
    expect(findAllMatches("hello world", "")).toEqual([]);
  });

  it("returns empty array for empty text", () => {
    expect(findAllMatches("", "hello")).toEqual([]);
  });

  it("finds a single match", () => {
    expect(findAllMatches("hello world", "world")).toEqual([{ end: 11, start: 6 }]);
  });

  it("finds multiple non-overlapping matches", () => {
    expect(findAllMatches("the cat sat on the mat", "the")).toEqual([
      { end: 3, start: 0 },
      { end: 18, start: 15 },
    ]);
  });

  it("finds overlapping matches", () => {
    expect(findAllMatches("aaa", "aa")).toEqual([
      { end: 2, start: 0 },
      { end: 3, start: 1 },
    ]);
  });

  it("is case-insensitive", () => {
    expect(findAllMatches("Hello HELLO hElLo", "hello")).toEqual([
      { end: 5, start: 0 },
      { end: 11, start: 6 },
      { end: 17, start: 12 },
    ]);
  });

  it("returns empty array when no match found", () => {
    expect(findAllMatches("hello world", "xyz")).toEqual([]);
  });

  it("handles single-character queries", () => {
    expect(findAllMatches("abcabc", "a")).toEqual([
      { end: 1, start: 0 },
      { end: 4, start: 3 },
    ]);
  });

  it("handles query equal to full text", () => {
    expect(findAllMatches("exact", "exact")).toEqual([{ end: 5, start: 0 }]);
  });

  it("handles query longer than text", () => {
    expect(findAllMatches("hi", "hello")).toEqual([]);
  });
});

describe("countTextMatches", () => {
  it("returns 0 for empty query", () => {
    expect(countTextMatches("hello world", "")).toBe(0);
  });

  it("returns 0 for empty text", () => {
    expect(countTextMatches("", "hello")).toBe(0);
  });

  it("counts single match", () => {
    expect(countTextMatches("hello world", "world")).toBe(1);
  });

  it("counts multiple matches", () => {
    expect(countTextMatches("the cat sat on the mat", "the")).toBe(2);
  });

  it("counts overlapping matches", () => {
    expect(countTextMatches("aaa", "aa")).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(countTextMatches("Hello HELLO hElLo", "hello")).toBe(3);
  });

  it("returns 0 when no match", () => {
    expect(countTextMatches("hello world", "xyz")).toBe(0);
  });
});
