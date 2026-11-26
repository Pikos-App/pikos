// The write half of PagesContext: the per-page mutation queue, the debounce that batches editor
// typing into one DB write, and the `pageErrors` map the UI reads when one fails. Every edit is a
// pending write on the view cache's store until its write lands or fails. Also owns the one
// optimistic-write shape every mutation uses: patch state now, write, and on failure restore the
// state and surface the error.

import type { PageUpdate, StorageAdapter, StorageError } from "@pikos/core";
import { storageErrorUserMessage, toPageSummary, toStorageError } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { postNotice } from "@/shared/events/noticeBus";
import type { WorkspaceEventBus } from "@/shared/events/workspaceEvents";
import { createLogger } from "@/shared/logger";
import { flushPendingWrites, onDrainPending } from "@/shared/pendingWrites";
import type { WriteMirror } from "@/shared/viewCache/writeMirror";

const log = createLogger("PageWriteQueue");

const WRITE_DEBOUNCE_MS = 800;

export interface OptimisticWrite<T> {
  /** Runs synchronously, before the write is queued: a mutation that waits for the adapter to remove
   *  a row can be raced by an undo that re-adds it. */
  apply: () => void;
  /** Pages that carry the StorageError when the write fails. */
  errorIds?: string[];
  label: string;
  /** What the user was doing, in their words, for the failure toast: "reordering pages". A generic
   *  save message stands in when omitted.
   *
   *  Supplying this is what makes the queue report. A write that also rethrows is reported from here
   *  only when it names one, so a caller raising its own message leaves this out and doesn't toast
   *  twice. Keying it to `rethrow` alone would silence the fire-and-forget callers of `scheduleOnce`
   *  and `clearSchedule`. `pageErrors` alone isn't enough: the editor reads it for its one open page,
   *  so a status ticked from a list, the calendar or a search result would roll back in silence. */
  notice?: string;
  queueOn?: string;
  rethrow?: boolean;
  carries?: number[];
  keepOnFailure?: boolean;
  rollback: () => void;
  write: () => Promise<T>;
}

export interface PageWriteQueue {
  /** Forget a page's queued debounce and pending patch: a delete must not be followed by a write
   *  that resurrects the row. */
  cancelPendingWrite: (id: string) => void;
  clearPageError: (id: string) => void;
  /** Serialise a write behind this page's in-flight ones, so a debounced patch
   *  and a concurrent schedule write can never interleave or clobber. */
  enqueue: <T>(pageId: string, fn: () => Promise<T>) => Promise<T>;
  /** Write out a page's pending patch now. Rejects on a failed write (after rolling back), unlike
   *  the debounced path. */
  flushPage: (id: string) => Promise<void>;
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  pageErrors: Map<string, StorageError>;
  /** Optimistic patch now, one coalesced DB write after the last call. Status changes bypass the debounce. */
  updatePage: (id: string, patch: PageUpdate) => void;
}

