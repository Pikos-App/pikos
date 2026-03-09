import { useCallback, useMemo, useState } from "react";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useUI } from "@/shared/context/UIContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import {
  getCompletedTodayPages,
  getVisiblePages,
  sortPages,
} from "@/features/pages/utils/pageFilters";
import type { Page, PageStatus } from "@pikos/core";

export function usePageList() {
  const { pages, folders, createPage, updatePage, deletePage } = useWorkspace();
  const { activeViewId, setActivePage, getSortMode } = useUI();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Page | null>(null);

  const visiblePages = useMemo(() => {
    const filtered = getVisiblePages(pages, activeViewId);
    // Today view has its own date-based grouping; skip extra sort.
    if (activeViewId === "today") return filtered;
    return sortPages(filtered, getSortMode(activeViewId));
  }, [pages, activeViewId, getSortMode]);

  const completedTodayPages = useMemo(
    () => (activeViewId === "today" ? getCompletedTodayPages(pages) : []),
    [pages, activeViewId]
  );

  /** Create a page in the active folder and immediately enter rename mode. */
  const handleCreatePage = useCallback(async () => {
    const folderId = activeViewId !== "today" && activeViewId !== "inbox" ? activeViewId : null;
    const page = await createPage({ folderId });
    setActivePage(page);
    setRenamingId(page.id);
  }, [activeViewId, createPage, setActivePage]);

  const handleRenameCommit = useCallback(
    (id: string, title: string) => {
      updatePage(id, { title });
      setRenamingId(null);
    },
    [updatePage]
  );

  const handleRenameCancel = useCallback(() => setRenamingId(null), []);

  /** Delete with confirmation if page is non-empty or has a schedule. */
  const handleDeleteRequest = useCallback(
    (page: Page) => {
      const isEmpty = page.content === "" && !page.scheduledStart;
      if (isEmpty) {
        if (activePage?.id === page.id) setActivePage(null);
        void deletePage(page.id);
      } else {
        setPendingDelete(page);
      }
    },
    [deletePage, activePage, setActivePage]
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!pendingDelete) return;
    if (activePage?.id === pendingDelete.id) setActivePage(null);
    void deletePage(pendingDelete.id);
    setPendingDelete(null);
  }, [pendingDelete, deletePage, activePage, setActivePage]);

  const handleDeleteCancel = useCallback(() => setPendingDelete(null), []);

  const handleMoveToFolder = useCallback(
    (pageId: string, folderId: string | null) => {
      updatePage(pageId, { folderId });
    },
    [updatePage]
  );

  const handleToggleStatus = useCallback(
    (pageId: string, currentStatus: PageStatus) => {
      const isDone = currentStatus === "done";
      updatePage(pageId, {
        status: isDone ? "not_started" : "done",
        completedAt: isDone ? null : new Date().toISOString(),
      });
    },
    [updatePage]
  );

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
