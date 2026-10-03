import type { PagePriority, PageRecurrenceRule, PageStatus, PageSummary } from "@pikos/core";
import { useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useSelection } from "@/shared/context/SelectionContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import { useRecurrenceExpansion } from "@/shared/hooks/useRecurrenceExpansion";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";
import { buildCachedList } from "@/shared/viewCache/cachedList";
import { useCachedViews } from "@/shared/viewCache/useCachedView";
import { useHeldPages, usePageLookup } from "@/shared/viewCache/useHeldPages";

import { useActiveSortMode } from "./useActiveSortMode";
import { useCompletedPages } from "./useCompletedPages";

export const UNDO_TOAST_DURATION_MS = 8000;

const NO_RULES: PageRecurrenceRule[] = [];
const NO_PAGES: PageSummary[] = [];

export function usePageList() {
  const {
    expandRecurrenceRange,
    folders,
    listOverridesForRules,
    overridesVersion,
    recurrenceRules,
    updatePage,
  } = usePages();
  const togglePageStatus = useRecurringStatusToggle();
  const { activeViewId, openPage, setActivePage } = useUI();
  const sortMode = useActiveSortMode();
  const { hiddenIds, requestDeletePage } = useUndoDelete();
  const activePage = useActivePage();
  const { selectedPageIds } = useSelection();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const cachedViews = useCachedViews(activeViewId, sortMode, [
    ...(activePage ? [activePage.id] : []),
    ...selectedPageIds,
  ]);

  const completed = useCompletedPages(activeViewId);
  const isTodayView = activeViewId === "today";

  // The same expansion the calendar grid renders, so the two can't disagree
  // about today. No rules outside Today keeps other views off the round-trip,
  // and off the held pages, whose every change would re-render the list.
  const source = useHeldPages(isTodayView) ?? NO_PAGES;
  const lookup = usePageLookup();
  const expanded = useRecurrenceExpansion({
    days: [new Date()],
    expandRecurrenceRange,
    listOverridesForRules,
    overridesVersion,
    pages: source,
    recurrenceRules: isTodayView ? recurrenceRules : NO_RULES,
  });

  const cached =
    cachedViews &&
    buildCachedList({
      hiddenIds,
      occurrences: expanded,
      pages: source,
      today: cachedViews.today,
      viewId: activeViewId,
      views: cachedViews.views,
      waiting: isTodayView && !cachedViews.headsReady,
    });
  const visiblePages = cached?.pages ?? NO_PAGES;

  const completedPages = completed.completedPages.filter((p) => !hiddenIds.has(p.id));

  function handleDeleteRequest(page: PageSummary) {
    requestDeletePage(page);
  }

  function handleRenameChange(id: string, title: string) {
    updatePage(id, { title });
  }

  function handleRenameCommit(id: string, title: string) {
    updatePage(id, { title });
    setRenamingId(null);
  }

  function handleRenameCancel() {
    setRenamingId(null);
  }

  function handleMoveToFolder(pageId: string, folderId: string | null) {
    updatePage(pageId, { folderId });
  }

  function handleToggleStatus(pageId: string, currentStatus: PageStatus) {
    const nextStatus: PageStatus = currentStatus === "done" ? "not_started" : "done";
    // The rendered row first: on Today it can be an occurrence standing in for
    // its series, and the tick has to land on the date shown. Then the series
    // itself (held), then a done clone (in completedPages).
    const page =
      visiblePages.find((p) => p.id === pageId) ??
      lookup(pageId) ??
      completed.completedPages.find((p) => p.id === pageId);
    if (page) togglePageStatus(page, nextStatus);
  }

  function handlePriorityChange(pageId: string, priority: PagePriority) {
    updatePage(pageId, { priority });
  }

  return {
    activePage,
    /** The view's lists loaded a window at a time, when the view cache serves it. */
    cached,
    completedHasMore: completed.hasMore,
    completedPages,
    folders,
    handleDeleteRequest,
    handleMoveToFolder,
    handlePriorityChange,
    handleRenameCancel,
    handleRenameChange,
    handleRenameCommit,
    handleSelectPage: (page: PageSummary | string | null) => {
      if (page !== null) openPage(page);
      else setActivePage(null);
    },
    handleToggleStatus,
    loadMoreCompleted: completed.loadMore,
    onExpandCompleted: completed.onExpand,
    renamingId,
    setRenamingId,
    visiblePages,
  };
}
