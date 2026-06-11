import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { getIndentLevel, isCursorAtLineStart, setIndentForSelection, TabIndent } from "./TabIndent";

function createTestEditor(content?: string) {
  return new Editor({
    content: content ?? "<p>Hello world</p>",
    extensions: [StarterKit, TabIndent],
  });
}

describe("getIndentLevel", () => {
  it("returns 0 for a node with no indent attribute", () => {
    const editor = createTestEditor();
    const node = editor.state.doc.firstChild!;
    expect(getIndentLevel(node)).toBe(0);
    editor.destroy();
  });

  it("returns the indent value when set", () => {
    const editor = createTestEditor();
    const { state } = editor;
    const tr = state.tr.setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      indent: 3,
    });
    editor.view.dispatch(tr);

    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(3);
    editor.destroy();
  });

  it("returns 0 for non-numeric indent attribute", () => {
    const editor = createTestEditor();
    const { state } = editor;
    const tr = state.tr.setNodeMarkup(0, undefined, {
      ...state.doc.firstChild!.attrs,
      indent: "invalid",
    });
    editor.view.dispatch(tr);

    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(0);
    editor.destroy();
  });
});

describe("isCursorAtLineStart", () => {
  it("returns true when cursor is at position 0 in the paragraph", () => {
    const editor = createTestEditor("<p>Hello</p>");
    // Position 1 = start of text inside first paragraph (after opening tag)
    editor.commands.setTextSelection(1);
    expect(isCursorAtLineStart(editor.state)).toBe(true);
    editor.destroy();
  });

  it("returns false when cursor is in the middle of text", () => {
    const editor = createTestEditor("<p>Hello</p>");
    // Position 3 = after "He"
    editor.commands.setTextSelection(3);
    expect(isCursorAtLineStart(editor.state)).toBe(false);
    editor.destroy();
  });

  it("returns false when cursor is at end of text", () => {
    const editor = createTestEditor("<p>Hello</p>");
    // Position 6 = after "Hello"
    editor.commands.setTextSelection(6);
    expect(isCursorAtLineStart(editor.state)).toBe(false);
    editor.destroy();
  });

  it("returns true when there is a non-empty selection (indent whole block)", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection({ from: 2, to: 5 });
    expect(isCursorAtLineStart(editor.state)).toBe(true);
    editor.destroy();
  });
});

describe("setIndentForSelection", () => {
  it("increments indent level by 1", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    setIndentForSelection(editor.state, editor.view.dispatch, 1);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(1);
    editor.destroy();
  });

  it("decrements indent level by 1", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    setIndentForSelection(editor.state, editor.view.dispatch, 1);
    setIndentForSelection(editor.state, editor.view.dispatch, 1);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(2);

    setIndentForSelection(editor.state, editor.view.dispatch, -1);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(1);
    editor.destroy();
  });

  it("does not go below 0", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    setIndentForSelection(editor.state, editor.view.dispatch, -1);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(0);
    editor.destroy();
  });

  it("does not exceed max indent of 8", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    for (let i = 0; i < 10; i++) {
      setIndentForSelection(editor.state, editor.view.dispatch, 1);
    }
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(8);
    editor.destroy();
  });

  it("indents multiple paragraphs across a selection", () => {
    const editor = createTestEditor("<p>First</p><p>Second</p>");
    // Select across both paragraphs
    editor.commands.setTextSelection({ from: 1, to: 10 });

    setIndentForSelection(editor.state, editor.view.dispatch, 1);
    expect(getIndentLevel(editor.state.doc.child(0))).toBe(1);
    expect(getIndentLevel(editor.state.doc.child(1))).toBe(1);
    editor.destroy();
  });
});

describe("Tab key behavior", () => {
  it("inserts spaces when cursor is not at line start", () => {
    const editor = createTestEditor("<p>Hello world</p>");
    // Place cursor after "Hello" (position 6)
    editor.commands.setTextSelection(6);

    const event = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.dom.dispatchEvent(event);

    // Should have inserted 4 spaces at cursor position (after existing space)
    expect(editor.state.doc.firstChild!.textContent).toBe("Hello     world");
    editor.destroy();
  });

  it("indents block when cursor is at line start", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    const event = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.dom.dispatchEvent(event);

    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(1);
    expect(editor.state.doc.firstChild!.textContent).toBe("Hello");
    editor.destroy();
  });

  it("Shift+Tab outdents block regardless of cursor position", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    const tabEvent = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.dom.dispatchEvent(tabEvent);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(1);

    editor.commands.setTextSelection(3);
    const shiftTabEvent = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true });
    editor.view.dom.dispatchEvent(shiftTabEvent);

    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(0);
    editor.destroy();
  });
});

describe("Backspace at position 0 with indent", () => {
  it("outdents instead of joining with previous block", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(1);

    const tab1 = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.dom.dispatchEvent(tab1);
    const tab2 = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.dom.dispatchEvent(tab2);
    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(2);

    editor.commands.setTextSelection(1);
    const backspace = new KeyboardEvent("keydown", { key: "Backspace" });
    editor.view.dom.dispatchEvent(backspace);

    expect(getIndentLevel(editor.state.doc.firstChild!)).toBe(1);
    expect(editor.state.doc.firstChild!.textContent).toBe("Hello");
    editor.destroy();
  });

  it("allows normal backspace when indent is 0", () => {
    const editor = createTestEditor("<p>First</p><p>Second</p>");
    // Cursor at start of second paragraph
    editor.commands.setTextSelection(8);

    const backspace = new KeyboardEvent("keydown", { key: "Backspace" });
    editor.view.dom.dispatchEvent(backspace);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.textContent).toBe("FirstSecond");
    editor.destroy();
  });
});

describe("Escape collapses selection", () => {
  it("collapses a text selection to cursor at end", () => {
    const editor = createTestEditor("<p>Hello world</p>");
    // Select "Hello"
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editor.state.selection.empty).toBe(false);

    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    editor.view.dom.dispatchEvent(escape);

    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(6);
    editor.destroy();
  });

  it("collapses a select-all to cursor at end", () => {
    const editor = createTestEditor("<p>Hello</p><p>World</p>");
    editor.commands.selectAll();
    expect(editor.state.selection.empty).toBe(false);

    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    editor.view.dom.dispatchEvent(escape);

    expect(editor.state.selection.empty).toBe(true);
    editor.destroy();
  });

  it("does nothing when selection is already collapsed", () => {
    const editor = createTestEditor("<p>Hello</p>");
    editor.commands.setTextSelection(3);
    const posBefore = editor.state.selection.from;

    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    editor.view.dom.dispatchEvent(escape);

    expect(editor.state.selection.from).toBe(posBefore);
    expect(editor.state.selection.empty).toBe(true);
    editor.destroy();
  });
});
