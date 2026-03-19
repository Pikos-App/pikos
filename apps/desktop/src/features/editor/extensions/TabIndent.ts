// TabIndent — Intercepts Tab / Shift+Tab in the editor.
// Lists & task items: indent / outdent via sink/lift.
// Code blocks: insert/remove 2 spaces via raw transaction.
// Normal text: increments/decrements a per-paragraph indent level (0–8),
//   stored as a `data-indent` attribute and rendered as padding-left.

// TODO: delete (when cursor is to the right of a tab) doesn't outdent.
// TODO: tabbing (when the cursor is in the middle of a line) should probably insert a tab character instead of indenting the whole paragraph.

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const TAB = "  "; // 2 spaces (used in code blocks)
const INDENT_SIZE = 2; // rem units per indent level
const MAX_INDENT = 8;
const MIN_INDENT = 0;
const tabIndentPluginKey = new PluginKey("tabIndent");

// ---------------------------------------------------------------------------
// Paragraph indent attribute — call this in your paragraph extension config,
// or register it via extendMarkRange / addGlobalAttributes below.
// ---------------------------------------------------------------------------

/**
 * Returns the TipTap `addGlobalAttributes` config that wires the `indent`
 * attribute onto paragraph (and heading) nodes.  Import and spread this into
 * your editor config if you prefer, or let TabIndent register it automatically
 * via `addGlobalAttributes` below.
 */
export const PARAGRAPH_INDENT_ATTRIBUTE = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the indent level of the paragraph/heading node at the cursor. */
function getIndentLevel(node: ProseMirrorNode): number {
  const raw = node.attrs?.["indent"];
  return typeof raw === "number" ? raw : 0;
}

/**
 * Sets the `indent` attribute on every top-level block that has a selection
 * touching it.  Works across multi-paragraph selections.
 */
function setIndentForSelection(
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

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const TabIndent = Extension.create({
  // Register the indent attribute globally so paragraph/heading nodes
  // understand it without requiring a separate extension.
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
              // Normal paragraph / heading: decrease indent level
              return setIndentForSelection(state, dispatch, -1);
            }

            // ── Tab (no shift) ──────────────────────────────────────────────
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
            // Normal paragraph / heading: increase indent level
            return setIndentForSelection(state, dispatch, 1);
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
  const remove = Math.min(lineText.match(/^ */)?.[0].length ?? 0, TAB.length);
  if (remove > 0) {
    dispatch(state.tr.delete(absLineStart, absLineStart + remove));
  }
  return true;
}
