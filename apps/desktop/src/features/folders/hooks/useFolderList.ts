import { useCallback, useState } from "react";
import { type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
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
  handleCreateFolder: () => Promise<void>;
  handleDragEnd: (event: DragEndEvent) => void;
  handleRenameCommit: (id: string, name: string) => void;
  handleDeleteRequest: (folder: Folder) => void;
  handleDeleteConfirm: () => void;
  handleDeleteCancel: () => void;
  handleColorChange: (id: string, color: string) => void;
}

export function useFolderList(): FolderListState {
  const { folders, pages, createFolder, updateFolder, deleteFolder, reorderFolders } =
    useWorkspace();
  const { activeViewId, setActiveViewId } = useUI();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const handleCreateFolder = useCallback(async () => {
    const folder = await createFolder({ name: "New Folder" });
    setRenamingId(folder.id);
    setActiveViewId(folder.id);
  }, [createFolder, setActiveViewId]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIdx = folders.findIndex((f) => f.id === active.id);
      const newIdx = folders.findIndex((f) => f.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      void reorderFolders(arrayMove(folders, oldIdx, newIdx).map((f) => f.id));
    },
    [folders, reorderFolders]
  );

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
    handleCreateFolder,
    handleDragEnd,
    handleRenameCommit,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleColorChange,
  };
}
