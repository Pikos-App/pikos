// PagesContext — owns all data state and CRUD: pages, folders, tags,
// recurrenceRules, plus debounced writes and per-page mutation queue.
// Workspace lifecycle (init, reload, resetAndSeed) lives in WorkspaceContext;
// PagesProvider registers a data-loader so Workspace can dispatch reloads.
// Import batch flow lives in ImportContext.

import type {
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompleteRecurringResult,
  Folder,
  Page,
  PageRecurrenceRule,
  PageStatus,
  PageSummary,
  SearchResponse,
  StorageError,
  Tag,
} from "@pikos/core";
import {
  anchorMoveUpdate,
  applyAnchorMove,
  deriveTags,
  getLocalTimezone,
  resolveAnchorMove,
  toPageSummary,
} from "@pikos/core";
import type {
  FolderUpdate,
  NewRecurrenceRule,
  PageUpdate,
  RecurrenceRuleUpdate,
} from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { usePageWriteQueue } from "./usePageWriteQueue";
import { type GapRunOptions, useRecurringWrites } from "./useRecurringWrites";
import { useWorkspaceInternal } from "./WorkspaceContext";

export type { GapRunOptions };

export interface PagesContextValue {
  /** Lightweight summaries (no content) — use getPage() to load full content. */
  pages: PageSummary[];
  folders: Folder[];
  /** Derived reactively from pages[].tags — never stored separately. */
  tags: Tag[];
  /** All recurrence rules (one per recurring page). */
  recurrenceRules: PageRecurrenceRule[];
  /** Load full page with content — use when opening the editor. */
  getPage: (id: string) => Promise<Page | null>;
  createPage: (opts: { title?: string; folderId?: string | null }) => Promise<Page>;
  /** Debounced 800ms — optimistic update applied immediately; DB write batched. */
  updatePage: (id: string, patch: PageUpdate) => void;
  flushPage: (id: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  /** Resolve the "calendar description changed" notice — see the adapter method. */
  clearPendingDescription: (id: string) => Promise<void>;
  /** Soft-delete: sets deleted_at. Page is hidden everywhere but recoverable via restorePage. */
  softDeletePage: (id: string) => Promise<void>;
  /** Restore a soft-deleted page — clears deleted_at and re-adds to pages list. */
  restorePage: (id: string) => Promise<void>;
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
  /** In-place folder colour patch, no DB write — the colour is already persisted
   *  (external-calendar recolor writes via the sync adapter). Avoids a full
   *  workspace reload just to repaint one sidebar swatch. */
  patchFolderColor: (folderId: string, color: string) => void;
  deleteFolder: (id: string) => Promise<void>;
  /** Soft-delete folder + all its pages. Recoverable via restoreFolder. */
  softDeleteFolder: (id: string) => Promise<void>;
  /** Restore a soft-deleted folder and all its pages. */
  restoreFolder: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  /**
   * Bulk complete/uncomplete in ONE transaction (multi-select Cmd+A → Space).
   * Optimistic; rolls back and surfaces a per-page error on failure. One atomic
   * write instead of N concurrent updatePage calls that race the WAL pool and
   * drop some completions. Non-recurring pages only — recurring completion goes
   * through completeRecurringPage (clone + advance).
   */
  setPagesStatus: (ids: string[], status: PageStatus, completedAt: string | null) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  /** Create or update the one-off schedule block for a page. */
  scheduleOnce: (pageId: string, start: string, end?: string) => Promise<void>;
  /** Delete all one-off schedule blocks for a page. */
  clearSchedule: (pageId: string) => Promise<void>;
  createRecurrence: (data: NewRecurrenceRule) => Promise<PageRecurrenceRule>;
  updateRecurrence: (ruleId: string, updates: RecurrenceRuleUpdate) => Promise<PageRecurrenceRule>;
  /** Cascades to materialised page_schedules overrides. */
  deleteRecurrence: (ruleId: string) => Promise<void>;
  /** The given rules' override rows, regardless of moved position (for rrule
   *  occurrence-exclusion, incl. a cross-week move). */
  listOverridesForRules: (ruleIds: string[]) => Promise<import("@pikos/core").PageSchedule[]>;
  /** Batched raw rrule expansion for a range via the Rust engine (rule EXDATEs
   * applied; completed/skip union stays client-side). */
  expandRecurrenceRange: (
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) => Promise<import("@pikos/core").RawRuleExpansion[]>;
  /** Materialise a virtual rrule occurrence as an independent real page. */
  rescheduleVirtualOccurrence: (
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ) => Promise<void>;
  /** Bumped when an override row changes without any page or rule changing with
   *  it — the calendar's override fetch is keyed on the visible range and the
   *  rule set, so an in-place move is otherwise invisible to it until a nav. */
  overridesVersion: number;
  /**
   * Complete the head's own occurrence: clone as done, advance the head to the
   * next open one. `head` overrides the state lookup so a sequential run can
   * chain off the previous call's recomputed head — `pages` state lags a loop.
   * Null when the re-entrancy guard swallowed the call.
   */
  completeRecurringPage: (
    pageId: string,
    head?: PageSummary
  ) => Promise<CompleteRecurringResult | null>;
  /** Complete one rendered occurrence of a synced-origin series (virtual or moved
   *  block), keyed on its original date. Null when the guard swallowed the call. */
  completeSyncedOccurrence: (input: {
    pageId: string;
    occurrenceDate: string;
    scheduledStart: string;
    scheduledEnd?: string;
  }) => Promise<CompleteRecurringResult | null>;
  /** Complete every open occurrence from the head up to, but not including, today
   *  — the gap dialog's "all to today". */
  completeRecurringToToday: (pageId: string, opts?: GapRunOptions) => Promise<void>;
  /** Dismiss occurrences of a recurring page to the skip-set. Returns an undo
   *  function that restores all of them. */
  skipOccurrences: (pageId: string, dates: string[]) => Promise<() => void>;
  /**
   * Unchecking a recurring done clone (native or synced) → uncomplete that
   * occurrence and restore it, rather than a plain status flip a recompute would
   * revert. Returns true when handled — the caller must not fall through.
   */
  maybeUncompleteRecurringClone: (page: PageSummary, nextStatus: PageStatus) => boolean;
  /**
   * Un-done of a native recurring head → occurrence-uncomplete (undo the last
   * completion), not a plain status flip that a recompute would revert. Returns
   * true when handled; false (non-recurring, active-synced, or legacy completion)
   * leaves the caller to do its plain flip.
   */
  uncompleteRecurringHead: (pageId: string) => Promise<boolean>;
  /**
   * Uncheck a recurring page: rewind the last occurrence via
   * `uncompleteRecurringHead`, or plain-flip to `not_started` when there's
   * nothing to rewind.
   */
  uncompleteRecurringOrFlip: (pageId: string) => Promise<void>;
  /** Paginated completed pages — lazy-loaded when the "Completed" section is expanded. */
  listCompletedPages: (filter: CompletedPagesFilter) => Promise<CompletedPagesResponse>;
  /** Merge lazy-loaded pages (e.g. completed) into the pages array, deduplicating by ID. */
  mergePages: (incoming: PageSummary[]) => void;
  /** Unified FTS5 search — title matches ranked above content via bm25(). */
  searchPages: (query: string, includeCompleted?: boolean) => Promise<SearchResponse>;
  /** Tag name prefix search — for autocomplete in tag chip inputs. */
  searchTags: (query: string) => Promise<string[]>;
  /** Per-page error state from failed debounced writes or scheduling mutations.
   *  Typed so consumers can branch on err.kind for friendly UI copy without
   *  leaking raw sqlx/Tauri text. */
  pageErrors: Map<string, StorageError>;
  clearPageError: (id: string) => void;
}

const PagesContext = createContext<PagesContextValue | null>(null);

export function PagesProvider({ children }: { children: ReactNode }) {
  const { adapter, eventBus, registerDataLoader } = useWorkspaceInternal();
  const { emit } = eventBus;

  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recurrenceRules, setRecurrenceRules] = useState<PageRecurrenceRule[]>([]);

