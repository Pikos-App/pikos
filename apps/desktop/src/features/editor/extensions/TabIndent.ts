import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const TAB = "    "; // 4 spaces for inline insertion in normal text
const CODE_TAB = "  "; // 2 spaces for code blocks (preserves alignment)
const INDENT_SIZE = 2; // rem units per indent level
const MAX_INDENT = 8;
const MIN_INDENT = 0;
const tabIndentPluginKey = new PluginKey("tabIndent");

const PARAGRAPH_INDENT_ATTRIBUTE = {
  attributes: {
    indent: {
      default: 0,
      parseHTML: (element: HTMLElement) => {
        const raw = element.getAttribute("data-indent");
        const parsed = raw !== null ? parseInt(raw, 10) : 0;
        return isNaN(parsed) ? 0 : Math.max(MIN_INDENT, Math.min(MAX_INDENT, parsed));
      },
      renderHTML: (attributes: Record<string, unknown>) => {
        const level = typeof attributes["indent"] === "number" ? attributes["indent"] : 0;
        if (level === 0) return {};
        return {
          "data-indent": String(level),
          style: `padding-left: ${level * INDENT_SIZE}rem`,
        };
      },
    },
  },
  types: ["paragraph", "heading"],
};

export function isCursorAtLineStart(state: EditorState): boolean {
  const { $from, empty } = state.selection;
  // Only applies to collapsed cursors — if there's a selection, indent the block
  if (!empty) return true;
  return $from.parentOffset === 0;
}

export function getIndentLevel(node: ProseMirrorNode): number {
  const raw = node.attrs?.["indent"];
  return typeof raw === "number" ? raw : 0;
}

export function setIndentForSelection(
  state: EditorState,
  dispatch: EditorView["dispatch"],
  delta: 1 | -1
): boolean {
  const { from, to } = state.selection;
  const tr = state.tr;
  let changed = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    // Only act on top-level block nodes (depth 1 in a standard doc schema)
    const $pos = state.doc.resolve(pos);
    if ($pos.depth > 1) return false; // skip nested nodes inside lists etc.

    const current = getIndentLevel(node);
    const next = Math.max(MIN_INDENT, Math.min(MAX_INDENT, current + delta));
    if (next !== current) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ["indent"]: next });
      changed = true;
    }
    return false; // don't descend into block children
  });

  if (changed) {
    dispatch(tr);
  }
  return true; // always swallow Tab in normal text
}

export const TabIndent = Extension.create({
  addGlobalAttributes() {
    return [PARAGRAPH_INDENT_ATTRIBUTE];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: tabIndentPluginKey,
        props: {
          handleKeyDown(view: EditorView, event: KeyboardEvent) {
            if (event.key === "Escape") {
              const { dispatch, state } = view;
              if (!state.selection.empty) {
                dispatch(
                  state.tr.setSelection(Selection.near(state.doc.resolve(state.selection.to)))
                );
                return true;
              }
              return false;
            }

            // ── Backspace at position 0 with indent → outdent instead of join ──
            if (event.key === "Backspace") {
              const { dispatch, state } = view;
              const { $from, empty } = state.selection;
              if (
                empty &&
                $from.parentOffset === 0 &&
                ($from.parent.type.name === "paragraph" || $from.parent.type.name === "heading") &&
                state.doc.resolve($from.pos - 1).depth <= 1 &&
                getIndentLevel($from.parent) > 0
              ) {
                return setIndentForSelection(state, dispatch, -1);
              }
              return false;
            }

            if (event.key !== "Tab") return false;
            event.preventDefault();

            const { dispatch, state } = view;

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
              return setIndentForSelection(state, dispatch, -1);
            }

            if (editor.isActive("listItem")) {
              return editor.commands.sinkListItem("listItem");
            }
            if (editor.isActive("taskItem")) {
              return editor.commands.sinkListItem("taskItem");
            }
            if (editor.isActive("codeBlock")) {
              const { from, to } = state.selection;
              dispatch(state.tr.insertText(CODE_TAB, from, to));
              return true;
            }
            if (isCursorAtLineStart(state)) {
              return setIndentForSelection(state, dispatch, 1);
            }
            const { from, to } = state.selection;
            dispatch(state.tr.insertText(TAB, from, to));
            return true;
          },
        },
      }),
    ];
  },

  name: "tabIndent",
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
  const remove = Math.min(lineText.match(/^ */)?.[0].length ?? 0, CODE_TAB.length);
  if (remove > 0) {
    dispatch(state.tr.delete(absLineStart, absLineStart + remove));
  }
  return true;
}
