import { useState } from "react";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useUI } from "@/shared/context/UIContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import {
  getCompletedTodayPages,
  getVisiblePages,
  sortPages,
} from "@/features/pages/utils/pageFilters";
import type { PageSummary, PageStatus } from "@pikos/core";

export function usePageList() {
  const { pages, folders, createPage, updatePage, deletePage } = useWorkspace();
  const { activeViewId, setActivePage, getSortMode } = useUI();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PageSummary | null>(null);

  const filtered = getVisiblePages(pages, activeViewId);
  // Today view has its own date-based grouping; skip extra sort.
  const visiblePages =
    activeViewId === "today" ? filtered : sortPages(filtered, getSortMode(activeViewId));

  const completedTodayPages = activeViewId === "today" ? getCompletedTodayPages(pages) : [];

  /** Create a page in the active folder and immediately enter rename mode. */
  async function handleCreatePage() {
    const folderId = activeViewId !== "today" && activeViewId !== "inbox" ? activeViewId : null;
    const page = await createPage({ folderId });
    setActivePage(page);
    setRenamingId(page.id);
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
      status: isDone ? "not_started" : "done",
      completedAt: isDone ? null : new Date().toISOString(),
    });
  }

  return {
    visiblePages,
    completedTodayPages,
    folders,
    activePage,
    renamingId,
    setRenamingId,
    pendingDelete,
    handleCreatePage,
    handleRenameCommit,
    handleRenameCancel,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleMoveToFolder,
    handleToggleStatus,
    handleSelectPage: setActivePage,
  };
}
