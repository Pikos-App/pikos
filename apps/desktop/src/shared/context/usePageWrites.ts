// usePageWrites — creating, deleting, restoring and reordering pages, plus the
// bulk status write. What is NOT here: the debounced field write (updatePage /
// flushPage, in usePageWriteQueue), anything schedule-shaped (useScheduleWrites)
// and anything recurring (useRecurringWrites) — those defer to a queue or to a
// backend recompute in ways plain page CRUD does not.

import type { Page, PageStatus, PageSummary, StorageAdapter } from "@pikos/core";
import { toPageSummary } from "@pikos/core";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { WorkspaceEventBus } from "@/shared/events/workspaceEvents";

import type { OptimisticWrite } from "./usePageWriteQueue";

export interface PageWrites {
  /** Resolve the "calendar description changed" notice — see the adapter method. */
  clearPendingDescription: (id: string) => Promise<void>;
  createPage: (opts: { title?: string; folderId?: string | null }) => Promise<Page>;
  /** Hard delete. Soft-delete (recoverable) is softDeletePage. */
  deletePage: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
  setPagesStatus: (ids: string[], status: PageStatus, completedAt: string | null) => Promise<void>;
  softDeletePage: (id: string) => Promise<void>;
}

export function usePageWrites({
  adapter,
  cancelPendingWrite,
  emit,
  optimistic,
  pagesRef,
  setPages,
}: {
  adapter: StorageAdapter;
  cancelPendingWrite: (id: string) => void;
  emit: WorkspaceEventBus["emit"];
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  pagesRef: RefObject<PageSummary[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
}): PageWrites {
  async function createPage({ folderId, title }: { title?: string; folderId?: string | null }) {
    const page = await adapter.createPage({
      content: "",
      contentText: "",
      folderId: folderId ?? null,
      priority: 0,
      status: "not_started",
      tags: [],
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
    // `apply` runs synchronously, BEFORE the await. If the removal waited on the
    // adapter, a fast Undo (restorePage) could interleave with the pending await
    // and re-add the page while it's still present — duplicating it in the
    // derived active/completed lists (and confusing the virtualizer).
    const snapshot = pagesRef.current.find((p) => p.id === id);
    await optimistic({
      apply: () => {
        cancelPendingWrite(id);
        setPages((prev) => prev.filter((p) => p.id !== id));
      },
      label: `softDeletePage(${id})`,
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
    const page = await adapter.getPage(id);
    if (page) {
      const summary = toPageSummary(page);
      // Dedupe: never blind-append. If a copy is somehow still present
      // (delete/undo race), replace it rather than create a duplicate.
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
      rollback: () => {
        const byId = new Map(snapshot.map((p) => [p.id, p]));
        setPages((prev) => prev.map((p) => byId.get(p.id) ?? p));
      },
      write: async () => {
        const updated = await adapter.setPagesStatus(ids, status, completedAt);
        // Reconcile from the DB truth (e.g. updatedAt) for the rows that actually
        // changed; soft-deleted ids are absent from `updated` and left as-is.
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
