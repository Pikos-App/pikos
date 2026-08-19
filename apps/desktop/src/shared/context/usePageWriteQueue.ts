// usePageWriteQueue — the write half of PagesContext: the per-page mutation
// queue, the 800ms debounce that batches editor typing into one DB write, the
// snapshots those writes roll back to, and the `pageErrors` map the UI reads
// when one fails.
//
// It also owns the ONE optimistic-write shape every mutation in the context
// uses — patch state now, write, and on failure put the state back and surface
// the error where the UI can see it. Before this module that shape was written
// out by hand at every call site, which is how the same rollback could be
// subtly wrong in three of them at once.

import type { PageSummary, PageUpdate, StorageAdapter, StorageError } from "@pikos/core";
import { toPageSummary, toStorageError } from "@pikos/core";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import type { WorkspaceEventBus } from "@/shared/events/workspaceEvents";
import { createLogger } from "@/shared/logger";

const log = createLogger("PageWriteQueue");

/** Editor typing coalesces into one DB write this long after the last keystroke. */
const WRITE_DEBOUNCE_MS = 800;

/** One optimistic mutation: what it displaces, what it writes, how it undoes. */
export interface OptimisticWrite<T> {
  /** The optimistic patch. Runs synchronously, before the write is even queued —
   *  a mutation that waits for the adapter to remove a row can be raced by an
   *  undo that re-adds it. */
  apply: () => void;
  /** Pages that carry the StorageError when the write fails. Omit for mutations
   *  with no per-page error surface (reorders, folder writes). */
  errorIds?: string[];
  /** Short, app-controlled prefix for the rollback log line. */
  label: string;
  /** Serialise the write on this page's queue. Omit for writes that aren't
   *  scoped to one page (bulk status, folder reorder). */
  queueOn?: string;
  /** Re-throw after rolling back — for callers that await and branch on failure. */
  rethrow?: boolean;
  /** Puts back exactly what `apply` displaced. */
  rollback: () => void;
  write: () => Promise<T>;
}

export interface PageWriteQueue {
  /** Forget a page's queued debounce + pending patch — a delete must not be
   *  followed by a write that resurrects the row. */
  cancelPendingWrite: (id: string) => void;
  clearPageError: (id: string) => void;
  /** Serialise a write behind this page's in-flight ones, so a debounced patch
   *  and a concurrent schedule write can never interleave or clobber. */
  enqueue: <T>(pageId: string, fn: () => Promise<T>) => Promise<T>;
  /** Write out a page's pending patch now, ahead of the debounce. Rejects on a
   *  failed write (after rolling back), unlike the debounced path. */
  flushPage: (id: string) => Promise<void>;
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  pageErrors: Map<string, StorageError>;
  /** Optimistic patch now, one coalesced DB write ~800ms after the last call.
   *  Status changes bypass the debounce (see below). */
  updatePage: (id: string, patch: PageUpdate) => void;
}

