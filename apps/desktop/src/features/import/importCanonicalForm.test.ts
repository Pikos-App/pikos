import { createDocumentExtensions } from "@pikos/editor-schema";
// An imported document must already be in the form the editor would produce.
//
// It was not. The import path assembled its own Tiptap extension list, which
// had drifted from production — it omitted TabIndent, so imported documents
// carried no `indent` attribute while every document the editor writes carries
// `indent: 0` on each paragraph and heading. Opening an imported page and
// typing a single character normalised the whole document, turning the first
// keystroke into a full-document rewrite.
//
// Harmless enough on one machine. With a second client syncing, a first
// keystroke that rewrites every block is a needlessly large change to
// reconcile, and one whose cause is invisible at the point it happens.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { convertMarkdownToTiptap } from "./hooks/useImport";

/** An editor with the production document schema. */
function editor(): Editor {
  return new Editor({
    content: "",
    extensions: createDocumentExtensions({ resolveAssetUrl: (p) => `asset://${p}` }),
  });
}

/** What the editor would store for this document. */
function canonical(json: unknown): unknown {
  const e = editor();
  e.commands.setContent(json as object);
  return e.getJSON();
}

describe("imported documents are already canonical", () => {
  const samples: [name: string, markdown: string][] = [
    ["headings and body", "# Title\n\nSome body text.\n"],
    ["bullet list", "- one\n- two\n- three\n"],
    ["ordered list", "1. first\n2. second\n"],
    ["task list", "- [ ] todo\n- [x] done\n"],
    ["code block", "```js\nconst x = 1;\n```\n"],
    ["blockquote", "> quoted\n"],
    ["horizontal rule", "before\n\n---\n\nafter\n"],
    ["emphasis", "Some **bold** and _italic_ text.\n"],
    ["link", "A [link](https://example.com) inline.\n"],
    ["multiple blank lines", "one\n\n\n\ntwo\n"],
    ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
    ["empty", ""],
  ];

  it.each(samples)("%s", (_name, markdown) => {
    const imported = JSON.parse(convertMarkdownToTiptap(markdown));
    // Round-tripping through the editor must be a no-op. If it is not, the
    // import path and the editor disagree about the document's shape, and the
    // user's first edit will silently rewrite whatever differs.
    expect(imported).toEqual(canonical(imported));
  });
});