  // Latest-state mirrors for the write closures: a mutation that reads `pages`
  // from its own closure would snapshot whatever the render that created it saw,
  // and these closures outlive their render (debounce timers, queued writes,
  // promise continuations). The write is deliberately render-phase, not
  // effect-phase — a handler handed out by THIS render must already read this
  // render's data, and an effect-time mirror would leave it one commit behind.
  const pagesRef = useRef(pages);
  const foldersRef = useRef(folders);
  const recurrenceRulesRef = useRef(recurrenceRules);
  /* eslint-disable react-hooks/refs -- deliberate latest-state mirror; see above */
  pagesRef.current = pages;
  foldersRef.current = folders;
  recurrenceRulesRef.current = recurrenceRules;
  /* eslint-enable react-hooks/refs */

  // Loads only active pages at init; completed pages are fetched lazily —
  // via useCompletedPages for the per-folder Completed section, and via
  // CalendarView for the visible date range.
  async function loadData(): Promise<void> {
    // Heal the recurring display cache before reading it: an out-of-process writer
    // (CLI/mobile) or a prior bug can leave pages.scheduled_start stale. In steady
    // state (every in-session write already recomputes) this is a no-op.
    await adapter.recomputeRecurringSchedules();
    const [loadedPages, loadedFolders, loadedRules] = await Promise.all([
      adapter.listPages({ status: "not_started" }),
      adapter.listFolders(),
      adapter.listRecurrenceRules(),
    ]);
    setPages(loadedPages);
    setFolders(loadedFolders);
    setRecurrenceRules(loadedRules);
  }

