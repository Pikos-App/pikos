import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { findDocMatches } from "./textSearch";

function docOf(...content: JSONContent[]) {
  return new Editor({ content: { content, type: "doc" }, extensions: editorExtensions }).state.doc;
}

function matchedText(doc: ReturnType<typeof docOf>, query: string) {
  return findDocMatches(doc, query).map((from) => doc.textBetween(from, from + query.length));
}

describe("findDocMatches", () => {
  it("finds nothing for an empty query", () => {
    expect(
      findDocMatches(docOf({ content: [{ text: "fox", type: "text" }], type: "paragraph" }), "")
    ).toEqual([]);
  });

  it("returns positions that select each match, in document order", () => {
    const doc = docOf(
      { content: [{ text: "The fox and the Fox", type: "text" }], type: "paragraph" },
      { content: [{ text: "another fox", type: "text" }], type: "paragraph" }
    );

    expect(matchedText(doc, "fox")).toEqual(["fox", "Fox", "fox"]);
  });

  it("matches across marks inside one block", () => {
    const doc = docOf({
      content: [
        { text: "qu", type: "text" },
        { marks: [{ type: "bold" }], text: "ick", type: "text" },
      ],
      type: "paragraph",
    });

    expect(matchedText(doc, "quick")).toEqual(["quick"]);
  });

  it("keeps positions right after an inline node and inside nested blocks", () => {
    const doc = docOf(
      {
        content: [
          { text: "one", type: "text" },
          { type: "hardBreak" },
          { text: "fox", type: "text" },
        ],
        type: "paragraph",
      },
      {
        content: [
          {
            content: [{ content: [{ text: "a fox", type: "text" }], type: "paragraph" }],
            type: "listItem",
          },
        ],
        type: "bulletList",
      }
    );

    expect(matchedText(doc, "fox")).toEqual(["fox", "fox"]);
  });

  it("is case-insensitive and counts overlapping matches", () => {
    const doc = docOf({ content: [{ text: "AAa", type: "text" }], type: "paragraph" });

    expect(matchedText(doc, "aa")).toEqual(["AA", "Aa"]);
  });

  it("keeps later positions right after a character whose lowercase is longer", () => {
    const doc = docOf(
      { content: [{ text: "İstanbul", type: "text" }], type: "paragraph" },
      { content: [{ text: "fox", type: "text" }], type: "paragraph" }
    );

    expect(matchedText(doc, "fox")).toEqual(["fox"]);
  });

  it("never matches across two blocks", () => {
    const doc = docOf(
      { content: [{ text: "fo", type: "text" }], type: "paragraph" },
      { content: [{ text: "x", type: "text" }], type: "paragraph" }
    );

    expect(findDocMatches(doc, "fox")).toEqual([]);
  });
});
