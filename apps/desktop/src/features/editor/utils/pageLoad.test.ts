import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { FIRST_SCREEN_SIZE, openPageContent } from "./pageLoad";

function pageOf(count: number, label = "block") {
  return {
    content: Array.from({ length: count }, (_, i) => ({
      content: [{ text: `${label} ${i}`, type: "text" }],
      type: "paragraph",
    })),
    type: "doc",
  };
}

/** Several slices of short paragraphs. */
const LONG = FIRST_SCREEN_SIZE;

/** The page as opening it in one go produces it, schema defaults included. */
function loadedWhole(page: object) {
  const reference = new Editor({ content: page, extensions: editorExtensions });
  const json = reference.getJSON();
  reference.destroy();

  return json;
}

describe("openPageContent", () => {
  let editor: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    editor = new Editor({ content: "", extensions: editorExtensions });
  });

  afterEach(() => {
    editor.destroy();
    vi.useRealTimers();
  });

  it("opens a page that fits the first screen in one go", () => {
    const page = pageOf(3);

    expect(openPageContent(editor, page)).toBeNull();
    expect(editor.getJSON()).toEqual(loadedWhole(page));
  });

  it("draws a long page's first screen at once and the rest in order after it", () => {
    const page = pageOf(LONG);

    openPageContent(editor, page);
    expect(editor.state.doc.childCount).toBeLessThan(LONG);
    expect(editor.state.doc.content.size).toBeGreaterThanOrEqual(FIRST_SCREEN_SIZE);
    expect(editor.view.dom.getAttribute("aria-busy")).toBe("true");

    vi.runAllTimers();

    expect(editor.getJSON()).toEqual(loadedWhole(page));
    expect(editor.view.dom.hasAttribute("aria-busy")).toBe(false);
  });

  it("draws everything left at once when finished, so an edit after it lands in the whole page", () => {
    const page = pageOf(LONG);

    openPageContent(editor, page)?.finish();
    editor.commands.insertContentAt(1, "typed ");

    expect(editor.state.doc.childCount).toBe(LONG);
    expect(editor.state.doc.firstChild?.textContent).toBe("typed block 0");
    expect(editor.state.doc.lastChild?.textContent).toBe(`block ${LONG - 1}`);
  });

  it("keeps the slices out of the undo history", () => {
    const page = pageOf(LONG);

    openPageContent(editor, page);
    vi.runAllTimers();
    editor.commands.undo();

    expect(editor.getJSON()).toEqual(loadedWhole(page));
  });

  it("draws nothing of a cancelled page into the body that replaced it", () => {
    openPageContent(editor, pageOf(LONG, "old"))?.cancel();
    const next = pageOf(3, "new");
    openPageContent(editor, next);

    vi.runAllTimers();

    expect(editor.getJSON()).toEqual(loadedWhole(next));
  });

  it("opens empty, not cut short, when a block past the first screen is invalid", () => {
    const page = pageOf(LONG);
    page.content[LONG - 1] = { content: [], type: "notANode" } as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(openPageContent(editor, page)).toBeNull();

    expect(editor.state.doc.textContent).toBe("");
    warn.mockRestore();
  });
});
