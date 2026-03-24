import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { useState } from "react";

import {
  getCompletedTodayPages,
  getCompletedViewPages,
  getVisiblePages,
  sortPages,
} from "@/features/pages/utils/pageFilters";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import { nowLocalISO } from "@/shared/utils/dates";

export function usePageList() {
  const { deletePage, folders, pages, updatePage } = useWorkspace();
  const { activeViewId, getSortMode, openPage, setActivePage } = useUI();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PageSummary | null>(null);

  const filtered = getVisiblePages(pages, activeViewId);
  // Today view has its own date-based grouping; skip extra sort.
  const visiblePages =
    activeViewId === "today" ? filtered : sortPages(filtered, getSortMode(activeViewId));

  const completedPages =
    activeViewId === "today"
      ? getCompletedTodayPages(pages)
      : getCompletedViewPages(pages, activeViewId);

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

  /** Delete with confirmation if page is non-empty or has a schedule. */
  function handleDeleteRequest(page: PageSummary) {
    const isEmpty = page.title === "" && !page.scheduledStart;
    if (isEmpty) {
      if (activePage?.id === page.id) setActivePage(null);
      void deletePage(page.id);
    } else {
      setPendingDelete(page);
    }
  }

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    if (activePage?.id === pendingDelete.id) setActivePage(null);
    void deletePage(pendingDelete.id);
    setPendingDelete(null);
  }

  function handleDeleteCancel() {
    setPendingDelete(null);
  }

  function handleMoveToFolder(pageId: string, folderId: string | null) {
    updatePage(pageId, { folderId });
  }

  function handleToggleStatus(pageId: string, currentStatus: PageStatus) {
    const isDone = currentStatus === "done";
    updatePage(pageId, {
      completedAt: isDone ? null : nowLocalISO(),
      status: isDone ? "not_started" : "done",
    });
  }

  function handlePriorityChange(pageId: string, priority: PagePriority) {
    updatePage(pageId, { priority });
  }

  return {
    activePage,
    completedPages,
    folders,
    handleDeleteCancel,
    handleDeleteConfirm,
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
    pendingDelete,
    renamingId,
    setRenamingId,
    visiblePages,
  };
}
