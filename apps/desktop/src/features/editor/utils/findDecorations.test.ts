import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { createFindPlugin, type FindParams, WHOLE_DOC } from "./findDecorations";

const BLOCK_TEXTS = ["fox 0", "fox 1", "fox 2", "fox 3", "fox 4"];

/** The blocks whose match is drawn, with a `*` on the active one. */
function drawn(params: FindParams): string[] {
  const content = BLOCK_TEXTS.map((text) => ({
    content: [{ text, type: "text" }],
    type: "paragraph",
  }));
  const editor = new Editor({
    content: { content, type: "doc" },
    element: document.createElement("div"),
    extensions: editorExtensions,
  });
  editor.registerPlugin(createFindPlugin({ current: params }));

  const marks = [...editor.view.dom.querySelectorAll(".find-match")];
  const result = marks.map((mark) => {
    const block = mark.closest("p")?.textContent ?? "";
    return mark.classList.contains("find-match-active") ? `${block}*` : block;
  });
  editor.destroy();

  return result;
}

describe("find decorations", () => {
  it("draws every match when the whole page is in range", () => {
    expect(drawn({ activeIndex: 1, query: "fox", range: WHOLE_DOC })).toEqual([
      "fox 0",
      "fox 1*",
      "fox 2",
      "fox 3",
      "fox 4",
    ]);
  });

  it("draws only matches in range, plus the active one outside it", () => {
    const blockSize = "fox 0".length + 2;
    const range = { from: 2 * blockSize, to: 3 * blockSize };

    expect(drawn({ activeIndex: 4, query: "fox", range })).toEqual(["fox 2", "fox 4*"]);
    expect(drawn({ activeIndex: 0, query: "fox", range })).toEqual(["fox 0*", "fox 2"]);
  });
});
