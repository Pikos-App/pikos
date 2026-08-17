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
  alignWeeklyRuleToAnchor,
  dateKey,
  formatDateOnly,
  formatLocalISO,
  getLocalTimezone,
  isTimedIso,
  resolveSyncedInstant,
  rruleEditWouldDegrade,
  snapScheduleToRule,
  toStorageError,
} from "@pikos/core";
import type {
  FolderUpdate,
  NewRecurrenceRule,
  PageUpdate,
  RecurrenceRuleUpdate,
} from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { createLogger } from "@/shared/logger";

import { useWorkspaceInternal } from "./WorkspaceContext";

const log = createLogger("PagesContext");

function toPageSummary(page: Page): PageSummary {
  const { content: _, contentText: _ct, ...summary } = page;
  return summary;
}

/** Chaining + bound for a "complete everything to today" run. `fromHead` carries
 * the recomputed head returned by the gesture that opened the run — `pages` state
 * lags a sequential loop, so a state read would re-complete the same occurrence.
 * `maxSteps` is the runaway backstop: the dialog counted the backlog it promised. */
export interface GapRunOptions {
  fromHead?: PageSummary;
  maxSteps?: number;
}

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

function deriveTags(pages: PageSummary[]): Tag[] {
  const map = new Map<string, { count: number; ids: string[] }>();
  for (const page of pages) {
    for (const tag of page.tags) {
      const entry = map.get(tag);
      if (entry) {
        entry.count++;
        entry.ids.push(page.id);
      } else {
        map.set(tag, { count: 1, ids: [page.id] });
      }
    }
  }
  return Array.from(map.entries()).map(([name, { count, ids }]) => ({
    name,
    pageCount: count,
    pageIds: ids,
  }));
}

