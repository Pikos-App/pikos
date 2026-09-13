// Opening a page must not put its content in the undo history.
//
// It used to. `setContent(doc, { emitUpdate: false })` is an ordinary
// transaction, so the load became an undoable step and undo reverted to the
// empty document the editor was constructed with. Because EditorPane's
// onUpdate then fires, autosave persisted that empty document — the user's page
// erased by pressing undo.
//
// Two ways in, both plausible:
//
//   - undo before typing anything at all
//   - typing within ProseMirror's ~500ms grouping window, so the keystroke is
//     grouped with the load and one undo reverts both
//
// The mobile editor loads pages the same way and carries the same guard, where
// it matters more: iOS offers shake-to-undo and an undo key on the keyboard.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions, loadPageContent } from "./components/EditorPane";

const PAGE = {
  content: [{ content: [{ text: "Existing page content", type: "text" }], type: "paragraph" }],
  type: "doc",
};

/**
 * The production load path, imported rather than reimplemented.
 *
 * An earlier version of this file defined its own copy with the fix baked in,
 * and so tested itself: removing the guard from EditorPane left all four tests
 * passing.
 */
const openPage = loadPageContent;

describe("undo after opening a page", () => {
  it("does nothing when the user has made no edits", () => {
    const editor = new Editor({ content: "", extensions: editorExtensions });
    openPage(editor, PAGE);

    editor.commands.undo();

    expect(editor.getText()).toContain("Existing page content");
  });

  it("reverts only the typing, even when typing starts immediately", () => {
    // Immediately, so the keystroke falls inside the history grouping window —
    // the case that made this a bug rather than a curiosity.
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
