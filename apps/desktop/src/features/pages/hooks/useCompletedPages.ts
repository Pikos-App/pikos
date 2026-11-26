import type { PageSummary } from "@pikos/core";
import { isDateGroupedView, isOpen, localToday, parseLocalISO } from "@pikos/core";
import { useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { createLogger } from "@/shared/logger";
import { useHeldPages } from "@/shared/viewCache/useHeldPages";

const log = createLogger("useCompletedPages");

const PAGE_SIZE = 20;

interface PaginationState {
  total: number;
  offset: number;
  /** IDs loaded by this view's paginated fetches. The list shows these OR pages completed this session,
   *  so a toggle surfaces instantly while unrelated completed pages in `pages` stay hidden. */
  loadedIds: Set<string>;
}

/** Lazy-loads completed pages, PAGE_SIZE at a time, into the WorkspaceContext pages array. */
export function useCompletedPages(activeViewId: string) {
  const { listCompletedPages, mergePages } = usePages();
  const held = useHeldPages();

  const [paginationMap, setPaginationMap] = useState<Map<string, PaginationState>>(new Map());
  const fetchedViewsRef = useRef<Set<string>>(new Set());
  // Pages completed after this were completed this session and show before pagination fetches them.
  // Floored to the second: `completedAt` has no ms, so a toggle within this mount's second would parse
  // below sessionStartMs. useState's initializer runs outside the render path react-hooks/purity polices.
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
      // Drop the fetched-marker so the next mount can retry; the logged error persists if it keeps failing.
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

  // Derived from the context's pages array, the source of optimistic updates: folder matches and the
  // page was loaded by this view's pagination OR completed this session, which covers "Load more" and
  // "I just marked this done" without surfacing ambient completed pages.
  const loadedIds = pagination?.loadedIds;
  const today = localToday();
  const completedPages = (held ?? [])
    .filter((p) => {
      if (isOpen(p)) return false;
      if (isDateView) {
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
