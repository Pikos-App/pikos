// useFolderWrites — folder CRUD and ordering. Folder writes touch the page list
// too (deleting a folder soft-deletes its pages, restoring one brings them
// back), which is why they take the page setter alongside the folder one rather
// than living behind a folders-only store.

import type { Folder, FolderUpdate, PageSummary, StorageAdapter } from "@pikos/core";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { OptimisticWrite } from "./usePageWriteQueue";

export interface FolderWrites {
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  deleteFolder: (id: string) => Promise<void>;
  /** In-place colour patch, no DB write — the colour is already persisted
   *  (external-calendar recolor writes via the sync adapter). Avoids a full
   *  workspace reload just to repaint one sidebar swatch. */
  patchFolderColor: (folderId: string, color: string) => void;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  restoreFolder: (id: string) => Promise<void>;
  softDeleteFolder: (id: string) => Promise<void>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
}

export function useFolderWrites({
  adapter,
  foldersRef,
  optimistic,
  setFolders,
  setPages,
}: {
  adapter: StorageAdapter;
  foldersRef: RefObject<Folder[]>;
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
}): FolderWrites {
  async function createFolder({ color, name }: { name: string; color?: string }) {
    const folder = await adapter.createFolder({
      name,
      ...(color !== undefined && { color }),
      parentId: null,
    });
    setFolders((prev) => [...prev, folder]);
    return folder;
  }

  async function updateFolder(id: string, updates: FolderUpdate) {
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    const updated = await adapter.updateFolder(id, updates);
    setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
  }

  function patchFolderColor(folderId: string, color: string) {
    setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, color } : f)));
  }

  async function deleteFolder(id: string) {
    await adapter.deleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    // Pages in the deleted folder are soft-deleted by the adapter
    setPages((prev) => prev.filter((p) => p.folderId !== id));
  }

  async function softDeleteFolder(id: string) {
    await adapter.softDeleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setPages((prev) => prev.filter((p) => p.folderId !== id));
  }

  async function restoreFolder(id: string) {
    await adapter.restoreFolder(id);
    const [loadedPages, loadedFolders] = await Promise.all([
      adapter.listPages({ status: "not_started" }),
      adapter.listFolders(),
    ]);
    setPages(loadedPages);
    setFolders(loadedFolders);
  }

  async function reorderFolders(orderedIds: string[]) {
    const snapshot = [...foldersRef.current];
    await optimistic({
      apply: () => {
        const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
        setFolders((prev) =>
          [...prev].sort((a, b) => {
            const ai = indexMap.get(a.id) ?? a.sortOrder;
            const bi = indexMap.get(b.id) ?? b.sortOrder;
            return ai - bi;
          })
        );
      },
      label: "reorderFolders",
      rollback: () => setFolders(snapshot),
      write: () => adapter.reorderFolders(orderedIds),
    });
  }

  return {
    createFolder,
    deleteFolder,
    patchFolderColor,
    reorderFolders,
    restoreFolder,
    softDeleteFolder,
    updateFolder,
  };
}
