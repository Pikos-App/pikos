// TableToolbar — Floating toolbar that appears when the cursor is inside a table.
// Positioned above the table element using layout reads during render.

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Columns3,
  Rows3,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface TableToolbarProps {
  editor: Editor;
}

/** Find the table DOM element containing the current cursor. */
function findTableElement(editor: Editor): HTMLTableElement | null {
  // Get the DOM node at the cursor position and walk up to find the table
  const pos = editor.state.selection.$from;
  for (let d = pos.depth; d > 0; d--) {
    const node = pos.node(d);
    if (node.type.name === "table") {
      const domNode = editor.view.nodeDOM(pos.before(d));
      if (domNode instanceof HTMLTableElement) return domNode;
      // nodeDOM might return the wrapper — check children
      if (domNode instanceof HTMLElement) {
        const table = domNode.querySelector("table");
        if (table) return table;
      }
      return null;
    }
  }
  return null;
}

export function TableToolbar({ editor }: TableToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const { isInHeaderRow, isInTable } = useEditorState({
    editor,
    selector: (ctx) => ({
      isInHeaderRow: ctx.editor.isActive("tableHeader"),
      isInTable: ctx.editor.isActive("table"),
    }),
  });

  // Position the toolbar above the table on every render + scroll
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !isInTable) return;

    function reposition() {
      const table = findTableElement(editor);
      if (!table || !toolbar) {
        toolbar?.style.setProperty("display", "none");
        return;
      }

      const tableRect = table.getBoundingClientRect();
      const toolbarWidth = toolbar.offsetWidth;
      const toolbarHeight = toolbar.offsetHeight;
      const gap = 6;

      // Center horizontally above the table, clamp to viewport
      let left = tableRect.left + tableRect.width / 2 - toolbarWidth / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - toolbarWidth - 8));
      const top = tableRect.top - toolbarHeight - gap;

      toolbar.style.display = "";
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    }

    reposition();

    const scrollContainer = editor.view.dom.closest(".overflow-y-auto");
    scrollContainer?.addEventListener("scroll", reposition, { passive: true });
    return () => scrollContainer?.removeEventListener("scroll", reposition);
  });

  if (!isInTable) return null;

  const buttons: ({
    command: () => void;
    destructive?: boolean;
    disabled?: boolean;
    icon: React.ReactNode;
    title: string;
  } | null)[] = [
    {
      command: () => editor.chain().focus().addColumnBefore().run(),
      icon: <BetweenVerticalStart size={14} strokeWidth={2} />,
      title: "Add column before",
    },
    {
      command: () => editor.chain().focus().addColumnAfter().run(),
      icon: <BetweenVerticalEnd size={14} strokeWidth={2} />,
      title: "Add column after",
    },
    {
      command: () => editor.chain().focus().deleteColumn().run(),
      icon: <Columns3 size={14} strokeWidth={2} />,
      title: "Delete column",
    },
    null,
    {
      command: () => editor.chain().focus().addRowBefore().run(),
      disabled: isInHeaderRow,
      icon: <BetweenHorizontalStart size={14} strokeWidth={2} />,
      title: "Add row above",
    },
    {
      command: () => editor.chain().focus().addRowAfter().run(),
      icon: <BetweenHorizontalEnd size={14} strokeWidth={2} />,
      title: "Add row below",
    },
    {
      command: () => editor.chain().focus().deleteRow().run(),
      disabled: isInHeaderRow,
      icon: <Rows3 size={14} strokeWidth={2} />,
      title: "Delete row",
    },
    null,
    {
      command: () => editor.chain().focus().deleteTable().run(),
      destructive: true,
      icon: <Trash2 size={14} strokeWidth={2} />,
      title: "Delete table",
    },
  ];

  return (
    <div
      className="bubble-toolbar table-toolbar"
      ref={toolbarRef}
      style={{ position: "fixed", zIndex: 50 }}
    >
      {buttons.map((btn, i) =>
        btn === null ? (
          <div className="bubble-toolbar-divider" key={i} />
        ) : (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <button
                aria-label={btn.title}
                className={`bubble-toolbar-btn${btn.destructive ? "text-destructive" : ""}`}
                disabled={btn.disabled}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!btn.disabled) btn.command();
                }}
              >
                {btn.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{btn.title}</TooltipContent>
          </Tooltip>
        )
      )}
    </div>
  );
}
