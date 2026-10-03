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
import { storageErrorUserMessage, toPageSummary, toStorageError } from "@pikos/core";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import { postNotice } from "@/shared/events/noticeBus";
import type { WorkspaceEventBus } from "@/shared/events/workspaceEvents";
import { createLogger } from "@/shared/logger";
import { onDrainPending } from "@/shared/pendingWrites";
import type { WriteMirror } from "@/shared/viewCache/writeMirror";

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
  /** What the user was doing, in their words, for the toast a failure raises —
   *  "reordering pages", "moving a page to a folder". Reads as "Storage error
   *  while <notice>." A generic save message stands in when it is omitted.
   *
   *  Supplying this is what makes the queue report, and `rethrow` no longer
   *  decides it. A fire-and-forget write is reported from here whether or not it
   *  names an action; a write that also rethrows is reported from here only when
   *  it names one, so a caller raising its own message leaves this out and does
   *  not toast the same failure twice. Keying it to `rethrow` alone was wrong:
   *  `scheduleOnce` and `clearSchedule` rethrow for the one caller that undoes a
   *  half-finished create, while ten others call them fire-and-forget, and those
   *  ten went silent. Before any of it the only surface was `pageErrors`, which
   *  the editor reads for the one page it has open, so a status ticked from a
   *  list, the calendar or a search result rolled back in silence. With no
   *  telemetry, a failure nobody is shown is a failure nobody can report. */
  notice?: string;
  /** Serialise the write on this page's queue. Omit for writes that aren't
   *  scoped to one page (bulk status, folder reorder). */
  queueOn?: string;
  /** Re-throw after rolling back — for callers that await and branch on failure. */
  rethrow?: boolean;
  /** Edits made before this write, by the debounce, that it carries to the database. */
  carries?: number[];
  /** Hold the carried edits on screen if the write fails: typing the editor still shows. */
  keepOnFailure?: boolean;
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
  mirror,
  pagesRef,
  setPages,
}: {
  adapter: StorageAdapter;
  emit: WorkspaceEventBus["emit"];
  mirror: WriteMirror | null;
  pagesRef: RefObject<PageSummary[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
}): PageWriteQueue {
  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const snapshotsRef = useRef<Map<string, PageSummary>>(new Map());
  const mutationQueues = useRef<Map<string, Promise<unknown>>>(new Map());
  const [pageErrors, setPageErrors] = useState<Map<string, StorageError>>(new Map());
  /** Each page's debounced edits, as the mirror recorded them, for the write that carries them. */
  const debouncedWrites = useRef<Map<string, number[]>>(new Map());

  function enqueue<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    // A patch still in its debounce was made first, so it is written first. Left
    // to its timer it landed after this write and put back what this one replaced:
    // a head moved within 800ms of its quick add snapped back to its old date.
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
    const writes = [...carries, ...(mirror ? mirror.capture(apply) : (apply(), []))];
    async function run(): Promise<T | undefined> {
      try {
        const result = await write();
        void mirror?.confirm(writes);
        return result;
      } catch (err: unknown) {
        log.error(`${label} failed; rolling back`, err);
        mirror?.fail(writes, keepOnFailure);
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
    takePendingPatch(id);
    // Never written, so its edits mustn't stay on screen.
    mirror?.fail(debouncedWrites.current.get(id) ?? []);
    debouncedWrites.current.delete(id);
  }

  /** The write both the debounce timer and flushPage land in. The optimistic
   *  patch is already on screen by the time this runs — only the DB write and
   *  its rollback happen here. `adoptEcho` false is for a patch committed ahead
   *  of another write: its echo predates that write, and adopting it would put
   *  back on screen what the later write's optimistic patch replaced. */
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
      rollback: () => {
        const snapshot = snapshotsRef.current.get(id);
        snapshotsRef.current.delete(id);
        if (snapshot) setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
      },
      write: async () => {
        const updated = await adapter.updatePage(id, patch);
        snapshotsRef.current.delete(id);
        if (adoptEcho) {
          const summary = toPageSummary(updated);
          if (mirror) mirror.confirmRow(summary);
          else setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
        }
        emit("page:updated", updated);
      },
    }).then(() => undefined);
  }

  function updatePage(id: string, patch: PageUpdate): void {
    // With the view cache the store holds the edit as a pending write, so no snapshot is taken
    // and no list rebuilt: a rename sends every keystroke through here.
    if (!mirror) snapshotPage(id);
    const edits = mirror
      ? mirror.capture(() => mirror.patch(id, patch))
      : (setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);
    debouncedWrites.current.set(id, [...(debouncedWrites.current.get(id) ?? []), ...edits]);

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

  /** Take a page's debounced patch off its timer, or undefined when none waits. */
  function takePendingPatch(id: string): PageUpdate | undefined {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    const accumulated = pendingPatches.current.get(id);
    pendingPatches.current.delete(id);
    return accumulated;
  }

  /** Queue a waiting patch now, reporting a failure the way its timer would have. */
  function commitPendingPatch(id: string): void {
    const accumulated = takePendingPatch(id);
    if (accumulated) void commitPatch(id, accumulated, false, false);
  }

  async function flushPage(id: string): Promise<void> {
    const accumulated = takePendingPatch(id);
    if (!accumulated) return;
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
        await drainAll();
        await win.destroy();
      });
    }

    void register();
    return () => {
      unlisten?.();
    };
  }, [adapter]);

  // An update relaunch restarts the process without closing the window, so the
  // handler above never sees it. Registering here means the updater does not
  // have to know what a write queue is.
  useEffect(() => onDrainPending(drainAll), [adapter]);

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
