import { createDocumentExtensions } from "@pikos/editor-schema";
// An imported document must already be in the form the editor would produce. The import path once
// assembled its own extension list that omitted TabIndent, so imports lacked the `indent: 0` every
// edited document carries and the first keystroke rewrote the whole document, a needlessly large
// change to reconcile with a second client syncing.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { convertMarkdownToTiptap } from "./hooks/useImport";

function editor(): Editor {
  return new Editor({
    content: "",
    extensions: createDocumentExtensions({ resolveAssetUrl: (p) => `asset://${p}` }),
  });
}

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
    // Round-tripping through the editor must be a no-op; otherwise the first edit silently rewrites
    // whatever differs.
    expect(imported).toEqual(canonical(imported));
  });
});