  // Register the loader with WorkspaceContext so its init/selectWorkspace/
  // resetAndSeed can dispatch a data load at the right moment in their
  // sequence. The registered closure reaches the latest adapter via the
  // useWorkspaceInternal() call above.
  const loadDataLatestRef = useRef(loadData);
  useEffect(() => {
    loadDataLatestRef.current = loadData;
  });
  useEffect(() => {
    registerDataLoader(() => loadDataLatestRef.current());
    return () => registerDataLoader(null);
  }, [registerDataLoader]);

  // Debounce, per-page write serialisation, rollback snapshots, pageErrors, and
  // the optimistic-write shape every mutation below goes through.
  const {
    cancelPendingWrite,
    clearPageError,
    enqueue,
    flushPage,
    optimistic,
    pageErrors,
    updatePage,
  } = usePageWriteQueue({ adapter, emit, pagesRef, setPages });

  // Rules, completion, uncomplete, skips, and virtual-occurrence materialisation
  // — every write that defers the head to the backend recompute.
  const recurring = useRecurringWrites({
    adapter,
    enqueue,
    flushPage,
    pagesRef,
    recurrenceRulesRef,
    setPages,
    setRecurrenceRules,
    updatePage,
  });

  // ─── Pages ────────────────────────────────────────────────────────────────

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

