import { describe, expect, it } from "vitest";

import { emojiAwareCompare, stripLeadingEmoji } from "./sort";

describe("stripLeadingEmoji", () => {
  it("strips simple emoji", () => {
    expect(stripLeadingEmoji("🐶Dog")).toBe("Dog");
  });

  it("strips emoji with trailing space", () => {
    expect(stripLeadingEmoji("🐶 Dog")).toBe("Dog");
  });

  it("strips compound ZWJ emoji", () => {
    expect(stripLeadingEmoji("🚶‍♂Breaks")).toBe("Breaks");
  });

  it("strips emoji with variation selector", () => {
    expect(stripLeadingEmoji("🏃‍♀️ Exercise")).toBe("Exercise");
  });

  it("strips multiple consecutive emoji", () => {
    expect(stripLeadingEmoji("🎉🎊 Party")).toBe("Party");
  });

  it("leaves plain text untouched", () => {
    expect(stripLeadingEmoji("Hello")).toBe("Hello");
  });

  it("leaves mid-string emoji alone", () => {
    expect(stripLeadingEmoji("Hello 🌍")).toBe("Hello 🌍");
  });

  it("handles empty string", () => {
    expect(stripLeadingEmoji("")).toBe("");
  });

  it("handles emoji-only string", () => {
    expect(stripLeadingEmoji("🐶🐱")).toBe("");
  });
});

describe("emojiAwareCompare", () => {
  it("sorts ignoring leading emoji", () => {
    const names = ["🏆Goals", "🐶Dog", "🚶‍♂Breaks", "💼Work"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["🚶‍♂Breaks", "🐶Dog", "🏆Goals", "💼Work"]);
  });

  it("sorts plain text normally", () => {
    const names = ["Charlie", "Alice", "Bob"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("mixes emoji and plain text", () => {
    const names = ["🐶Dog", "Cat", "🐱Bird"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["🐱Bird", "Cat", "🐶Dog"]);
  });

  it("sorts pure numbers numerically, not lexicographically", () => {
    const names = ["10", "101", "11", "1", "2", "100"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["1", "2", "10", "11", "100", "101"]);
  });

  it("sorts embedded numbers numerically", () => {
    const names = ["Item 10", "Item 2", "Item 1", "Item 100"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["Item 1", "Item 2", "Item 10", "Item 100"]);
  });

  it("sorts numbers numerically after stripping leading emoji", () => {
    const names = ["📄 10", "📄 2", "📄 1", "📄 11"];
    const sorted = [...names].sort(emojiAwareCompare);
    expect(sorted).toEqual(["📄 1", "📄 2", "📄 10", "📄 11"]);
  });
});
