import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useFindDecorations } from "../hooks/useFindDecorations";
import { docMatches } from "../utils/findDecorations";

interface FindContentPopoverProps {
  editor: Editor;
  scroller: RefObject<HTMLElement | null>;
}

export function FindContentPopover({ editor, scroller }: FindContentPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const drawMatches = useFindDecorations(editor, scroller, isOpen);

  useKeyboardShortcut(
    "Mod+F",
    () => {
      setIsOpen(true);
      const { from, to } = editor.state.selection;
      if (from !== to) {
        const selected = editor.state.doc.textBetween(from, to, " ");
        const MAX_AUTO_POPULATE_LENGTH = 100;
        if (selected.length <= MAX_AUTO_POPULATE_LENGTH) {
          setQuery(selected);
          setActiveIndex(0);
        }
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    { allowInInputs: true, group: "Editor", label: "Find in page" }
  );

  // Close when focus leaves the popover (covers click-outside and tab-away).
  // relatedTarget can be null on macOS button clicks — treat that as "still
  // inside" and let a follow-up blur (if any) handle it.
  function handleFocusOut(e: React.FocusEvent) {
    if (
      popoverRef.current &&
      e.relatedTarget &&
      !popoverRef.current.contains(e.relatedTarget as Node)
    ) {
      handleClose();
    }
  }

  const { totalMatches } = useEditorState({
    editor,
    selector: (ctx) => ({
      totalMatches: docMatches(ctx.editor.state.doc, query).length,
    }),
  });

  const clamped = totalMatches > 0 ? activeIndex % totalMatches : 0;

  // Called from event handlers only — never from effects or render.
  function syncDecorations(q: string, idx: number) {
    if (editor.isDestroyed) return;
    drawMatches(q, idx);
    if (q) {
      requestAnimationFrame(() => {
        document
          .querySelector(".find-match-active")
          ?.scrollIntoView({ behavior: "instant", block: "nearest" });
      });
    }
  }

  function handleQueryChange(newQuery: string) {
    setQuery(newQuery);
    setActiveIndex(0);
    syncDecorations(newQuery, 0);
  }

  function handleClose() {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(0);
    syncDecorations("", 0);
  }

  function handleNext() {
    if (totalMatches === 0) return;
    const next = (activeIndex + 1) % totalMatches;
    setActiveIndex(next);
    syncDecorations(query, next);
  }

  function handlePrev() {
    if (totalMatches === 0) return;
    const prev = (activeIndex - 1 + totalMatches) % totalMatches;
    setActiveIndex(prev);
    syncDecorations(query, prev);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="absolute top-0 right-0 z-10 flex items-center gap-1 rounded-bl-lg border border-border/40 bg-surface-secondary px-3 py-1.5 shadow-sm"
      onBlur={handleFocusOut}
      ref={popoverRef}
    >
      <input
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="h-7 w-48 rounded border border-border/60 bg-background px-2 text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring/50"
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find…"
        ref={inputRef}
        spellCheck={false}
        value={query}
      />
      <span className="min-w-[4rem] text-center text-xs text-muted-foreground tabular-nums">
        {query ? `${totalMatches > 0 ? clamped + 1 : 0} of ${totalMatches}` : ""}
      </span>
      <button
        aria-label="Previous match"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
        disabled={totalMatches === 0}
        onClick={handlePrev}
      >
        <ChevronUp size={14} />
      </button>
      <button
        aria-label="Next match"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30"
        disabled={totalMatches === 0}
        onClick={handleNext}
      >
        <ChevronDown size={14} />
      </button>
      <button
        aria-label="Close find"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        onClick={handleClose}
      >
        <X size={14} />
      </button>
    </div>
  );
}