  function mergePages(incoming: PageSummary[]) {
    setPages((prev) => {
      const existing = new Set(prev.map((p) => p.id));
      const newPages = incoming.filter((p) => !existing.has(p.id));
      return newPages.length > 0 ? [...prev, ...newPages] : prev;
    });
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

  // ─── Folders ──────────────────────────────────────────────────────────────

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

  async function scheduleOnce(pageId: string, start: string, end?: string): Promise<void> {
    const snapshot = pagesRef.current.find((p) => p.id === pageId);
    // Recurring head: capture the rule snapshot so we can shift the rule's
    // anchor in lockstep with the head's denorm. Without this, dragging the
    // head from Mon to Wed leaves rule.scheduledStart pointed at Mon — the
    // calendar then keeps emitting Mon-based virtuals (and any past dates
    // before the new head linger), making the series feel detached from the
    // user's most recent action.
    const ruleSnapshot = recurrenceRulesRef.current.find((r) => r.pageId === pageId);
    // Where the drop actually lands once the rule has had its say: a weekly
    // BYDAY realigned to the moved weekday, and an off-pattern date snapped onto
    // a day the rule yields. Both must settle BEFORE the optimistic update, else
    // the next recompute silently reverts the dragged position.
    const move = resolveAnchorMove(ruleSnapshot, start, end);
    const { end: snappedEnd, start: snappedStart } = move;

    await optimistic({
      apply: () => {
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId
              ? { ...p, scheduledEnd: snappedEnd ?? null, scheduledStart: snappedStart }
              : p
          )
        );
        if (ruleSnapshot) {
          setRecurrenceRules((prev) =>
            prev.map((r) => (r.id === ruleSnapshot.id ? applyAnchorMove(r, move) : r))
          );
        }
      },
      errorIds: [pageId],
      label: `scheduleOnce(${pageId})`,
      queueOn: pageId,
      rethrow: true,
      rollback: () => {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        if (ruleSnapshot) {
          setRecurrenceRules((prev) =>
            prev.map((r) => (r.id === ruleSnapshot.id ? ruleSnapshot : r))
          );
        }
      },
      write: async () => {
        const schedules = await adapter.listPageSchedules(pageId);
        const existing = schedules.find((s) => !s.ruleId);
        if (existing) {
          await adapter.updatePageSchedule(existing.id, {
            scheduledEnd: snappedEnd ?? null,
            scheduledStart: snappedStart,
          });
        } else {
          await adapter.createPageSchedule({
            pageId,
            scheduledStart: snappedStart,
            ...(snappedEnd !== undefined && { scheduledEnd: snappedEnd }),
            timezone: getLocalTimezone(),
          });
        }
        if (ruleSnapshot) {
          await adapter.updateRecurrenceRule(ruleSnapshot.id, anchorMoveUpdate(ruleSnapshot, move));
          // The rule update recomputes pages.scheduled_start backend-side (the
          // derivation owns the recurring head). Adopt that result so a drop onto
          // a set-excluded date — which the local snap can't detect — converges to
          // the head the backend actually derived.
          await recurring.patchRecomputedHead(pageId);
        }
      },
    });
  }

  async function clearSchedule(pageId: string): Promise<void> {
    const snapshot = pagesRef.current.find((p) => p.id === pageId);
    await optimistic({
      apply: () =>
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId ? { ...p, scheduledEnd: null, scheduledStart: null } : p
          )
        ),
      errorIds: [pageId],
      label: `clearSchedule(${pageId})`,
      queueOn: pageId,
      rethrow: true,
      rollback: () => {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
      },
      write: async () => {
        const schedules = await adapter.listPageSchedules(pageId);
        const oneOffs = schedules.filter((s) => !s.ruleId);
        await Promise.all(oneOffs.map((s) => adapter.deletePageSchedule(s.id)));
      },
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

  // ─── Adapter pass-throughs ─────────────────────────────────────────────────

  function getPage(id: string): Promise<Page | null> {
    return adapter.getPage(id);
  }

  function listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse> {
    return adapter.listCompletedPages(filter);
  }

  function searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse> {
    return adapter.searchPages(query, includeCompleted);
  }

  function searchTags(query: string): Promise<string[]> {
    return adapter.searchTags(query);
  }

  const tags = deriveTags(pages);

  // Named one by one rather than spread: `recurring` also carries
  // patchRecomputedHead, which is internal to the write paths and must not
  // become part of the usePages() surface.
  const {
    completeRecurringPage,
    completeRecurringToToday,
    completeSyncedOccurrence,
    createRecurrence,
    deleteRecurrence,
    expandRecurrenceRange,
    listOverridesForRules,
    maybeUncompleteRecurringClone,
    overridesVersion,
    rescheduleVirtualOccurrence,
    skipOccurrences,
    uncompleteRecurringHead,
    uncompleteRecurringOrFlip,
    updateRecurrence,
  } = recurring;

  const value: PagesContextValue = {
    clearPageError,
    clearPendingDescription,
    clearSchedule,
    completeRecurringPage,
    completeRecurringToToday,
    completeSyncedOccurrence,
    createFolder,
    createPage,
    createRecurrence,
    deleteFolder,
    deletePage,
    deleteRecurrence,
    expandRecurrenceRange,
    flushPage,
    folders,
    getPage,
    listCompletedPages,
    listOverridesForRules,
    maybeUncompleteRecurringClone,
    mergePages,
    overridesVersion,
    pageErrors,
    pages,
    patchFolderColor,
    recurrenceRules,
    reorderFolders,
    reorderPages,
    rescheduleVirtualOccurrence,
    restoreFolder,
    restorePage,
    scheduleOnce,
    searchPages,
    searchTags,
    setPagesStatus,
    skipOccurrences,
    softDeleteFolder,
    softDeletePage,
    tags,
    uncompleteRecurringHead,
    uncompleteRecurringOrFlip,
    updateFolder,
    updatePage,
    updateRecurrence,
  };

  return <PagesContext.Provider value={value}>{children}</PagesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePages(): PagesContextValue {
  const ctx = useContext(PagesContext);
  if (!ctx) throw new Error("usePages must be used within <PagesProvider>");
  return ctx;
}
