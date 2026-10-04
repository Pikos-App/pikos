import { describe, expect, it } from "vitest";

import { countWords, readingTime } from "./pageStats";

describe("countWords", () => {
  it("counts whitespace-separated words and ignores surrounding space", () => {
    expect(countWords("  Alpha beta\n gamma ")).toBe(3);
  });

  it("is zero for an empty or blank page", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });
});

describe("readingTime", () => {
  it("reads a short note as under a minute", () => {
    expect(readingTime(4)).toBe("< 1 min");
    expect(readingTime(237)).toBe("< 1 min");
  });

  it("reads a minute's worth as 1 min", () => {
    expect(readingTime(238)).toBe("1 min");
  });

  it("rounds to the nearest minute", () => {
    expect(readingTime(300)).toBe("1 min");
    expect(readingTime(400)).toBe("2 min");
  });
});
