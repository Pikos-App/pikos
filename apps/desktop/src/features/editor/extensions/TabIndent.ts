// TabIndent — Intercepts Tab / Shift+Tab in the editor.
// Lists & task items: indent / outdent via sink/lift.
// Code blocks: insert/remove 2 spaces via raw transaction.
// Normal text: no-op (prevents browser focus shift).
// TODO: Tab in normal paragraphs should insert/remove indentation — needs investigation.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const TAB = "  "; // 2 spaces
const tabIndentPluginKey = new PluginKey("tabIndent");

export const TabIndent = Extension.create({
  name: "tabIndent",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: tabIndentPluginKey,
        props: {
          handleKeyDown(view: EditorView, event: KeyboardEvent) {
            if (event.key !== "Tab") return false;
            event.preventDefault();

            const { state, dispatch } = view;

            if (event.shiftKey) {
              if (editor.isActive("listItem")) {
                return editor.commands.liftListItem("listItem");
              }
              if (editor.isActive("taskItem")) {
                return editor.commands.liftListItem("taskItem");
              }
              if (editor.isActive("codeBlock")) {
                return removeCodeBlockIndent(state, dispatch);
              }
              // Normal text: swallow (prevent focus shift)
              return true;
            }

            if (editor.isActive("listItem")) {
              return editor.commands.sinkListItem("listItem");
            }
            if (editor.isActive("taskItem")) {
              return editor.commands.sinkListItem("taskItem");
            }
            if (editor.isActive("codeBlock")) {
              const { from, to } = state.selection;
              dispatch(state.tr.insertText(TAB, from, to));
              return true;
            }
            // Normal text: swallow (prevent focus shift)
            return true;
          },
        },
      }),
    ];
  },
});

/** Remove up to 2 leading spaces from the current line in a code block. */
function removeCodeBlockIndent(state: EditorState, dispatch: EditorView["dispatch"]): true {
  const { $from } = state.selection;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const lastNewline = textBefore.lastIndexOf("\n");
  const lineStartOffset = lastNewline + 1;
  const absLineStart = $from.pos - $from.parentOffset + lineStartOffset;
  const lineText = $from.parent.textBetween(
    lineStartOffset,
    $from.parent.content.size,
    undefined,
    "\ufffc"
  );
  const remove = Math.min(lineText.match(/^ */)?.[0].length ?? 0, TAB.length);
  if (remove > 0) {
    dispatch(state.tr.delete(absLineStart, absLineStart + remove));
  }
  return true;
}
