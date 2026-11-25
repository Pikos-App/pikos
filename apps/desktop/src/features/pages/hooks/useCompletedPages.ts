import type { PageSummary } from "@pikos/core";
import { isDateGroupedView, isOpen, localToday, parseLocalISO } from "@pikos/core";
import { useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { createLogger } from "@/shared/logger";
import { useHeldPages } from "@/shared/viewCache/useHeldPages";

const log = createLogger("useCompletedPages");

const PAGE_SIZE = 20;

interface PaginationState {
  viewId: string;
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
  const { listCompletedPages, mergePages } = usePages();
  const held = useHeldPages();

  const [paginationState, setPaginationState] = useState<PaginationState | null>(null);
  const fetchingViewRef = useRef<string | null>(null);
  // Timestamp captured on mount — pages whose `completedAt` is newer than
  // this were completed during this session and should be visible in the
  // Completed section even before pagination explicitly fetched them.
  // Floored to the second because `completedAt` is stored as
  // `yyyy-MM-dd'T'HH:mm:ss` (no ms), and a toggle within the same wall
  // second as this mount would otherwise parse to <sessionStartMs and be
  // filtered out. useState's initializer runs once, outside the pure-render
  // path that react-hooks/purity polices.
  const [sessionStartMs] = useState(() => Math.floor(Date.now() / 1000) * 1000);

  const pagination = paginationState?.viewId === activeViewId ? paginationState : undefined;

  function mergeLoadedIds(viewId: string, incoming: string[], total: number, offset: number) {
    setPaginationState((prev) => {
      const merged = new Set(prev?.viewId === viewId ? prev.loadedIds : []);
      for (const id of incoming) merged.add(id);
      return { loadedIds: merged, offset, total, viewId };
    });
  }

  // Today and Upcoming are date views, not folders: "completed" there means
  // completed today, which is the only thing that can have left one of their
  // sections during this session. A folder view pages through its own pages.
  const isDateView = isDateGroupedView(activeViewId);

  function buildFilter(offset: number) {
    return {
      ...(isDateView
        ? { completedSince: localToday() }
        : activeViewId === "inbox"
          ? { folderId: null }
          : { folderId: activeViewId }),
      limit: PAGE_SIZE,
      offset,
    };
  }

  /** Fetches the first batch afresh every time, never reusing an earlier one: showing another
   *  view evicts every page no list holds, completed pages included, and a write since (an import,
   *  a sync) can have added completed pages the earlier batch didn't see. */
  async function onExpand() {
    const isFetching = fetchingViewRef.current === activeViewId;
    if (isFetching) return;

    const viewId = activeViewId;
    fetchingViewRef.current = viewId;
    try {
      const result = await listCompletedPages(buildFilter(0));
      mergePages(result.pages);
      setPaginationState({
        loadedIds: new Set(result.pages.map((p) => p.id)),
        offset: result.pages.length,
        total: result.total,
        viewId,
      });
    } catch (err) {
      log.error(`fetchCompletedPages(${activeViewId}) failed`, err);
    } finally {
      fetchingViewRef.current = null;
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
  const today = localToday();
  const completedPages = (held ?? [])
    .filter((p) => {
      if (isOpen(p)) return false;
      if (isDateView) {
        // A date view's completed section shows every page completed today —
        // the date check is already the session gate.
        return p.completedAt?.slice(0, 10) === today;
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
