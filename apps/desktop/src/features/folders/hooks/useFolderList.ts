import type { Folder } from "@pikos/core";
import { emojiAwareCompare, isOpen, localToday } from "@pikos/core";
import { useState } from "react";

import { belongsToView } from "@/features/pages";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

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
  const { createFolder, folders, pages, updateFolder } = usePages();
  const { hiddenFolderIds, requestDeleteFolder } = useUndoDelete();
  const { activeViewId, setActiveViewId } = useUI();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<FolderSortOrder>("manual");

  const visibleFolders = folders.filter((f) => !hiddenFolderIds.has(f.id));

  // If the active view points to a folder that no longer exists, fall back to inbox.
  const isFolderView = activeViewId !== "today" && activeViewId !== "inbox";
  if (isFolderView && !visibleFolders.some((f) => f.id === activeViewId)) {
    setActiveViewId("inbox");
  }

  const today = localToday();
  const openPages = pages.filter(isOpen);

  const pageCountByFolder: Record<string, number> = {};
  for (const folder of visibleFolders) {
    pageCountByFolder[folder.id] = openPages.filter((p) => p.folderId === folder.id).length;
  }

  const todayCount = openPages.filter((p) => belongsToView(p, "today", today)).length;
  const inboxCount = openPages.filter((p) => belongsToView(p, "inbox", today)).length;

  // "manual" — use workspace array order as-is; reorderFolders keeps it correct via optimistic
  // update. Sorting by folder.sortOrder would revert the order since optimistic update doesn't
  // update the sortOrder field on each Folder object (only the DB write does).
  const sortedFolders =
    sortOrder === "manual"
      ? visibleFolders
      : [...visibleFolders].sort((a, b) => {
          if (sortOrder === "alphabetical") return emojiAwareCompare(a.name, b.name);
          return (pageCountByFolder[b.id] ?? 0) - (pageCountByFolder[a.id] ?? 0);
        });

  async function handleCreateFolder() {
    const folder = await createFolder({ name: "" });
    setRenamingId(folder.id);
    setActiveViewId(folder.id);
  }

  function handleRenameCommit(id: string, name: string) {
    void updateFolder(id, { name: name || "Untitled" });
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
