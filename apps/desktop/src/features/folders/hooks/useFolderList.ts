import type { Folder } from "@pikos/core";
import { localToday } from "@pikos/core";
import { useState } from "react";

import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

export type FolderSortOrder = "manual" | "alphabetical" | "page-count";

export interface FolderListState {
  folders: Folder[];
  pageCountByFolder: Record<string, number>;
  activeViewId: string;
  setActiveViewId: (id: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  todayCount: number;
  inboxCount: number;
  sortOrder: FolderSortOrder;
  setSortOrder: (order: FolderSortOrder) => void;
  handleCreateFolder: () => Promise<void>;
  handleRenameCommit: (id: string, name: string) => void;
  handleDeleteRequest: (folder: Folder) => void;
  handleColorChange: (id: string, color: string) => void;
}

export function useFolderList(): FolderListState {
  const { createFolder, folders, pages, updateFolder } = useWorkspace();
  const { hiddenFolderIds, requestDeleteFolder } = useUndoDelete();
  const { activeViewId, setActiveViewId } = useUI();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<FolderSortOrder>("manual");

  // Filter out folders pending undo deletion
  const visibleFolders = folders.filter((f) => !hiddenFolderIds.has(f.id));

  // If the active view points to a folder that no longer exists, fall back to inbox.
  const isFolderView = activeViewId !== "today" && activeViewId !== "inbox";
  if (isFolderView && !visibleFolders.some((f) => f.id === activeViewId)) {
    setActiveViewId("inbox");
  }

  const pageCountByFolder: Record<string, number> = {};
  for (const folder of visibleFolders) {
    pageCountByFolder[folder.id] = pages.filter(
      (p) => p.folderId === folder.id && p.status !== "done"
    ).length;
  }

  const today = localToday();
  const todayCount = pages.filter(
    (p) => p.scheduledStart && p.scheduledStart.slice(0, 10) <= today && p.status !== "done"
  ).length;

  const inboxCount = pages.filter((p) => p.folderId === null && p.status !== "done").length;

  // "manual" — use workspace array order as-is; reorderFolders keeps it correct via optimistic
  // update. Sorting by folder.sortOrder would revert the order since optimistic update doesn't
  // update the sortOrder field on each Folder object (only the DB write does).
  const sortedFolders =
    sortOrder === "manual"
      ? visibleFolders
      : [...visibleFolders].sort((a, b) => {
          if (sortOrder === "alphabetical") return a.name.localeCompare(b.name);
          // page-count
          const aCount = pages.filter((p) => p.folderId === a.id && p.status !== "done").length;
          const bCount = pages.filter((p) => p.folderId === b.id && p.status !== "done").length;
          return bCount - aCount;
        });

  async function handleCreateFolder() {
    const folder = await createFolder({ name: "New Folder" });
    setRenamingId(folder.id);
    setActiveViewId(folder.id);
  }

  function handleRenameCommit(id: string, name: string) {
    void updateFolder(id, { name });
    setRenamingId(null);
  }

  function handleDeleteRequest(folder: Folder) {
    const pageCount = pages.filter((p) => p.folderId === folder.id).length;
    if (activeViewId === folder.id) setActiveViewId("inbox");
    requestDeleteFolder(folder, pageCount);
  }

  function handleColorChange(id: string, color: string) {
    void updateFolder(id, { color });
  }

  return {
    activeViewId,
    folders: sortedFolders,
    handleColorChange,
    handleCreateFolder,
    handleDeleteRequest,
    handleRenameCommit,
    inboxCount,
    pageCountByFolder,
    renamingId,
    setActiveViewId,
    setRenamingId,
    setSortOrder,
    sortOrder,
    todayCount,
  };
}
