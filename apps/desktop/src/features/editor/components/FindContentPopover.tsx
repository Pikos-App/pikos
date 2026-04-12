// FindContentPopover — minimal ⌘F find-in-page for the Tiptap editor.
// Text search with next/prev navigation and match count.
// Highlights matches via ProseMirror Decoration.inline.
// Closes on Esc or click outside, clearing highlights.
//
// Architecture: a shared ref holds the current query + activeIndex. The
// ProseMirror plugin reads from that ref in its decorations() callback —
// no plugin state, no meta transactions. React owns the search state;
// event handlers update the ref and kick a no-op transaction so ProseMirror
// re-reads decorations.

import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEditorState } from "@tiptap/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

// ── Shared ref read by the plugin ────────────────────────────────────────────

interface FindParams {
  query: string;
  activeIndex: number;
}

const findPluginKey = new PluginKey("findContentPopover");

// ── Build decorations from doc + search params ───────────────────────────────

function buildDecorations(doc: PmNode, { activeIndex, query }: FindParams): DecorationSet {
  if (!query) return DecorationSet.empty;

  const decos: Decoration[] = [];
  const lowerQuery = query.toLowerCase();
  let matchIdx = 0;

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(lowerQuery, idx);
      if (found === -1) break;
      const from = pos + found;
      const to = from + query.length;
      const cls = matchIdx === activeIndex ? "find-match find-match-active" : "find-match";
      decos.push(Decoration.inline(from, to, { class: cls }));
      matchIdx++;
      idx = found + 1;
    }
  });

  return DecorationSet.create(doc, decos);
}

function createFindPlugin(paramsRef: React.RefObject<FindParams>): Plugin {
  return new Plugin({
    key: findPluginKey,
    props: {
      decorations(state) {
        return buildDecorations(state.doc, paramsRef.current);
      },
    },
  });
}

// ── Count matches ────────────────────────────────────────────────────────────

function countMatches(doc: PmNode, query: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  let count = 0;
  doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(lowerQuery, idx);
      if (found === -1) break;
      count++;
      idx = found + 1;
    }
  });
  return count;
}

// ── FindContentPopover component ─────────────────────────────────────────────

interface FindContentPopoverProps {
  editor: Editor;
}

export function FindContentPopover({ editor }: FindContentPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const paramsRef = useRef<FindParams>({ activeIndex: 0, query: "" });

  // Register the plugin once, passing the shared ref
  useEffect(() => {
    const plugin = createFindPlugin(paramsRef);
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(findPluginKey);
    };
  }, [editor]);

  // ⌘F opens the popover
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
    { allowInInputs: true }
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

  // Derive totalMatches from editor doc + query (recomputes on doc edits too)
  const { totalMatches } = useEditorState({
    editor,
    selector: (ctx) => ({
      totalMatches: countMatches(ctx.editor.state.doc, query),
    }),
  });

  const clamped = totalMatches > 0 ? activeIndex % totalMatches : 0;

  // Push current search params into the ref and kick ProseMirror to redraw.
  // Called from event handlers only — never from effects or render.
  function syncDecorations(q: string, idx: number) {
    if (editor.isDestroyed) return;
    paramsRef.current = { activeIndex: idx, query: q };
    editor.view.dispatch(editor.state.tr);
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
        className="h-7 w-48 rounded border border-border/60 bg-background px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-ring/50"
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
