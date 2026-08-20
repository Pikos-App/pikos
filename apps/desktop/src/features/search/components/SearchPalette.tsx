// Two ways in. A plain query is one FTS5 search with bm25() weighting: title
// matches rank first, content matches show a snippet below, and the frontend
// handles highlighting. A query carrying operators (`tag:`, `folder:`, `is:`,
// `priority:`, `due:`) is a structured `listPages` filter instead — see
// runFilteredSearch for how free text still reaches FTS5 on that path.

import type {
  Folder,
  PageSummary,
  ParsedSearchQuery,
  SearchResponse,
  SearchResult,
  StorageAdapter,
} from "@pikos/core";
import {
  buildSearchFilter,
  ftsTokens,
  isDone,
  parseSearchQuery,
  PRIORITY_LABELS,
} from "@pikos/core";
import { Command, FileText, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/shared/components/EmptyState";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { formatCombo } from "@/shared/keyboard/formatCombo";
import type { Binding } from "@/shared/keyboard/registry";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { createLogger } from "@/shared/logger";

const log = createLogger("SearchPalette");

/** FTS5 needs something to prefix-match on; below this the query is too broad to run. */
const MIN_QUERY_LENGTH = 2;

/** Leading character that turns the palette into a command list. */
const COMMAND_PREFIX = ">";
// The trailing space is functional: it leaves the caret past the prefix so the
// first keystroke filters commands instead of sitting flush against ">".
const COMMAND_PREFILL = `${COMMAND_PREFIX} `;

type SearchPagesFn = (query: string, includeCompleted?: boolean) => Promise<SearchResponse>;

/** Substring first, then a subsequence pass so ">tgsb" still finds "Toggle sidebar". */
function commandMatches(label: string, filter: string): boolean {
  if (filter === "") return true;
  const haystack = label.toLowerCase();
  if (haystack.includes(filter)) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === filter[i]) i++;
    if (i === filter.length) return true;
  }
  return false;
}