export function usePageWriteQueue({
  adapter,
  emit,
  pagesRef,
  setPages,
}: {
  adapter: StorageAdapter;
  emit: WorkspaceEventBus["emit"];
  pagesRef: RefObject<PageSummary[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
}): PageWriteQueue {
  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const snapshotsRef = useRef<Map<string, PageSummary>>(new Map());
  const mutationQueues = useRef<Map<string, Promise<unknown>>>(new Map());
  const [pageErrors, setPageErrors] = useState<Map<string, StorageError>>(new Map());

  function enqueue<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mutationQueues.current.get(pageId) ?? Promise.resolve();
    // Pass fn as both fulfilment and rejection handler so the queue never stalls
    // on a previous error.
    const next = prev.then(fn, fn);
    mutationQueues.current.set(pageId, next);
    return next;
  }

  function clearPageError(id: string): void {
    setPageErrors((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function recordPageErrors(ids: string[], err: StorageError): void {
    setPageErrors((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, err);
      return next;
    });
  }

  function optimistic<T>({
    apply,
    errorIds,
    label,
    queueOn,
    rethrow,
    rollback,
    write,
  }: OptimisticWrite<T>): Promise<T | undefined> {
    apply();
    async function run(): Promise<T | undefined> {
      try {
        return await write();
      } catch (err: unknown) {
        log.error(`${label} failed; rolling back`, err);
        rollback();
        if (errorIds && errorIds.length > 0) recordPageErrors(errorIds, toStorageError(err));
        if (rethrow) throw err;
        return undefined;
      }
    }
    return queueOn === undefined ? run() : enqueue(queueOn, run);
  }

  /** Capture a page's current state as the rollback target for the patch about
   *  to be applied to it. Only the FIRST capture in a debounce window sticks —
   *  a rollback has to reach the last state the DB agreed with, not the last
   *  optimistic one. */
  function snapshotPage(id: string): void {
    if (pendingPatches.current.has(id)) return;
    const current = pagesRef.current.find((p) => p.id === id);
    if (current) snapshotsRef.current.set(id, current);
  }

  function cancelPendingWrite(id: string): void {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    pendingPatches.current.delete(id);
  }

  /** The write both the debounce timer and flushPage land in. The optimistic
   *  patch is already on screen by the time this runs — only the DB write and
   *  its rollback happen here. */
  function commitPatch(id: string, patch: PageUpdate, rethrow: boolean): Promise<void> {
    return optimistic({
      apply: () => {},
      errorIds: [id],
      label: `page write for ${id}`,
      queueOn: id,
      rethrow,
      rollback: () => {
        const snapshot = snapshotsRef.current.get(id);
        snapshotsRef.current.delete(id);
        if (snapshot) setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
      },
      write: async () => {
        const updated = await adapter.updatePage(id, patch);
        snapshotsRef.current.delete(id);
        const summary = toPageSummary(updated);
        setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
        emit("page:updated", updated);
      },
    }).then(() => undefined);
  }

  function updatePage(id: string, patch: PageUpdate): void {
    snapshotPage(id);

    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

    const existing = pendingPatches.current.get(id) ?? {};
    pendingPatches.current.set(id, { ...existing, ...patch });

    const prevTimer = debounceTimers.current.get(id);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    // Status changes gate the native notification scheduler, which reads
    // pages.status directly from SQLite. Flushing them immediately — instead of
    // after the debounce — closes a race where a reminder could fire for a page
    // the user just marked done. Status toggles are deliberate and
    // low-frequency, so the immediate write has no perceptible cost. flushPage
    // records any DB error in pageErrors, so the rethrow is safe to swallow.
    if ("status" in patch) {
      void flushPage(id).catch(() => {});
      return;
    }

    const timer = setTimeout(() => {
      const accumulated = pendingPatches.current.get(id);
      if (!accumulated) return;
      pendingPatches.current.delete(id);
      debounceTimers.current.delete(id);
      void commitPatch(id, accumulated, false);
    }, WRITE_DEBOUNCE_MS);

    debounceTimers.current.set(id, timer);
  }

  async function flushPage(id: string): Promise<void> {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);

    const accumulated = pendingPatches.current.get(id);
    if (!accumulated) return;
    pendingPatches.current.delete(id);

    return commitPatch(id, accumulated, true);
  }

  // ─── Flush on window close ────────────────────────────────────────────────
  // Tauri's Rust side calls prevent_close() so we get a chance here to flush
  // any debounced writes, wait for all in-flight mutations, then destroy.

  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    let unlisten: (() => void) | undefined;

    async function register() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();

        for (const id of Array.from(pendingPatches.current.keys())) {
          const timer = debounceTimers.current.get(id);
          if (timer !== undefined) clearTimeout(timer);
          debounceTimers.current.delete(id);
          const accumulated = pendingPatches.current.get(id);
          if (!accumulated) continue;
          pendingPatches.current.delete(id);
          // Inline enqueue: best-effort write, swallow errors since we're closing
          const prev = mutationQueues.current.get(id) ?? Promise.resolve();
          const next = prev
            .then(() => adapter.updatePage(id, accumulated))
            .then(
              () => undefined,
              () => undefined
            );
          mutationQueues.current.set(id, next);
        }

        await Promise.allSettled(Array.from(mutationQueues.current.values()));
        await win.destroy();
      });
    }

    void register();
    return () => {
      unlisten?.();
    };
  }, [adapter]);

  return {
    cancelPendingWrite,
    clearPageError,
    enqueue,
    flushPage,
    optimistic,
    pageErrors,
    updatePage,
  };
}