export function usePageWriteQueue({
  adapter,
  emit,
  mirror,
}: {
  adapter: StorageAdapter;
  emit: WorkspaceEventBus["emit"];
  mirror: WriteMirror;
}): PageWriteQueue {
  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mutationQueues = useRef<Map<string, Promise<unknown>>>(new Map());
  const [pageErrors, setPageErrors] = useState<Map<string, StorageError>>(new Map());
  const debouncedWrites = useRef<Map<string, number[]>>(new Map());

  function enqueue<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    // A patch still in its debounce was made first, so it is written first. Left to its timer it
    // would land after this write and put back what this one replaced: a head moved within 800ms of
    // its quick add would snap back to its old date.
    commitPendingPatch(pageId);
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
    carries = [],
    errorIds,
    keepOnFailure,
    label,
    notice,
    queueOn,
    rethrow,
    rollback,
    write,
  }: OptimisticWrite<T>): Promise<T | undefined> {
    const writes = [...carries, ...mirror.capture(apply)];
    async function run(): Promise<T | undefined> {
      try {
        const result = await write();
        void mirror.confirm(writes);
        return result;
      } catch (err: unknown) {
        log.error(`${label} failed; rolling back`, err);
        mirror.fail(writes, keepOnFailure);
        rollback();
        const storageError = toStorageError(err);
        if (errorIds && errorIds.length > 0) recordPageErrors(errorIds, storageError);
        if (notice !== undefined || !rethrow) {
          postNotice(storageErrorUserMessage(storageError, notice ?? "saving your changes"));
        }
        if (rethrow) throw err;
        return undefined;
      }
    }
    return queueOn === undefined ? run() : enqueue(queueOn, run);
  }

  function cancelPendingWrite(id: string): void {
    takePendingPatch(id);
    mirror.fail(debouncedWrites.current.get(id) ?? []);
    debouncedWrites.current.delete(id);
  }

  /** The write both the debounce timer and flushPage land in. `adoptEcho` false is for a patch
   *  committed ahead of another write: its echo predates that write, and adopting it would put back
   *  what the later write's optimistic patch replaced. */
  function commitPatch(
    id: string,
    patch: PageUpdate,
    rethrow: boolean,
    adoptEcho = true
  ): Promise<void> {
    const carries = debouncedWrites.current.get(id) ?? [];
    debouncedWrites.current.delete(id);
    return optimistic({
      apply: () => {},
      carries,
      errorIds: [id],
      keepOnFailure: "content" in patch,
      label: `page write for ${id}`,
      queueOn: id,
      rethrow,
      rollback: () => {},
      write: async () => {
        const updated = await adapter.updatePage(id, patch);
        if (adoptEcho) {
          const summary = toPageSummary(updated);
          mirror.confirmRow(summary);
        }
        emit("page:updated", updated);

        const typed = patch.content;
        const isMerged = patch.baseContent != null && typed != null && updated.content !== typed;
        if (isMerged) emit("page:merged", { page: updated, typed });
      },
    }).then(() => undefined);
  }

  function updatePage(id: string, patch: PageUpdate): void {
    // The store holds the edit as a pending write, so no list is rebuilt: a rename sends every
    // keystroke through here.
    const edits = mirror.capture(() => mirror.patch(id, patch));
    debouncedWrites.current.set(id, [...(debouncedWrites.current.get(id) ?? []), ...edits]);

    const existing = pendingPatches.current.get(id) ?? {};
    // Typing that coalesces with a body still waiting was typed over that body's base, the one
    // stored; its own base is the waiting body, which never was.
    const isBodyWaiting = existing.content !== undefined;
    const coalesced = isBodyWaiting
      ? { ...existing, ...patch, baseContent: existing.baseContent ?? null }
      : { ...existing, ...patch };
    pendingPatches.current.set(id, coalesced);

    const prevTimer = debounceTimers.current.get(id);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    // Status changes gate the native notification scheduler, which reads pages.status from
    // SQLite. Flushing them immediately closes a race where a reminder fires for a page just marked
    // done, and status toggles are infrequent enough that it costs nothing. flushPage records any DB
    // error in pageErrors, so the rethrow is safe to swallow.
    if ("status" in patch) {
      // flushPage rethrows, so nothing downstream of it reports. This is the one
      // place that awaits it and has no caller to hand the failure to: the tick
      // came from a list row, a calendar block or a search result, none of which
      // show the editor's inline indicator.
      void flushPage(id).catch((err: unknown) => {
        postNotice(storageErrorUserMessage(toStorageError(err), "updating status"));
      });
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

  function takePendingPatch(id: string): PageUpdate | undefined {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    const accumulated = pendingPatches.current.get(id);
    pendingPatches.current.delete(id);
    return accumulated;
  }

  function commitPendingPatch(id: string): void {
    const accumulated = takePendingPatch(id);
    if (accumulated) void commitPatch(id, accumulated, false, false);
  }

  /** With nothing waiting, still settles once the writes already in flight have: a write queued
   *  ahead of the flush (a recurrence enqueued on Enter) takes the debounced patch with it, and a
   *  read that followed a bare return would see the page as it was before that patch. */
  async function flushPage(id: string): Promise<void> {
    const accumulated = takePendingPatch(id);
    if (!accumulated) {
      await mutationQueues.current.get(id)?.catch(() => undefined);
      return;
    }
    return commitPatch(id, accumulated, true);
  }

  /** Write out every pending patch and wait for all in-flight mutations.
   *  Best-effort by design: the callers are on their way out of the process, so a
   *  write that fails has nowhere to report to and must not stop the others. */
  async function drainAll(): Promise<void> {
    for (const id of Array.from(pendingPatches.current.keys())) {
      const timer = debounceTimers.current.get(id);
      if (timer !== undefined) clearTimeout(timer);
      debounceTimers.current.delete(id);
      const accumulated = pendingPatches.current.get(id);
      if (!accumulated) continue;
      pendingPatches.current.delete(id);
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
  }

  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    let unlisten: (() => void) | undefined;

    async function register() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        await flushPendingWrites();
        await win.destroy();
      });
    }

    void register();
    return () => {
      unlisten?.();
    };
  }, [adapter]);

  // The close above and an update relaunch both reach the queue through this, after
  // the editor has fed it, so neither has to know what a write queue is.
  useEffect(() => {
    const stopDraining = onDrainPending(drainAll);
    return () => {
      stopDraining();
      // Waiting edits are written as the queue goes, to the workspace they were made in. A timer
      // left running would write later, after a switch, and report into state that is gone.
      void drainAll();
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
