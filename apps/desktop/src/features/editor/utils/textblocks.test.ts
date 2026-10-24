import { Editor, type JSONContent } from "@tiptap/core";
import { Node as PmNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { pageStats } from "./pageStats";
import { findDocMatches } from "./textSearch";

const QUERY = "fox";

function paragraph(text: string): JSONContent {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function line(i: number): string {
  return `the quick brown fox ${i} jumps over the lazy dog`;
}

const SHAPES: Record<string, JSONContent[]> = {
  "a huge list": [
    {
      content: Array.from({ length: 300 }, (_, i) => ({
        content: [paragraph(line(i))],
        type: "listItem",
      })),
      type: "bulletList",
    },
  ],
  "a huge table": [
    {
      content: Array.from({ length: 100 }, (_, row) => ({
        content: Array.from({ length: 3 }, (_, col) => ({
          content: [paragraph(line(row * 3 + col))],
          type: "tableCell",
        })),
        type: "tableRow",
      })),
      type: "table",
    },
  ],
  "a log": Array.from({ length: 300 }, (_, i) =>
    paragraph(`2026-10-23 12:00:${String(i % 60).padStart(2, "0")} INFO fox worker ${i} done`)
  ),
  prose: Array.from({ length: 300 }, (_, i) => paragraph(`${line(i)}. ${line(i + 1)}.`)),
};

function editMiddle(content: JSONContent[]): PmNode {
  const page = { content: [...content, { type: "paragraph" }], type: "doc" };
  const editor = new Editor({ content: page, extensions: editorExtensions });
  const warmed = editor.state.doc;
  findDocMatches(warmed, QUERY);
  pageStats(warmed);

  const textblocks: number[] = [];
  warmed.descendants((node, pos) => {
    if (node.isTextblock) textblocks.push(pos);
    return !node.isTextblock;
  });
  const middle = textblocks[Math.floor(textblocks.length / 2)] ?? 0;
  editor.view.dispatch(editor.state.tr.insertText(" fox and FOX ", middle + 1));

  return editor.state.doc;
}

function readFresh(doc: PmNode): PmNode {
  return doc.type.schema.nodeFromJSON(doc.toJSON());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(Object.entries(SHAPES))("Find and counts after an edit to %s", (_, content) => {
  it("match a read of the whole page", () => {
    const edited = editMiddle(content);
    const fresh = readFresh(edited);

    expect(findDocMatches(edited, QUERY)).toEqual(findDocMatches(fresh, QUERY));
    expect(pageStats(edited)).toEqual(pageStats(fresh));
  });

  it("read only the block the edit changed", () => {
    const edited = editMiddle(content);
    const reads = vi.spyOn(PmNode.prototype, "textContent", "get");

    findDocMatches(edited, QUERY);
    pageStats(edited);

    expect(reads).toHaveBeenCalledTimes(1);
  });
});
