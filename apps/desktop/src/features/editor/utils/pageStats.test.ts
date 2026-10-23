import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { pageStats, readingTime } from "./pageStats";

function docOf(...blocks: string[]) {
  const content = blocks.map((text) =>
    text ? { content: [{ text, type: "text" }], type: "paragraph" } : { type: "paragraph" }
  );
  return new Editor({ content: { content, type: "doc" }, extensions: editorExtensions }).state.doc;
}

describe("pageStats", () => {
  it("counts as if the non-empty blocks were joined with a space", () => {
    const doc = docOf("  Alpha beta ", "", "gamma\tdelta");
    const joined = "Alpha beta gamma\tdelta";

    expect(pageStats(doc)).toEqual({ chars: joined.length, paragraphs: 3, words: 4 });
  });

  it("is zero for an empty or blank page", () => {
    expect(pageStats(docOf(""))).toEqual({ chars: 0, paragraphs: 1, words: 0 });
    expect(pageStats(docOf("   ")).words).toBe(0);
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
