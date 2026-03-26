import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { useState } from "react";

import {
  getCompletedTodayPages,
  getCompletedViewPages,
  getVisiblePages,
  sortPages,
} from "@/features/pages/utils/pageFilters";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useActivePage } from "@/shared/hooks/useActivePage";
import { nowLocalISO } from "@/shared/utils/dates";

export const UNDO_TOAST_DURATION_MS = 8000;

export function usePageList() {
  const { folders, pages, updatePage } = useWorkspace();
  const { activeViewId, getSortMode, openPage, setActivePage } = useUI();
  const { hiddenIds, requestDeletePage } = useUndoDelete();
  const activePage = useActivePage();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const filtered = getVisiblePages(pages, activeViewId).filter((p) => !hiddenIds.has(p.id));
  const visiblePages =
    activeViewId === "today" ? filtered : sortPages(filtered, getSortMode(activeViewId));

  const completedPages = (
    activeViewId === "today"
      ? getCompletedTodayPages(pages)
      : getCompletedViewPages(pages, activeViewId)
  ).filter((p) => !hiddenIds.has(p.id));

  function handleDeleteRequest(page: PageSummary) {
    if (activePage?.id === page.id) setActivePage(null);
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
    renamingId,
    setRenamingId,
    visiblePages,
  };
}
