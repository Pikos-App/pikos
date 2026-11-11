import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorExtensions } from "../components/EditorPane";
import { loadPageContent } from "../utils/pageLoad";
import { useIdleWordCount } from "./useIdleWordCount";

function paragraph(text: string) {
  return { content: [{ content: [{ text, type: "text" }], type: "paragraph" }], type: "doc" };
}

describe("useIdleWordCount", () => {
  let editor: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    editor = new Editor({ content: paragraph("one two"), extensions: editorExtensions });
  });

  afterEach(() => {
    editor.destroy();
    vi.useRealTimers();
  });

  it("catches up once typing pauses, not on each keystroke", () => {
    const { result } = renderHook(() => useIdleWordCount(editor));
    expect(result.current).toBe(2);

    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " three");
    });
    expect(result.current).toBe(2);

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(3);
  });

  it("shows a newly opened page's count at once", () => {
    const { result } = renderHook(() => useIdleWordCount(editor));

    act(() => loadPageContent(editor, paragraph("a b c d e")));

    expect(result.current).toBe(5);
  });
});
