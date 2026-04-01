import type { PageSummary } from "@pikos/core";
import { localToday, parseLocalISO } from "@pikos/core";
import { useRef, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

const PAGE_SIZE = 20;

interface PaginationState {
  total: number;
  offset: number;
}

/**
 * Lazy-loads completed pages when the "Completed" section is expanded.
 * Fetches PAGE_SIZE at a time into the WorkspaceContext pages array,
 * so all optimistic updates (title edits, status toggles) work automatically.
 */
export function useCompletedPages(activeViewId: string) {
  const { listCompletedPages, mergePages, pages } = useWorkspace();

  // Per-view pagination metadata (no page data — that lives in WorkspaceContext)
  const [paginationMap, setPaginationMap] = useState<Map<string, PaginationState>>(new Map());
  const fetchedViewsRef = useRef<Set<string>>(new Set());

  const pagination = paginationMap.get(activeViewId);

  function updatePagination(viewId: string, state: PaginationState) {
    setPaginationMap((prev) => {
      const next = new Map(prev);
      next.set(viewId, state);
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

  /** Called when the completed section is expanded. Fetches the first batch if not already loaded. */
  async function onExpand() {
    if (fetchedViewsRef.current.has(activeViewId)) return;
    fetchedViewsRef.current.add(activeViewId);
    try {
      const result = await listCompletedPages(buildFilter(0));
      mergePages(result.pages);
      updatePagination(activeViewId, {
        offset: result.pages.length,
        total: result.total,
      });
    } catch {
      fetchedViewsRef.current.delete(activeViewId);
    }
  }

  /** Fetches the next batch of completed pages. */
  async function loadMore() {
    if (!pagination) return;
    const result = await listCompletedPages(buildFilter(pagination.offset));
    mergePages(result.pages);
    updatePagination(activeViewId, {
      offset: pagination.offset + result.pages.length,
      total: result.total,
    });
  }

  // Derive completed pages from the context's pages array — same source as optimistic updates.
  const isTodayView = activeViewId === "today";
  const today = localToday();
  const completedPages = pages
    .filter((p) => {
      if (p.status !== "done") return false;
      if (isTodayView) return p.completedAt?.slice(0, 10) === today;
      if (activeViewId === "inbox") return p.folderId === null;
      return p.folderId === activeViewId;
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
