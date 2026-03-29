// SearchPalette — Cmd+P unified search palette.
// Single FTS5 query with bm25() weighting: title matches rank first,
// content matches show a snippet below. Frontend handles highlighting.

import type { SearchResult } from "@pikos/core";
import { FileText, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

// ── Highlight helper ──────────────────────────────────────────────────────────
// Splits text into alternating plain / matched segments based on query words.
// Returns React elements with matched segments highlighted.

function highlightText(text: string, queryWords: string[]): React.ReactNode {
  if (!text || queryWords.length === 0) return text;

  // Build a regex matching any of the query words (case-insensitive)
  const escaped = queryWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, i) => {
    const isMatch = pattern.test(part);
    // Reset lastIndex since we're reusing the regex with `g` flag
    pattern.lastIndex = 0;
    if (isMatch) {
      return (
        <span className="font-medium text-primary" key={i}>
          {part}
        </span>
      );
    }
    return part;
  });
}

// ── Priority labels ──────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

// ── Format scheduled date ────────────────────────────────────────────────────
// "2026-03-23" or "2026-03-23T10:00:00" → "Mar 23, 2026"

function formatShortDate(iso: string): string {
  // Parse date-only or datetime strings — avoid timezone shifts by parsing parts directly
  const datePart = iso.split("T")[0];
  if (!datePart) return iso;
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// ── Build metadata summary for title-only matches ────────────────────────────

function buildMetadataSummary(item: SearchResult): string {
  const parts: string[] = [];

  if (item.scheduledDate) {
    parts.push(formatShortDate(item.scheduledDate));
  }
  // Only show priority if non-default (0 = none)
  const label = PRIORITY_LABELS[item.priority];
  if (label) {
    parts.push(label);
  }
  if (item.tags.length > 0) {
    parts.push(item.tags.map((t) => `#${t}`).join(" "));
  }

  if (parts.length > 0) return parts.join(" \u00B7 ");

  // Fallback: subtitle
  if (item.subtitle) return item.subtitle;

  // Fallback: first ~80 chars of content preview
  if (item.contentPreview) return item.contentPreview;

  return "";
}

export function SearchPalette() {
  const { activePageId, openDialog, openPage, setOpenDialog } = useUI();
  const { pages, searchPages } = useWorkspace();

  const isOpen = openDialog === "search";
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mouseActive, setMouseActive] = useState(false);
  const [mouseMoved, setMouseMoved] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Reset mouse guard when palette opens or results change (derived state during render)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [prevResults, setPrevResults] = useState(results);
  if (isOpen !== prevIsOpen || results !== prevResults) {
    setPrevIsOpen(isOpen);
    setPrevResults(results);
    setMouseMoved(false);
    setMouseActive(false);
  }

  // ── Keyboard shortcut ─────────────────────────────────────────────────────

  useKeyboardShortcut(
    "Mod+K",
    () => {
      if (!isOpen) setOpenDialog("search");
    },
    { allowInInputs: true }
  );

  // ── Focus input when palette opens ───────────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // ── Search with debounce ──────────────────────────────────────────────────

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;

    const timer = setTimeout(() => {
      searchPages(q, showCompleted || undefined)
        .then(({ completedCount: count, results: res }) => {
          setResults(res);
          setCompletedCount(count);
        })
        .catch((err) => {
          console.error("search failed:", err);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, showCompleted, searchPages]);

  // ── Recent pages (shown when input is empty) ────────────────────────────

  const recentItems: SearchResult[] = query.trim()
    ? []
    : [...pages]
        .filter((p) => p.lastOpenedAt && p.id !== activePageId)
        .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
        .slice(0, 10)
        .map((p) => ({
          contentPreview: "",
          excerpt: "",
          id: p.id,
          matchSource: "title" as const,
          priority: p.priority,
          scheduledDate: p.scheduledStart ?? null,
          status: p.status,
          subtitle: p.subtitle ?? null,
          tags: p.tags,
          title: p.title,
        }));

  const displayItems = query.trim() ? results : recentItems;
  const clampedIdx = Math.min(selectedIdx, Math.max(0, displayItems.length - 1));

  const trimmedQuery = query.trim();
  const queryWords = trimmedQuery ? trimmedQuery.split(/\s+/).filter(Boolean) : [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleSelect(id: string) {
    openPage(id);
    resetAndClose();
  }

  function resetAndClose() {
    setOpenDialog(null);
    setQuery("");
    setResults([]);
    setCompletedCount(0);
    setSelectedIdx(0);
    setShowCompleted(false);
  }

  // Track which item index in the flat displayItems list each button maps to
  // for keyboard selection
  function getDisplayIndex(item: SearchResult): number {
    return displayItems.indexOf(item);
  }

  function scrollToIdx(idx: number) {
    // Defer to next frame so the DOM has updated with the new selected state
    requestAnimationFrame(() => {
      itemRefs.current.get(idx)?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMouseMoved(false);
      setMouseActive(false);
      setSelectedIdx((i) => {
        const next = Math.min(i + 1, displayItems.length - 1);
        scrollToIdx(next);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMouseMoved(false);
      setMouseActive(false);
      setSelectedIdx((i) => {
        const next = Math.max(i - 1, 0);
        scrollToIdx(next);
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = displayItems[clampedIdx];
      if (item) handleSelect(item.id);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetAndClose();
  }

  // ── Result item renderer ────────────────────────────────────────────────

  function renderItem(item: SearchResult) {
    const idx = getDisplayIndex(item);
    const highlightTitle = item.matchSource === "title" || item.matchSource === "both";
    const hasContentExcerpt =
      item.excerpt && (item.matchSource === "content" || item.matchSource === "both");

    // Line 2: subtitle (highlighted) for subtitle matches, content excerpt for content/both,
    // metadata summary for title-only
    let secondLine: React.ReactNode = null;
    if (item.matchSource === "subtitle" && item.subtitle) {
      secondLine = queryWords.length > 0 ? highlightText(item.subtitle, queryWords) : item.subtitle;
    } else if (hasContentExcerpt) {
      secondLine = queryWords.length > 0 ? highlightText(item.excerpt, queryWords) : item.excerpt;
    } else if (trimmedQuery) {
      const summary = buildMetadataSummary(item);
      if (summary) secondLine = summary;
    }

    return (
      <button
        className={cn(
          "flex w-full items-start gap-2.5 px-4 py-2 text-left text-sm transition-colors",
          idx === clampedIdx ? "bg-accent text-foreground" : mouseActive && "hover:bg-accent/50"
        )}
        key={item.id}
        onClick={() => handleSelect(item.id)}
        onMouseEnter={() => {
          if (mouseMoved) {
            setMouseActive(true);
            setSelectedIdx(idx);
          }
        }}
        ref={(el) => {
          if (el) itemRefs.current.set(idx, el);
          else itemRefs.current.delete(idx);
        }}
      >
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate">
            <span className="truncate">
              {highlightTitle && queryWords.length > 0
                ? highlightText(item.title || "Untitled", queryWords)
                : item.title || "Untitled"}
            </span>
            {item.status === "done" && (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/40">
                Completed
              </span>
            )}
          </span>
          {secondLine != null && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground/60">
              {secondLine}
            </span>
          )}
        </div>
      </button>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const showEmpty = trimmedQuery && results.length === 0 && completedCount === 0;

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent
        aria-label="Search pages"
        className="top-[15%] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl sm:max-w-[540px]"
        showCloseButton={false}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground/50" />
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
            onChange={(e) => {
              const val = e.target.value;
              setQuery(val);
              setSelectedIdx(0);
              if (!val.trim()) {
                setResults([]);
                setCompletedCount(0);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search pages…"
            ref={inputRef}
            spellCheck={false}
            value={query}
          />
        </div>

        {/* Results */}
        <div
          className="max-h-[340px] overflow-y-auto py-1"
          onMouseMove={() => {
            if (!mouseMoved) setMouseMoved(true);
          }}
        >
          {/* Recent pages (no query) */}
          {!trimmedQuery && recentItems.length > 0 && recentItems.map(renderItem)}

          {/* Search results — bm25 ranked order, no section splits */}
          {trimmedQuery && results.length > 0 && results.map(renderItem)}

          {/* Empty state — search returned nothing (and no completed matches either) */}
          {showEmpty && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">No pages found</p>
            </div>
          )}

          {/* Toggle to include/hide completed pages */}
          {trimmedQuery && (showCompleted || completedCount > 0) && (
            <button
              className="w-full px-4 py-1.5 text-left text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground/70"
              onClick={() => setShowCompleted((v) => !v)}
              type="button"
            >
              {showCompleted ? "Hide completed" : `Show completed (${completedCount})`}
            </button>
          )}

          {/* Empty state — no recent pages and no query */}
          {!trimmedQuery && recentItems.length === 0 && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground/50">No recent pages</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
