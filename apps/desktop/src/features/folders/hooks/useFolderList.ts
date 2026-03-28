import type { Folder } from "@pikos/core";
import { localToday } from "@pikos/core";
import { useState } from "react";

import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

interface PendingDelete {
  folder: Folder;
  pageCount: number;
}

export type FolderSortOrder = "manual" | "alphabetical" | "page-count";

export interface FolderListState {
  folders: Folder[];
  pageCountByFolder: Record<string, number>;
  activeViewId: string;
  setActiveViewId: (id: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  pendingDelete: PendingDelete | null;
  todayCount: number;
  inboxCount: number;
  sortOrder: FolderSortOrder;
  setSortOrder: (order: FolderSortOrder) => void;
  handleCreateFolder: () => Promise<void>;
  handleRenameCommit: (id: string, name: string) => void;
  handleDeleteRequest: (folder: Folder) => void;
  handleDeleteConfirm: () => void;
  handleDeleteCancel: () => void;
  handleColorChange: (id: string, color: string) => void;
}

export function useFolderList(): FolderListState {
  const { createFolder, deleteFolder, folders, pages, updateFolder } = useWorkspace();
  const { activeViewId, setActiveViewId } = useUI();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [sortOrder, setSortOrder] = useState<FolderSortOrder>("manual");

  const pageCountByFolder: Record<string, number> = {};
  for (const folder of folders) {
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
      ? folders
      : [...folders].sort((a, b) => {
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
    if (pageCount === 0) {
      void deleteFolder(folder.id);
      if (activeViewId === folder.id) setActiveViewId("inbox");
    } else {
      setPendingDelete({ folder, pageCount });
    }
  }

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    void deleteFolder(pendingDelete.folder.id);
    if (activeViewId === pendingDelete.folder.id) setActiveViewId("inbox");
    setPendingDelete(null);
  }

  function handleDeleteCancel() {
    setPendingDelete(null);
  }

  function handleColorChange(id: string, color: string) {
    void updateFolder(id, { color });
  }

  return {
    activeViewId,
    folders: sortedFolders,
    handleColorChange,
    handleCreateFolder,
    handleDeleteCancel,
    handleDeleteConfirm,
    handleDeleteRequest,
    handleRenameCommit,
    inboxCount,
    pageCountByFolder,
    pendingDelete,
    renamingId,
    setActiveViewId,
    setRenamingId,
    setSortOrder,
    sortOrder,
    todayCount,
  };
}
