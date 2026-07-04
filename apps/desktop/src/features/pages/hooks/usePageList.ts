import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";
import { useState } from "react";

import { getVisiblePages, sortPages } from "@/features/pages/utils/pageFilters";
import { usePages } from "@/shared/context/PagesContext";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useActivePage } from "@/shared/hooks/useActivePage";

import { useCompletedPages } from "./useCompletedPages";

export const UNDO_TOAST_DURATION_MS = 8000;

export function usePageList() {
  const {
    folders,
    maybeToggleSyncedOccurrence,
    pages,
    recurrenceRules,
    uncompleteRecurringOrFlip,
    updatePage,
  } = usePages();
  const { request: requestRecurringComplete } = useRecurringCompleteDialog();
  const { activeViewId, getSortMode, openPage, setActivePage } = useUI();
  const { hiddenIds, requestDeletePage } = useUndoDelete();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const completed = useCompletedPages(activeViewId);

  const filtered = getVisiblePages(pages, activeViewId).filter((p) => !hiddenIds.has(p.id));
  const visiblePages =
    activeViewId === "today" ? filtered : sortPages(filtered, getSortMode(activeViewId));

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
    const isDone = currentStatus === "done";
    const nextStatus: PageStatus = isDone ? "not_started" : "done";
    // Synced recurring occurrences (and their done clones) route to occurrence-
    // based completion, never the native head-advance/gap-dialog path. The page
    // may be the active series (in `pages`) or a done clone (in completedPages).
    const page =
      pages.find((p) => p.id === pageId) ?? completed.completedPages.find((p) => p.id === pageId);
    if (page && maybeToggleSyncedOccurrence(page, nextStatus)) return;
    // Recurring completion routes through the gap-resolution dialog (which
    // fast-paths to advance when there's no gap); un-done rewinds the last
    // occurrence. Non-recurring flips directly.
    if (recurrenceRules.some((r) => r.pageId === pageId)) {
      if (isDone) void uncompleteRecurringOrFlip(pageId);
      else requestRecurringComplete(pageId);
      return;
    }
    updatePage(pageId, {
      completedAt: isDone ? null : nowLocalISO(),
      status: nextStatus,
    });
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
