// Opening a page must not put its content in the undo history. `setContent(doc, { emitUpdate: false })`
// is an ordinary transaction, so without the guard the load is an undoable step: undo reverts to the
// empty document the editor was constructed with, onUpdate fires, and autosave persists it, erasing
// the page. Two ways in: undo before typing anything, and typing within ProseMirror's ~500ms grouping
// window, so one undo reverts keystroke and load. The mobile editor loads the same way and carries the
// same guard, where shake-to-undo makes it matter more.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "./components/EditorPane";
import { loadPageContent } from "./utils/pageLoad";

const PAGE = {
  content: [{ content: [{ text: "Existing page content", type: "text" }], type: "paragraph" }],
  type: "doc",
};

/** The production load path, imported rather than reimplemented, so the tests can't pass against a copy that has the guard. */
const openPage = loadPageContent;

describe("undo after opening a page", () => {
  it("does nothing when the user has made no edits", () => {
    const editor = new Editor({ content: "", extensions: editorExtensions });
    openPage(editor, PAGE);

    editor.commands.undo();

    expect(editor.getText()).toContain("Existing page content");
  });

  it("reverts only the typing, even when typing starts immediately", () => {
    // Immediately, so the keystroke falls inside the history grouping window.
    const editor = new Editor({ content: "", extensions: editorExtensions });
    openPage(editor, PAGE);

    editor.commands.insertContent("X");
    editor.commands.undo();

    expect(editor.getText()).toContain("Existing page content");
    expect(editor.getText()).not.toContain("X");
  });

  it("survives repeated undo past the beginning of the history", () => {
    const editor = new Editor({ content: "", extensions: editorExtensions });
    openPage(editor, PAGE);

    for (let i = 0; i < 5; i++) editor.commands.undo();

    expect(editor.getText()).toContain("Existing page content");
  });

  it("does not drag a previous page's edits into the current one", () => {
    // Pages share one editor instance, so the history survives a page switch.
    // Undo must not apply an edit made to a document that is no longer open.
    const editor = new Editor({ content: "", extensions: editorExtensions });
    openPage(editor, PAGE);
    editor.commands.insertContent("edit on the first page");

    openPage(editor, {
      content: [{ content: [{ text: "A different page", type: "text" }], type: "paragraph" }],
      type: "doc",
    });
    editor.commands.undo();

    expect(editor.getText()).toContain("A different page");
    expect(editor.getText()).not.toContain("edit on the first page");
  });
});
