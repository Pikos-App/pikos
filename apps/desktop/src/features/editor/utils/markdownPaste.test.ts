import { describe, expect, it } from "vitest";

import { looksLikeMarkdown } from "./markdownPaste";

describe("looksLikeMarkdown", () => {
  it("detects block syntax", () => {
    const cases = [
      "# Heading",
      "### Smaller heading",
      "> a blockquote",
      "- bullet item",
      "* bullet item",
      "+ bullet item",
      "1. ordered item",
      "2) ordered item",
      "- [ ] todo",
      "- [x] done",
      "```\ncode fence\n```",
      "~~~\ncode fence\n~~~",
      "---",
      "***",
      "| col a | col b |",
    ];
    for (const c of cases) {
      expect(looksLikeMarkdown(c), c).toBe(true);
    }
  });

  it("detects inline syntax", () => {
    const cases = [
      "some **bold** text",
      "some __bold__ text",
      "some *italic* text",
      "some `inline code` here",
      "a [link](https://example.com)",
      "an ![image](path/to.png)",
    ];
    for (const c of cases) {
      expect(looksLikeMarkdown(c), c).toBe(true);
    }
  });

  it("detects markdown embedded in multi-line text", () => {
    const text = "Intro paragraph.\n\n## Section\n\nBody with **emphasis**.";
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it("returns false for plain prose", () => {
    const cases = [
      "Just a normal sentence.",
      "Two sentences. No markdown here.",
      "Multiply 3 * 4 to get 12.", // lone asterisk, not emphasis
      "Email me at a@b.com",
      "C:\\path\\to\\file with _underscores_in_words", // intra-word underscores
    ];
    for (const c of cases) {
      expect(looksLikeMarkdown(c), c).toBe(false);
    }
  });

  it("returns false for a bare URL (handled by link-on-paste)", () => {
    expect(looksLikeMarkdown("https://example.com/page")).toBe(false);
  });

  it("returns false for empty or trivial input", () => {
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown("a")).toBe(false);
  });
});
