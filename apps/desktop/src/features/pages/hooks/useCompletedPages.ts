import type { PageSummary } from "@pikos/core";
import { isOpen, localToday, parseLocalISO } from "@pikos/core";
import { useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("useCompletedPages");

const PAGE_SIZE = 20;

interface PaginationState {
  total: number;
  offset: number;
  /** IDs explicitly loaded by this view's paginated fetches. The derived
   * list shows pages in this set OR pages completed during the current
   * session — so an optimistic status toggle surfaces instantly while
   * unrelated completed pages that happen to live in the `pages` array
   * (e.g. pulled in by CalendarView's range fetch) stay hidden. */
  loadedIds: Set<string>;
}

/**
 * Lazy-loads completed pages when the "Completed" section is expanded.
 * Fetches PAGE_SIZE at a time into the WorkspaceContext pages array,
 * so all optimistic updates (title edits, status toggles) work automatically.
 */
export function useCompletedPages(activeViewId: string) {
  const { listCompletedPages, mergePages, pages } = usePages();

  // Per-view pagination metadata (no page data — that lives in WorkspaceContext)
  const [paginationMap, setPaginationMap] = useState<Map<string, PaginationState>>(new Map());
  const fetchedViewsRef = useRef<Set<string>>(new Set());
  // Timestamp captured on mount — pages whose `completedAt` is newer than
  // this were completed during this session and should be visible in the
  // Completed section even before pagination explicitly fetched them.
  // Floored to the second because `completedAt` is stored as
  // `yyyy-MM-dd'T'HH:mm:ss` (no ms), and a toggle within the same wall
  // second as this mount would otherwise parse to <sessionStartMs and be
  // filtered out. useState's initializer runs once, outside the pure-render
  // path that react-hooks/purity polices.
  const [sessionStartMs] = useState(() => Math.floor(Date.now() / 1000) * 1000);

  const pagination = paginationMap.get(activeViewId);

  function mergeLoadedIds(viewId: string, incoming: string[], total: number, offset: number) {
    setPaginationMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(viewId);
      const merged = new Set(existing?.loadedIds ?? []);
      for (const id of incoming) merged.add(id);
      next.set(viewId, { loadedIds: merged, offset, total });
      return next;
    });
  }

  function buildFilter(offset: number) {
    const isTodayView = activeViewId === "today";
    return {
      ...(isTodayView
        ? { completedSince: localToday() }
        : activeViewId === "inbox"
          ? { folderId: null }
          : { folderId: activeViewId }),
      limit: PAGE_SIZE,
      offset,
    };
  }

  async function onExpand() {
    if (fetchedViewsRef.current.has(activeViewId)) return;
    fetchedViewsRef.current.add(activeViewId);
    try {
      const result = await listCompletedPages(buildFilter(0));
      mergePages(result.pages);
      mergeLoadedIds(
        activeViewId,
        result.pages.map((p) => p.id),
        result.total,
        result.pages.length
      );
    } catch (err) {
      // Drop the fetched-marker so the next mount can retry. Logging the
      // swallowed error keeps a record in the log file if the fetch keeps
      // failing for the same view.
      log.error(`fetchCompletedPages(${activeViewId}) failed`, err);
      fetchedViewsRef.current.delete(activeViewId);
    }
  }

  async function loadMore() {
    if (!pagination) return;
    const result = await listCompletedPages(buildFilter(pagination.offset));
    mergePages(result.pages);
    mergeLoadedIds(
      activeViewId,
      result.pages.map((p) => p.id),
      result.total,
      pagination.offset + result.pages.length
    );
  }

  // Derive completed pages from the context's pages array — same source as
  // optimistic updates. The include rule is: folder matches and either the
  // page was loaded by this view's pagination OR it was completed during
  // this session. Together that covers the user's two natural expectations
  // (explicit "Load more" and "I just marked this done") without surfacing
  // ambient completed pages that got into `pages` via other code paths.
  const loadedIds = pagination?.loadedIds;
  const completedPages = pages
    .filter((p) => {
      if (isOpen(p)) return false;
      if (activeViewId === "today") {
        // Today's completed section shows every page completed today — the
        // date check is already the session gate.
        return p.completedAt?.slice(0, 10) === localToday();
      }
      if (activeViewId === "inbox") {
        if (p.folderId !== null) return false;
      } else if (p.folderId !== activeViewId) {
        return false;
      }
      const wasPaginated = loadedIds?.has(p.id) ?? false;
      const completedAtMs = p.completedAt ? parseLocalISO(p.completedAt).getTime() : 0;
      // `>=` not `>`: same-ms captures (rare but possible in tests and fast
      // toggles) shouldn't silently hide a just-completed page.
      const completedThisSession = completedAtMs >= sessionStartMs;
      return wasPaginated || completedThisSession;
    })
    .sort((a: PageSummary, b: PageSummary) => {
      const aTime = a.completedAt ? parseLocalISO(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? parseLocalISO(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

  const hasMore = pagination != null && pagination.offset < pagination.total;

  return {
    completedPages,
    hasMore,
    loadMore,
    onExpand,
  };
}
