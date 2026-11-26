// Creating, deleting, restoring and reordering pages, plus the bulk status write. Not here: the
// debounced field write (usePageWriteQueue), anything schedule-shaped (useScheduleWrites) and
// anything recurring (useRecurringWrites), which defer to a queue or a backend recompute in ways
// plain page CRUD does not.

import type {
  Folder,
  Page,
  PagePriority,
  PageStatus,
  PageSummary,
  StorageAdapter,
} from "@pikos/core";
import { folderIdForRestoredPage, toPageSummary } from "@pikos/core";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { WorkspaceEventBus } from "@/shared/events/workspaceEvents";

import type { OptimisticWrite } from "./usePageWriteQueue";

/** Lets a caller that knows tags, priority or body write them with the page rather than in a second
 *  write that lands after it is on screen. */
export interface NewPageFields {
  title?: string;
  folderId?: string | null;
  tags?: string[];
  priority?: PagePriority;
  content?: string;
}

export interface PageWrites {
  clearPendingDescription: (id: string) => Promise<void>;
  createPage: (opts: NewPageFields) => Promise<Page>;
  deletePage: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
  setPagesStatus: (ids: string[], status: PageStatus, completedAt: string | null) => Promise<void>;
  softDeletePage: (id: string) => Promise<void>;
}

export function usePageWrites({
  adapter,
  cancelPendingWrite,
  defaultFolderId,
  emit,
  foldersRef,
  optimistic,
  pagesRef,
  setPages,
}: {
  adapter: StorageAdapter;
  cancelPendingWrite: (id: string) => void;
  defaultFolderId: string | null;
  emit: WorkspaceEventBus["emit"];
  foldersRef: RefObject<Folder[]>;
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  pagesRef: RefObject<PageSummary[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
}): PageWrites {
  async function createPage({ content, folderId, priority, tags, title }: NewPageFields) {
    const page = await adapter.createPage({
      content: content ?? "",
      folderId: folderId ?? null,
      priority: priority ?? 0,
      status: "not_started",
      tags: tags ?? [],
      title: title ?? "",
    });
    setPages((prev) => [...prev, toPageSummary(page)]);
    emit("page:created", page);
    return page;
  }

  async function deletePage(id: string) {
    cancelPendingWrite(id);
    await adapter.deletePage(id);
    setPages((prev) => prev.filter((p) => p.id !== id));
    emit("page:deleted", id);
  }

  async function clearPendingDescription(id: string) {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, pendingDescription: null } : p)));
    await adapter.clearPendingDescription(id);
  }

  async function softDeletePage(id: string) {
    // `apply` runs synchronously, BEFORE the await: if the removal waited on the adapter, a fast Undo
    // could interleave and re-add the page while it's still present, duplicating it in the derived
    // lists.
    const snapshot = pagesRef.current.find((p) => p.id === id);
    await optimistic({
      apply: () => {
        cancelPendingWrite(id);
        setPages((prev) => prev.filter((p) => p.id !== id));
      },
      label: `softDeletePage(${id})`,
      notice: "deleting this page",
      rollback: () => {
        if (snapshot) {
          setPages((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, snapshot]));
        }
      },
      write: async () => {
        await adapter.softDeletePage(id);
        emit("page:deleted", id);
      },
    });
  }

  async function restorePage(id: string) {
    await adapter.restorePage(id);
    let page = await adapter.getPage(id);
    if (page) {
      // A page deleted with its folder remembers a folder that may no longer exist and would come
      // back pointing at nothing. Reparent before it reaches the store, so the list never holds a
      // page whose folder cannot be found.
      const home = folderIdForRestoredPage(page.folderId, foldersRef.current, defaultFolderId);
      if (home !== page.folderId) {
        await adapter.updatePage(id, { folderId: home });
        page = (await adapter.getPage(id)) ?? page;
      }
      const summary = toPageSummary(page);
      // Replace a copy still present (delete/undo race) rather than create a duplicate.
      setPages((prev) => [...prev.filter((p) => p.id !== id), summary]);
    }
  }

  async function reorderPages(folderId: string | null, orderedIds: string[]) {
    const snapshot = [...pagesRef.current];
    await optimistic({
      apply: () => {
        const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
        setPages((prev) =>
          prev.map((p) => {
            const newOrder = indexMap.get(p.id);
            return newOrder !== undefined ? { ...p, sortOrder: newOrder } : p;
          })
        );
      },
      label: "reorderPages",
      notice: "reordering pages",
      rollback: () => setPages(snapshot),
      write: () => adapter.reorderPages(folderId, orderedIds),
    });
  }

  async function setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const snapshot = pagesRef.current.filter((p) => idSet.has(p.id));

    await optimistic({
      apply: () =>
        setPages((prev) => prev.map((p) => (idSet.has(p.id) ? { ...p, completedAt, status } : p))),
      errorIds: ids,
      label: `setPagesStatus for ${ids.length} pages`,
      notice: "updating status",
      rollback: () => {
        const byId = new Map(snapshot.map((p) => [p.id, p]));
        setPages((prev) => prev.map((p) => byId.get(p.id) ?? p));
      },
      write: async () => {
        const updated = await adapter.setPagesStatus(ids, status, completedAt);
        // Reconcile from the DB truth for rows that changed; soft-deleted ids are absent from `updated`.
        const byId = new Map(updated.map((p) => [p.id, p]));
        setPages((prev) => prev.map((p) => byId.get(p.id) ?? p));
      },
    });
  }

  return {
    clearPendingDescription,
    createPage,
    deletePage,
    reorderPages,
    restorePage,
    setPagesStatus,
    softDeletePage,
  };
}
