import type { PagePriority, PageRecurrenceRule, PageStatus, PageSummary } from "@pikos/core";
import { getVisiblePages, isDateGroupedView, sortPages, withTodayOccurrences } from "@pikos/core";
import { useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import { useRecurrenceExpansion } from "@/shared/hooks/useRecurrenceExpansion";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";

import { useActiveSortMode } from "./useActiveSortMode";
import { useCompletedPages } from "./useCompletedPages";

export const UNDO_TOAST_DURATION_MS = 8000;

const NO_RULES: PageRecurrenceRule[] = [];

export function usePageList() {
  const {
    expandRecurrenceRange,
    folders,
    listOverridesForRules,
    overridesVersion,
    pages,
    recurrenceRules,
    updatePage,
  } = usePages();
  const togglePageStatus = useRecurringStatusToggle();
  const { activeViewId, openPage, setActivePage } = useUI();
  const sortMode = useActiveSortMode();
  const { hiddenIds, requestDeletePage } = useUndoDelete();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const completed = useCompletedPages(activeViewId);
  const isTodayView = activeViewId === "today";

  // The same expansion the calendar grid renders, so the two can't disagree
  // about today. No rules outside Today keeps other views off the round-trip.
  const expanded = useRecurrenceExpansion({
    days: [new Date()],
    expandRecurrenceRange,
    listOverridesForRules,
    overridesVersion,
    pages,
    recurrenceRules: isTodayView ? recurrenceRules : NO_RULES,
  });

  const filtered = getVisiblePages(pages, activeViewId).filter((p) => !hiddenIds.has(p.id));
  const withOccurrences = isTodayView ? withTodayOccurrences(filtered, expanded) : filtered;
  // Today and Upcoming are ordered by their sections (overdue/today, then day
  // groups), so running sortPages here would only churn an order the section
  // builders are about to replace.
  const visiblePages = isDateGroupedView(activeViewId)
    ? withOccurrences
    : sortPages(withOccurrences, sortMode);

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
    // itself (in `pages`), then a done clone (in completedPages).
    const page =
      visiblePages.find((p) => p.id === pageId) ??
      pages.find((p) => p.id === pageId) ??
      completed.completedPages.find((p) => p.id === pageId);
    if (page) togglePageStatus(page, nextStatus);
  }

  function handlePriorityChange(pageId: string, priority: PagePriority) {
    updatePage(pageId, { priority });
  }

  return {
    activePage,
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
