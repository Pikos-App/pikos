import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { guessLanguage } from "./PikosCodeBlock";

const PYTHON = 'def hello(name):\n    print(f"hi {name}")\n\nhello("x")';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function productionEditor(content: JSONContent | string): Editor {
  editor = new Editor({ content, extensions: editorExtensions });
  return editor;
}

function markdownOf(e: Editor): string {
  const storage = e.storage as unknown as Record<string, { getMarkdown: () => string }>;
  return storage["markdown"]!.getMarkdown();
}

function codeBlockLanguage(e: Editor): unknown {
  return e.getJSON().content?.find((n) => n.type === "codeBlock")?.attrs?.["language"];
}

function emptyCodeBlock(language: string | null): JSONContent {
  return { content: [{ attrs: { language }, type: "codeBlock" }], type: "doc" };
}

function insertIntoCodeBlock(e: Editor, text: string, asPaste: boolean): void {
  e.chain()
    .command(({ tr }) => {
      tr.insertText(text, 1);
      if (asPaste) tr.setMeta("paste", true);
      return true;
    })
    .run();
}

describe("code block language", () => {
  it("keeps a fence's language through the production editor and back to Markdown", () => {
    const e = productionEditor("```rust\nfn main() {}\n```");

    expect(codeBlockLanguage(e)).toBe("rust");
    expect(markdownOf(e)).toContain("```rust\nfn main() {}\n```");
  });

  it("keeps a tag the picker doesn't list, such as an alias", () => {
    const e = productionEditor("```js\nconst x = 1;\n```");

    expect(markdownOf(e)).toContain("```js");
  });

  it("labels an unlabeled block with a guess when code is pasted into it", () => {
    const e = productionEditor(emptyCodeBlock(null));

    insertIntoCodeBlock(e, PYTHON, true);

    expect(codeBlockLanguage(e)).toBe("python");
    expect(markdownOf(e)).toContain("```python");
  });

  it("labels a pasted Markdown fence that has no tag", () => {
    const e = productionEditor("");

    e.chain().setMeta("paste", true).insertContent(`\`\`\`\n${PYTHON}\n\`\`\``).run();

    expect(codeBlockLanguage(e)).toBe("python");
  });

  it("leaves a chosen language alone when code is pasted", () => {
    const e = productionEditor(emptyCodeBlock("ruby"));

    insertIntoCodeBlock(e, PYTHON, true);

    expect(codeBlockLanguage(e)).toBe("ruby");
  });

  it("stores no language on a new block, so it exports a bare fence", () => {
    const e = productionEditor("");

    e.commands.setCodeBlock();
    insertIntoCodeBlock(e, "notes", false);

    expect(codeBlockLanguage(e)).toBeNull();
    expect(markdownOf(e)).toContain("```\nnotes\n```");
  });

  it("does not guess while typing", () => {
    const e = productionEditor(emptyCodeBlock(null));

    insertIntoCodeBlock(e, PYTHON, false);

    expect(codeBlockLanguage(e)).toBeNull();
  });

  it("makes no guess for prose or a one-liner", () => {
    expect(guessLanguage("Remember to buy milk and call the plumber tomorrow.")).toBeNull();
    expect(guessLanguage("x = 1")).toBeNull();
  });
});