function highlightText(text: string, queryWords: string[]): React.ReactNode {
  if (!text || queryWords.length === 0) return text;

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

/** "2026-03-23" or "2026-03-23T10:00:00" → "Mar 23, 2026". */
function formatShortDate(iso: string): string {
  // Parse date-only or datetime strings — avoid timezone shifts by parsing parts directly
  const datePart = iso.split("T")[0];
  if (!datePart) return iso;
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Second-line summary for title-only matches: date · priority · tags, falling back to subtitle, then content preview. */
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

  if (item.subtitle) return item.subtitle;

  // Fallback: first ~80 chars of content preview
  if (item.contentPreview) return item.contentPreview;

  return "";
}

/** A row for a page the filter path returned — no bm25 excerpt exists, so the
 *  metadata line carries the second line (the same shape recents use). */
function summaryToResult(page: PageSummary): SearchResult {
  return {
    contentPreview: "",
    excerpt: "",
    id: page.id,
    matchSource: "title" as const,
    priority: page.priority,
    scheduledDate: page.scheduledStart ?? null,
    status: page.status,
    subtitle: page.subtitle ?? null,
    tags: page.tags,
    title: page.title,
  };
}

/**
 * The operator path. `listPages` applies the structured filter; free text still
 * goes through FTS5 and the two sets are intersected, so a mixed query keeps
 * bm25 ranking and its excerpts. Residual text is deliberately not passed as
 * `PageFilter.query` — that field is an unindexed LIKE scan list_pages_impl
 * documents as test-only.
 */
async function runFilteredSearch(
  parsed: ParsedSearchQuery,
  opts: {
    folders: Folder[];
    includeCompleted: boolean;
    searchPages: SearchPagesFn;
    storage: StorageAdapter;
  }
): Promise<SearchResponse> {
  const { filter, unresolvedFolder } = buildSearchFilter(parsed, opts.folders);
  // A folder name nothing matches can't narrow to anything — returning the
  // unfiltered set would quietly answer a different question.
  if (unresolvedFolder !== null) return { completedCount: 0, results: [] };

  const summaries = await opts.storage.listPages(filter);

  let rows: SearchResult[];
  if (parsed.text.length >= MIN_QUERY_LENGTH) {
    const allowed = new Set(summaries.map((p) => p.id));
    const { results } = await opts.searchPages(parsed.text, true);
    rows = results.filter((r) => allowed.has(r.id));
  } else {
    // A single leftover character is below the FTS floor — match it on the title.
    const needle = parsed.text.toLowerCase();
    rows = summaries
      .filter((p) => needle === "" || p.title.toLowerCase().includes(needle))
      .map(summaryToResult);
  }

  return {
    completedCount: rows.filter(isDone).length,
    results: opts.includeCompleted ? rows : rows.filter((r) => !isDone(r)),
  };
}

export function SearchPalette() {
  const { activePageId, dialogPrefill, openDialog, openPage, setOpenDialog } = useUI();
  const { folders, pages, searchPages } = usePages();
  const { storage } = useWorkspace();

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
    // On open transition: seed query from deep-link prefill if present,
    // otherwise leave the previous query alone (existing behaviour).
    if (isOpen && !prevIsOpen && dialogPrefill !== null) {
      setQuery(dialogPrefill);
    }
  }

  // ── Command mode ("> …") ─────────────────────────────────────────────────

  const isCommandMode = query.startsWith(COMMAND_PREFIX);
  const commandFilter = query.slice(COMMAND_PREFIX.length).trim().toLowerCase();

  const [commands, setCommands] = useState<Binding[]>([]);
  const [prevCommandMode, setPrevCommandMode] = useState(isCommandMode);
  if (isCommandMode !== prevCommandMode) {
    setPrevCommandMode(isCommandMode);
    // Snapshot on entry. The registry is a module store, not React state, so
    // reading it every render would tie the command list to unrelated renders;
    // what's active can't change while the palette holds the keyboard anyway.
    setCommands(isCommandMode ? Keyboard.listCommands() : []);
    setResults([]);
    setCompletedCount(0);
  }

  const commandItems = isCommandMode
    ? commands.filter((c) => commandMatches(c.label ?? "", commandFilter))
    : [];

  useKeyboardShortcut(
    "Mod+K",
    () => {
      if (!isOpen) setOpenDialog("search");
    },
    { allowInInputs: true, group: "Navigation", label: "Search pages" }
  );

  useKeyboardShortcut(
    "Mod+Shift+K",
    () => {
      if (!isOpen) setOpenDialog("search", COMMAND_PREFILL);
    },
    { allowInInputs: true, group: "Navigation", label: "Run a command" }
  );

  // ── Search with debounce ──────────────────────────────────────────────────

  useEffect(() => {
    const q = query.trim();
    // Command mode never touches the database.
    if (q.startsWith(COMMAND_PREFIX)) return;
    const parsedQuery = parseSearchQuery(q);
    // Operators carry their own meaning, so `tag:x` runs on its own; plain text
    // still waits for two characters before hitting the index.
    if (!parsedQuery.hasOperators && q.length < MIN_QUERY_LENGTH) return;
    if (parsedQuery.hasOperators && !storage) return;

    const timer = setTimeout(() => {
      const search =
        parsedQuery.hasOperators && storage
          ? runFilteredSearch(parsedQuery, {
              folders,
              // `is:done` asks for completed pages outright — honour it whatever
              // the toggle says, and let the toggle report that below.
              includeCompleted: showCompleted || parsedQuery.status === "done",
              searchPages,
              storage,
            })
          : searchPages(q, showCompleted || undefined);

      search
        .then(({ completedCount: count, results: res }) => {
          setResults(res);
          setCompletedCount(count);
        })
        .catch((err: unknown) => {
          // FTS5 syntax errors echo the user's query. Log only the error
          // class — never pass `err` directly, never log the query text.
          log.error("search failed", err instanceof Error ? err.name : "unknown");
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, showCompleted, searchPages, folders, storage]);

  // ── Recent pages (shown when input is empty) ────────────────────────────

  const recentItems: SearchResult[] = query.trim()
    ? []
    : [...pages]
        .filter((p) => p.lastOpenedAt && p.id !== activePageId)
        .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
        .slice(0, 10)
        .map(summaryToResult);

  const pageItems = query.trim() ? results : recentItems;
  const displayCount = isCommandMode ? commandItems.length : pageItems.length;
  const clampedIdx = Math.min(selectedIdx, Math.max(0, displayCount - 1));

  const trimmedQuery = query.trim();
  const parsed = parseSearchQuery(trimmedQuery);
  // Highlight what the index matched, not what the user typed — "multi-color" is two
  // tokens to FTS, so a page holding "multi color" is a hit with nothing to mark.
  // On the operator path only the residual text reached the index.
  const queryWords = ftsTokens(parsed.hasOperators ? parsed.text : trimmedQuery);

  function handleSelect(id: string) {
    openPage(id);
    resetAndClose();
  }

  function runCommand(binding: Binding) {
    resetAndClose();
    // Close first: the handler acts on the surface underneath, and several of
    // them open a dialog of their own that would otherwise race this one for focus.
    binding.handler(new KeyboardEvent("keydown"));
  }

  function resetAndClose() {
    setOpenDialog(null);
    setQuery("");
    setResults([]);
    setCompletedCount(0);
    setSelectedIdx(0);
    setShowCompleted(false);
  }

  /** Index of the item in the flat result list — drives keyboard selection. */
  function getDisplayIndex(item: SearchResult): number {
    return pageItems.indexOf(item);
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
        const next = Math.min(i + 1, displayCount - 1);
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
      if (isCommandMode) {
        const command = commandItems[clampedIdx];
        if (command) runCommand(command);
        return;
      }
      const item = pageItems[clampedIdx];
      if (item) handleSelect(item.id);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetAndClose();
  }

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
            {isDone(item) && (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/40">
                Completed
              </span>
            )}
          </span>
          {secondLine != null && (
            <span className="mt-0.5 block truncate text-xs text-subtle">{secondLine}</span>
          )}
        </div>
      </button>
    );
  }

  function renderCommand(binding: Binding, idx: number) {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors",
          idx === clampedIdx ? "bg-accent text-foreground" : mouseActive && "hover:bg-accent/50"
        )}
        key={binding.id}
        onClick={() => runCommand(binding)}
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
        <Command className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate">{binding.label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {formatCombo(binding.combo).map((token, i) => (
            <kbd
              className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
              key={i}
            >
              {token}
            </kbd>
          ))}
        </span>
      </button>
    );
  }

  const showEmpty = trimmedQuery && results.length === 0 && completedCount === 0;

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent
        aria-label="Search pages"
        className="top-[15%] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl sm:max-w-[540px]"
        // Radix's focus scope selects an input's contents when it autofocuses,
        // which makes the first keystroke replace a prefill rather than extend
        // it. Focus it here instead, caret collapsed to the end.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }}
        showCloseButton={false}
      >
        {/* Radix Dialog requires a title + description for screen readers
            even on a command-palette UI; sr-only keeps both invisible. */}
        <DialogTitle className="sr-only">Search pages</DialogTitle>
        <DialogDescription className="sr-only">
          Search across all pages and folders, or start with &gt; to run a command. Use arrow keys
          to navigate results, Enter to open.
        </DialogDescription>
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
            placeholder="Search pages, or > for commands…"
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
          {isCommandMode ? (
            <>
              {/* Commands — whatever the keyboard registry has active right now */}
              {commandItems.map(renderCommand)}

              {commandItems.length === 0 && <EmptyState compact message="No matching commands" />}
            </>
          ) : (
            <>
              {/* Recent pages (no query) */}
              {!trimmedQuery && recentItems.length > 0 && recentItems.map(renderItem)}

              {/* Search results — bm25 ranked order, no section splits */}
              {trimmedQuery && results.length > 0 && results.map(renderItem)}

              {/* Empty state — search returned nothing (and no completed matches either) */}
              {showEmpty && <EmptyState compact message="No pages found" />}

              {/* Toggle to include/hide completed pages. `is:done` already asked for
                  them, so the toggle reports that state instead of offering to fight it. */}
              {trimmedQuery &&
                (showCompleted || completedCount > 0) &&
                (parsed.status === "done" ? (
                  <p className="px-4 py-1.5 text-xs text-muted-foreground/50">
                    Showing completed — is:done
                  </p>
                ) : (
                  <button
                    className="w-full px-4 py-1.5 text-left text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground/70"
                    onClick={() => setShowCompleted((v) => !v)}
                    type="button"
                  >
                    {showCompleted ? "Hide completed" : `Show completed (${completedCount})`}
                  </button>
                ))}

              {/* Empty state — no recent pages and no query */}
              {!trimmedQuery && recentItems.length === 0 && (
                <EmptyState compact message="No recent pages" />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