export function PagesProvider({ children }: { children: ReactNode }) {
  const { adapter, eventBus, registerDataLoader } = useWorkspaceInternal();
  const { emit } = eventBus;

  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recurrenceRules, setRecurrenceRules] = useState<PageRecurrenceRule[]>([]);

  const pagesRef = useRef(pages);
  const foldersRef = useRef(folders);
  const recurrenceRulesRef = useRef(recurrenceRules);
  pagesRef.current = pages;
  foldersRef.current = folders;
  recurrenceRulesRef.current = recurrenceRules;

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

  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const snapshotsRef = useRef<Map<string, PageSummary>>(new Map());
  // In-flight recurring writes that mint a clone (completion by page id,
  // virtual reschedule by ruleId|originalDate). The backend creates one clone
  // per call and both UI paths are fire-and-forget with no disabled state, so a
  // re-entrant call would mint a duplicate. Checked + added synchronously
  // before the first await; cleared on settle so a later genuine call runs.
  const completingRecurringRef = useRef<Set<string>>(new Set());
  // Same guard for synced occurrences: the toggle path fires completeSyncedOccurrence
  // fire-and-forget with no disabled state, so a double-click would append the
  // (idempotent) clone twice into `pages`.
  const completingSyncedRef = useRef<Set<string>>(new Set());
  const reschedulingVirtualRef = useRef<Set<string>>(new Set());
  const [overridesVersion, setOverridesVersion] = useState(0);
  const [pageErrors, setPageErrors] = useState<Map<string, StorageError>>(new Map());

  // ─── Per-page mutation queue ───────────────────────────────────────────────
  // Serialises concurrent DB writes for the same page so that a fast debounced
  // write and a concurrent scheduleOnce can never interleave or clobber each other.

  const mutationQueues = useRef<Map<string, Promise<unknown>>>(new Map());

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

  function updatePage(id: string, patch: PageUpdate): void {
    if (!pendingPatches.current.has(id)) {
      const current = pagesRef.current.find((p) => p.id === id);
      if (current) snapshotsRef.current.set(id, current);
    }

    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

    const existing = pendingPatches.current.get(id) ?? {};
    pendingPatches.current.set(id, { ...existing, ...patch });

    const prevTimer = debounceTimers.current.get(id);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    // Status changes gate the native notification scheduler, which reads
    // pages.status directly from SQLite. Flushing them immediately — instead of
    // after the 800ms debounce — closes a race where a reminder could fire for
    // a page the user just marked done. Status toggles are deliberate and
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

      void enqueue(id, async () => {
        try {
          const updated = await adapter.updatePage(id, accumulated);
          snapshotsRef.current.delete(id);
          const { content: _, contentText: _ct, ...summary } = updated;
          setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
          emit("page:updated", updated);
        } catch (err: unknown) {
          log.error(`updatePage(${id}) debounce write failed; rolling back`, err);
          const snapshot = snapshotsRef.current.get(id);
          snapshotsRef.current.delete(id);
          if (snapshot) {
            setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
          }
          setPageErrors((prev) => new Map(prev).set(id, toStorageError(err)));
        }
      });
    }, 800);

    debounceTimers.current.set(id, timer);
  }

  async function flushPage(id: string): Promise<void> {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);

    const accumulated = pendingPatches.current.get(id);
    if (!accumulated) return;
    pendingPatches.current.delete(id);

    return enqueue(id, async () => {
      try {
        const updated = await adapter.updatePage(id, accumulated);
        snapshotsRef.current.delete(id);
        const summary = toPageSummary(updated);
        setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
        emit("page:updated", updated);
      } catch (err) {
        log.error(`flushPage(${id}) failed; rolling back`, err);
        const snapshot = snapshotsRef.current.get(id);
        snapshotsRef.current.delete(id);
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
        }
        setPageErrors((prev) => new Map(prev).set(id, toStorageError(err)));
        throw err;
      }
    });
  }

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
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    pendingPatches.current.delete(id);

    await adapter.deletePage(id);
    setPages((prev) => prev.filter((p) => p.id !== id));
    emit("page:deleted", id);
  }

  async function clearPendingDescription(id: string) {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, pendingDescription: null } : p)));
    await adapter.clearPendingDescription(id);
  }

  async function softDeletePage(id: string) {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    pendingPatches.current.delete(id);

    // Remove from local state synchronously, BEFORE the await. If the removal
    // waits on the adapter, a fast Undo (restorePage) can interleave with this
    // pending await and re-add the page while it's still present — duplicating
    // it in the derived active/completed lists (and confusing the virtualizer).
    const snapshot = pagesRef.current.find((p) => p.id === id);
    setPages((prev) => prev.filter((p) => p.id !== id));
    try {
      await adapter.softDeletePage(id);
    } catch (err) {
      log.error(`softDeletePage(${id}) failed; restoring optimistic removal`, err);
      if (snapshot) {
        setPages((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, snapshot]));
      }
      return;
    }
    emit("page:deleted", id);
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
    setPages((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map((p) => {
        const newOrder = indexMap.get(p.id);
        return newOrder !== undefined ? { ...p, sortOrder: newOrder } : p;
      });
    });
    try {
      await adapter.reorderPages(folderId, orderedIds);
    } catch (err) {
      log.error("reorderPages failed; rolling back optimistic order", err);
      setPages(snapshot);
    }
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
    // Realign a single-BYDAY weekly rule's weekday to the moved anchor — a head
    // dragged Mon→Wed must make the series "every Wednesday", else completion's
    // advance snaps back to the BYDAY weekday (the "reverts to its original
    // day" bug). No-op for daily/monthly/multi-day rules. Skipped for a rule the
    // editor is locked out of: the realign rebuilds through the same round-trip,
    // so it would silently drop the terms the lock exists to protect.
    const alignedRrule =
      ruleSnapshot && !rruleEditWouldDegrade(ruleSnapshot.rrule)
        ? alignWeeklyRuleToAnchor(ruleSnapshot.rrule, start)
        : undefined;

    // Snap an off-pattern drop (M/W/F dropped on Tue, monthly-by-day onto the
    // wrong date) onto the nearest day the rule yields, before any optimistic
    // update — otherwise recompute silently reverts it on the next heal (in
    // 0.3.x the dragged position wasn't durable). No-op for single-BYDAY weekly
    // (the realign above already fixes the day) and for non-recurring pages.
    // Set-excluded dates still resolve wrong here; the recompute adopted below
    // converges those.
    const { end: snappedEnd, start: snappedStart } = ruleSnapshot
      ? snapScheduleToRule(alignedRrule ?? ruleSnapshot.rrule, start, end)
      : { end, start };

    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? { ...p, scheduledEnd: snappedEnd ?? null, scheduledStart: snappedStart }
          : p
      )
    );
    if (ruleSnapshot) {
      setRecurrenceRules((prev) =>
        prev.map((r) => {
          if (r.id !== ruleSnapshot.id) return r;
          // Mirror the head denorm exactly — including CLEARING the end when
          // the move drops it. Leaving the old end in place desyncs the rule
          // (end < start), and completion's computeNextEnd then inflates it
          // into a multi-hour / 24h block. (scheduledEnd is optional, not
          // nullable, so we delete rather than assign null.)
          const next: PageRecurrenceRule = {
            ...r,
            rrule: alignedRrule ?? r.rrule,
            scheduledStart: snappedStart,
          };
          if (snappedEnd !== undefined) next.scheduledEnd = snappedEnd;
          else delete next.scheduledEnd;
          return next;
        })
      );
    }

    return enqueue(pageId, async () => {
      try {
        const schedules = await adapter.listPageSchedules(pageId);
        const existing = schedules.find((s) => !s.ruleId);
        const tz = getLocalTimezone();
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
            timezone: tz,
          });
        }
        if (ruleSnapshot) {
          await adapter.updateRecurrenceRule(ruleSnapshot.id, {
            // Lockstep with the head denorm (end ?? null), incl. clearing —
            // see the optimistic update above for why a stale end corrupts
            // the next occurrence on completion.
            scheduledEnd: snappedEnd ?? null,
            scheduledStart: snappedStart,
            // Realign weekly BYDAY to the moved weekday (no-op when unchanged).
            ...(alignedRrule && alignedRrule !== ruleSnapshot.rrule ? { rrule: alignedRrule } : {}),
          });
          // The rule update recomputes pages.scheduled_start backend-side (the
          // derivation owns the recurring head). Adopt that result so a drop onto
          // a set-excluded date — which the local snap can't detect — converges to
          // the head the backend actually derived.
          await patchRecomputedHead(pageId);
        }
      } catch (e) {
        log.error(`scheduleOnce(${pageId}) failed; rolling back optimistic schedule`, e);
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        if (ruleSnapshot) {
          setRecurrenceRules((prev) =>
            prev.map((r) => (r.id === ruleSnapshot.id ? ruleSnapshot : r))
          );
        }
        setPageErrors((prev) => new Map(prev).set(pageId, toStorageError(e)));
        throw e;
      }
    });
  }

  async function clearSchedule(pageId: string): Promise<void> {
    const snapshot = pagesRef.current.find((p) => p.id === pageId);
    setPages((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, scheduledEnd: null, scheduledStart: null } : p))
    );
    return enqueue(pageId, async () => {
      try {
        const schedules = await adapter.listPageSchedules(pageId);
        const oneOffs = schedules.filter((s) => !s.ruleId);
        await Promise.all(oneOffs.map((s) => adapter.deletePageSchedule(s.id)));
      } catch (e) {
        log.error(`clearSchedule(${pageId}) failed; rolling back`, e);
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        setPageErrors((prev) => new Map(prev).set(pageId, toStorageError(e)));
        throw e;
      }
    });
  }

  // ─── Recurrence rules ─────────────────────────────────────────────────────

  async function createRecurrence(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const rule = await adapter.createRecurrenceRule(data);
    setRecurrenceRules((prev) => [...prev, rule]);
    return rule;
  }

  async function updateRecurrence(
    ruleId: string,
    updates: RecurrenceRuleUpdate
  ): Promise<PageRecurrenceRule> {
    const updated = await adapter.updateRecurrenceRule(ruleId, updates);
    setRecurrenceRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
    return updated;
  }

  async function deleteRecurrence(ruleId: string): Promise<void> {
    await adapter.deleteRecurrenceRule(ruleId);
    setRecurrenceRules((prev) => prev.filter((r) => r.id !== ruleId));
  }

  /** Re-fetch a recurring head after a backend recompute (which returns void) and
   * patch its derived fields into state, so the FE reflects the head the derivation
   * produced rather than an optimistic guess. `dropCloneId` removes the deleted done
   * clone in the same update (the uncomplete path); the drop applies even if the head
   * fetch comes back empty. */
  async function patchRecomputedHead(pageId: string, dropCloneId?: string): Promise<void> {
    const fresh = await adapter.getPage(pageId);
    setPages((prev) => {
      const base = dropCloneId ? prev.filter((p) => p.id !== dropCloneId) : prev;
      if (!fresh) return base;
      return base.map((p) =>
        p.id === pageId
          ? {
              ...p,
              completedAt: fresh.completedAt ?? null,
              completedOccurrences: fresh.completedOccurrences ?? null,
              scheduledEnd: fresh.scheduledEnd ?? null,
              scheduledStart: fresh.scheduledStart ?? null,
              status: fresh.status,
            }
          : p
      );
    });
  }

  /** Uncompletes the NEWEST completed occurrence, then adopts the recomputed head.
   * Contract + false-return cases are on the interface type. */
  async function uncompleteRecurringHead(pageId: string): Promise<boolean> {
    const head = pagesRef.current.find((p) => p.id === pageId);
    if (!head || head.scheduleLocked) return false;
    if (!recurrenceRulesRef.current.some((r) => r.pageId === pageId)) return false;
    const map = head.completedOccurrences;
    const keys = map ? Object.keys(map) : [];
    if (keys.length === 0) return false;
    const newestDate = keys.reduce((a, b) => (a > b ? a : b));
    const cloneId = map![newestDate];
    await enqueue(pageId, async () => {
      await adapter.uncompleteRecurringOccurrence({ occurrenceDate: newestDate, pageId });
      await patchRecomputedHead(pageId, cloneId);
    });
    return true;
  }

  async function uncompleteRecurringOrFlip(pageId: string): Promise<void> {
    if (await uncompleteRecurringHead(pageId)) return;
    updatePage(pageId, { completedAt: null, status: "not_started" });
  }

  /**
   * Drag-to-reschedule (or popover Date pick) on a virtual rrule occurrence.
   * Materialises the occurrence as an independent real page: clones the head's
   * content + metadata, schedules the clone at the new time, and adds the
   * original date to the head's rruleExdates so the virtual disappears.
   *
   * The clone is a normal page — own id, status, movable, completable. The
   * head and rule are untouched, so the next virtual still appears at the
   * next non-excluded rrule occurrence.
   *
   * The previous "page_schedules override row" approach was discarded
   * because synthetic override blocks couldn't seamlessly inherit page
   * functionality (drag would duplicate, checkbox would advance the head).
   */
  async function rescheduleVirtualOccurrence(
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ): Promise<void> {
    // Re-entrancy guard, keyed per occurrence: callers are fire-and-forget
    // (calendar drag, popover date pick) with nothing disabled in flight, so a
    // double-invoke would materialize the same occurrence twice.
    const guardKey = `${ruleId}|${originalDate}`;
    if (reschedulingVirtualRef.current.has(guardKey)) return;
    reschedulingVirtualRef.current.add(guardKey);
    try {
      // Clone + schedule + exdate happen in ONE backend transaction — a
      // mid-sequence failure can no longer leave both the clone and the
      // still-unexcluded virtual on the calendar.
      const result = await adapter.rescheduleVirtualOccurrence({
        originalDate,
        ruleId,
        scheduledStart: start,
        timezone: getLocalTimezone(),
        ...(end !== undefined && { scheduledEnd: end }),
      });
      // No clone means the occurrence already had an override row and that row
      // moved in place. Nothing entered the page list, and no dep the calendar's
      // override fetch watches has changed — hence the explicit version bump.
      const { clone } = result;
      if (clone) {
        setPages((prev) => [...prev, clone]);
      } else {
        setOverridesVersion((v) => v + 1);
      }
      // Rule state syncs from the post-merge exdates the backend returns, not
      // a locally computed array — see addExdates in CompleteRecurringInput.
      setRecurrenceRules((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: result.ruleExdates } : r))
      );
    } finally {
      reschedulingVirtualRef.current.delete(guardKey);
    }
  }

  function listOverridesForRules(ruleIds: string[]) {
    return adapter.listPageSchedulesForRules(ruleIds);
  }

  function expandRecurrenceRange(
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) {
    return adapter.expandRecurrenceRange(rules, rangeStart, rangeEnd);
  }

  async function completeRecurringPage(
    pageId: string,
    head?: PageSummary
  ): Promise<CompleteRecurringResult | null> {
    const page = head ?? pagesRef.current.find((p) => p.id === pageId);
    // Re-entrancy guard: the checkbox path is fire-and-forget and not disabled
    // in flight, and the backend mints one clone + one head-advance per call —
    // a re-entrant call (or, now that completion is queued, a SERIALIZED
    // second call) would complete two occurrences for one gesture. Keyed per
    // occurrence (`pageId:date`, unified with the synced path) so completing two
    // different virtuals of one series in quick succession isn't dropped.
    const occKey = `${pageId}:${page?.scheduledStart?.slice(0, 10) ?? ""}`;
    if (completingRecurringRef.current.has(occKey)) return null;
    completingRecurringRef.current.add(occKey);
    try {
      // Drain any pending debounced patch for this page before advancing the
      // head. The head's denorm scheduledStart is written through the 800ms
      // debounce (e.g. when a recurring page is quick-added). If that write is
      // still pending when completion advances the head, it flushes *afterward*
      // and reverts scheduledStart to the original date — the advanced head
      // snaps back into Today alongside the done clone (two rows).
      await flushPage(pageId);
      // The completion itself runs ON the per-page mutation queue: a drag's
      // scheduleOnce writes (including its trailing denorm updatePage) may
      // still be in flight, and a completion racing past them lets the stale
      // schedule write commit AFTER the advance — rewinding the head to the
      // just-completed occurrence. Reading the refs inside the queued fn also
      // means the advance is computed from fully settled state.
      return await enqueue(pageId, () => completeRecurringPageQueued(pageId, page));
    } finally {
      completingRecurringRef.current.delete(occKey);
    }
  }

  async function completeRecurringPageQueued(
    pageId: string,
    head: PageSummary | undefined
  ): Promise<CompleteRecurringResult> {
    // An active synced head must name the occurrence it's completing: the reconciler
    // pins `pages.scheduled_start` at the series base, so the backend can't derive it
    // the way it does for a native head. The wall-clocks convert out of the source
    // zone, matching the clone a virtual completion writes.
    const syncedHead =
      head?.scheduleLocked && head.scheduledStart
        ? {
            occurrenceDate: head.scheduledStart.slice(0, 10),
            scheduledStart: cloneWallClock(head.scheduledStart, head.timezone),
            ...(head.scheduledEnd
              ? { scheduledEnd: cloneWallClock(head.scheduledEnd, head.timezone) }
              : {}),
          }
        : {};

    const result = await adapter.completeRecurringPage({ pageId, ...syncedHead });

    setPages((prev) => {
      const updated = prev.map((p) => (p.id === pageId ? result.head : p));
      return [...updated, result.clone];
    });
    return result;
  }

  /** Each step is the ordinary single completion, so the backend picks the next
   * open occurrence off truth and the client never computes a date. Stops when the
   * recomputed head reaches today, stops advancing (an out-of-envelope rule the
   * recompute can't move), or the caller's step budget runs out. */
  async function completeRecurringToToday(pageId: string, opts: GapRunOptions = {}): Promise<void> {
    const todayKey = formatDateOnly(new Date());
    const budget = opts.maxSteps ?? Number.MAX_SAFE_INTEGER;
    let head = opts.fromHead ?? pagesRef.current.find((p) => p.id === pageId);
    for (let step = 0; step < budget; step++) {
      const start = head?.scheduledStart;
      if (!head || !start || head.status === "done") return;
      if (dateKey(start) >= todayKey) return;
      const result = await completeRecurringPage(pageId, head);
      if (!result || result.head.scheduledStart === start) return;
      head = result.head;
    }
  }

  async function skipOccurrences(pageId: string, dates: string[]): Promise<() => void> {
    // Skips are per-occurrence state in the skip-set, not rule EXDATEs. Expansion
    // excludes each date via page.skippedOccurrences; the head is adopted from the
    // backend's recompute because a bulk dismissal can cover the head's own date.
    for (const date of dates) {
      await adapter.skipOccurrence({ occurrenceDate: date, pageId });
    }
    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? { ...p, skippedOccurrences: [...(p.skippedOccurrences ?? []), ...dates] }
          : p
      )
    );
    await patchRecomputedHead(pageId);

    return () => {
      void (async () => {
        for (const date of dates) {
          await adapter.undoSkipOccurrence({ occurrenceDate: date, pageId });
        }
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId
              ? {
                  ...p,
                  skippedOccurrences: (p.skippedOccurrences ?? []).filter(
                    (d) => !dates.includes(d)
                  ),
                }
              : p
          )
        );
        await patchRecomputedHead(pageId);
      })();
    };
  }

  // ─── Synced recurring occurrence completion ────────────────────────────────
  // Thin routing to the unified command with the client-rendered virtual; the model
  // (why a synced series supplies its occurrence, and how the recompute converges) is
  // documented on `complete_recurring_page` in the backend.

  /** `scheduledStart`/`scheduledEnd` are the occurrence as the engine emits it —
   *  source-zone wall-clock — and convert to the viewer's zone here. */
  async function completeSyncedOccurrence(input: {
    pageId: string;
    occurrenceDate: string;
    scheduledStart: string;
    scheduledEnd?: string;
  }): Promise<CompleteRecurringResult | null> {
    const key = `${input.pageId}:${input.occurrenceDate}`;
    if (completingSyncedRef.current.has(key)) return null;
    completingSyncedRef.current.add(key);
    const timezone = pagesRef.current.find((p) => p.id === input.pageId)?.timezone;
    let result: CompleteRecurringResult;
    try {
      result = await adapter.completeRecurringPage({
        ...input,
        scheduledStart: cloneWallClock(input.scheduledStart, timezone),
        ...(input.scheduledEnd
          ? { scheduledEnd: cloneWallClock(input.scheduledEnd, timezone) }
          : {}),
      });
    } finally {
      completingSyncedRef.current.delete(key);
    }
    // Surface the done clone alongside the advanced head, deduped since an idempotent
    // repeat re-returns the same clone already in state.
    setPages((prev) => {
      const withHead = prev.map((p) => (p.id === input.pageId ? result.head : p));
      return prev.some((p) => p.id === result.clone.id)
        ? withHead.map((p) => (p.id === result.clone.id ? result.clone : p))
        : [...withHead, result.clone];
    });
    return result;
  }

  // The unified backend uncomplete recomputes the head (native or synced), so
  // re-fetch it rather than guess.
  async function uncompleteRecurringClone(seriesId: string, occurrenceDate: string): Promise<void> {
    const series = pagesRef.current.find((p) => p.id === seriesId);
    const cloneId = series?.completedOccurrences?.[occurrenceDate];
    await adapter.uncompleteRecurringOccurrence({ occurrenceDate, pageId: seriesId });
    await patchRecomputedHead(seriesId, cloneId);
  }

  /**
   * Find the recurring series + date a done clone belongs to, or null — native or
   * synced. Scans the loaded series' completion maps — reliable because active
   * series are always in `pages` (the loader fetches all active pages with no
   * folder/range filter), and the done clone's series is active. Skips pages with
   * no completion map in O(1) each, so an uncheck costs ~one property read per page.
   */
  function findRecurringOccurrenceClone(
    cloneId: string
  ): { seriesId: string; occurrenceDate: string } | null {
    for (const p of pagesRef.current) {
      const map = p.completedOccurrences;
      if (!map) continue;
      const date = Object.keys(map).find((d) => map[d] === cloneId);
      if (date) return { occurrenceDate: date, seriesId: p.id };
    }
    return null;
  }

  /** The done clone is a NATIVE (floating) page. For a timed zoned occurrence,
   * store its start as the viewer-local wall-clock so the clone floats at the
   * same slot the absolute occurrence rendered (a 3pm PT event shown at 6pm ET
   * keeps a 6pm clone). All-day / floating (no tz) keep the raw wall-clock. The
   * map KEY stays the source-zone date — that's what expansion suppresses by. */
  function cloneWallClock(wallClock: string, timezone: string | null | undefined): string {
    if (timezone && isTimedIso(wallClock)) {
      return formatLocalISO(resolveSyncedInstant(wallClock, timezone));
    }
    return wallClock;
  }

  /**
   * Intercepts the un-check of a recurring done clone (native or synced) and
   * returns true ONLY when it handled it (caller must then NOT fall through) — a
   * plain status flip would be reverted by the next recompute. Completion routes
   * the other way, through the gap dialog, which owns the scope choice.
   */
  function maybeUncompleteRecurringClone(page: PageSummary, nextStatus: PageStatus): boolean {
    if (nextStatus !== "not_started") return false;
    const found = findRecurringOccurrenceClone(page.id);
    if (!found) return false;
    void uncompleteRecurringClone(found.seriesId, found.occurrenceDate);
    return true;
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

  async function setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);

    const snapshot = pagesRef.current.filter((p) => idSet.has(p.id));
    setPages((prev) => prev.map((p) => (idSet.has(p.id) ? { ...p, completedAt, status } : p)));

    try {
      const updated = await adapter.setPagesStatus(ids, status, completedAt);
      // Reconcile from the DB truth (e.g. updatedAt) for the rows that actually
      // changed; soft-deleted ids are absent from `updated` and left as-is.
      const byId = new Map(updated.map((p) => [p.id, p]));
      setPages((prev) => prev.map((p) => byId.get(p.id) ?? p));
    } catch (err) {
      log.error(`setPagesStatus failed for ${ids.length} pages; rolling back`, err);
      const byId = new Map(snapshot.map((p) => [p.id, p]));
      setPages((prev) => prev.map((p) => byId.get(p.id) ?? p));
      const storageErr = toStorageError(err);
      setPageErrors((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.set(id, storageErr);
        return next;
      });
    }
  }

  async function reorderFolders(orderedIds: string[]) {
    const snapshot = [...foldersRef.current];
    setFolders((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return [...prev].sort((a, b) => {
        const ai = indexMap.get(a.id) ?? a.sortOrder;
        const bi = indexMap.get(b.id) ?? b.sortOrder;
        return ai - bi;
      });
    });
    try {
      await adapter.reorderFolders(orderedIds);
    } catch (err) {
      log.error("reorderFolders failed; rolling back optimistic order", err);
      setFolders(snapshot);
    }
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
