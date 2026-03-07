import { useCallback, useMemo, useState } from "react";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useUI } from "@/shared/context/UIContext";
import type { Folder } from "@pikos/core";

interface PendingDelete {
  folder: Folder;
  pageCount: number;
}

export interface FolderListState {
  folders: Folder[];
  activeViewId: string;
  setActiveViewId: (id: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  pendingDelete: PendingDelete | null;
  todayCount: number;
  inboxCount: number;
  handleCreateFolder: () => Promise<void>;
  handleRenameCommit: (id: string, name: string) => void;
  handleDeleteRequest: (folder: Folder) => void;
  handleDeleteConfirm: () => void;
  handleDeleteCancel: () => void;
  handleColorChange: (id: string, color: string) => void;
}

export function useFolderList(): FolderListState {
  const { folders, pages, createFolder, updateFolder, deleteFolder } = useWorkspace();
  const { activeViewId, setActiveViewId } = useUI();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const todayCount = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return pages.filter(
      (p) => p.scheduledStart && p.scheduledStart.slice(0, 10) <= today && p.status !== "done"
    ).length;
  }, [pages]);

  const inboxCount = useMemo(() => pages.filter((p) => p.folderId === null).length, [pages]);

  const handleCreateFolder = useCallback(async () => {
    const folder = await createFolder({ name: "New Folder" });
    setRenamingId(folder.id);
    setActiveViewId(folder.id);
  }, [createFolder, setActiveViewId]);

  const handleRenameCommit = useCallback(
    (id: string, name: string) => {
      void updateFolder(id, { name });
      setRenamingId(null);
    },
    [updateFolder]
  );

  const handleDeleteRequest = useCallback(
    (folder: Folder) => {
      const pageCount = pages.filter((p) => p.folderId === folder.id).length;
      if (pageCount === 0) {
        void deleteFolder(folder.id);
        if (activeViewId === folder.id) setActiveViewId("inbox");
      } else {
        setPendingDelete({ folder, pageCount });
      }
    },
    [pages, deleteFolder, activeViewId, setActiveViewId]
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!pendingDelete) return;
    void deleteFolder(pendingDelete.folder.id);
    if (activeViewId === pendingDelete.folder.id) setActiveViewId("inbox");
    setPendingDelete(null);
  }, [pendingDelete, deleteFolder, activeViewId, setActiveViewId]);

  const handleDeleteCancel = useCallback(() => setPendingDelete(null), []);

  const handleColorChange = useCallback(
    (id: string, color: string) => {
      void updateFolder(id, { color });
    },
    [updateFolder]
  );

  return {
    folders,
    activeViewId,
    setActiveViewId,
    renamingId,
    setRenamingId,
    pendingDelete,
    todayCount,
    inboxCount,
    handleCreateFolder,
    handleRenameCommit,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleColorChange,
  };
}
