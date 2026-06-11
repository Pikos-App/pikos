// PagesContext — owns all data state and CRUD: pages, folders, tags,
// recurrenceRules, plus debounced writes and per-page mutation queue.
// Workspace lifecycle (init, reload, resetAndSeed) lives in WorkspaceContext;
// PagesProvider registers a data-loader so Workspace can dispatch reloads.
// Import batch flow lives in ImportContext.

import type {
  CompletedPagesFilter,
  CompletedPagesResponse,
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
  computeNextEnd,
  getLocalTimezone,
  missedOccurrencesBetween,
  nextOccurrenceAfter,
  parseLocalISO,
  toStorageError,
} from "@pikos/core";
import type {
  FolderUpdate,
  NewRecurrenceRule,
  PageUpdate,
  RecurrenceRuleUpdate,
} from "@pikos/core";
import { addDays, startOfDay } from "date-fns";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { createLogger } from "@/shared/logger";

import { useWorkspaceInternal } from "./WorkspaceContext";

const log = createLogger("PagesContext");

function toPageSummary(page: Page): PageSummary {
  const { content: _, contentText: _ct, ...summary } = page;
  return summary;
}

/**
 * How `completeRecurringPage` handles missed occurrences when the head is
 * overdue (today > head's scheduledStart). See completeRecurringPage's JSDoc
 * for what each policy does.
 */
export type MissedOccurrencePolicy = "advance" | "skip";

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
  /** Soft-delete: sets deleted_at. Page is hidden everywhere but recoverable via restorePage. */
  softDeletePage: (id: string) => Promise<void>;
  /** Restore a soft-deleted page — clears deleted_at and re-adds to pages list. */
  restorePage: (id: string) => Promise<void>;
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
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
  /** List all materialised schedule rows in a date range (for rrule override filtering). */
  listSchedulesRange: (start: string, end: string) => Promise<import("@pikos/core").PageSchedule[]>;
  /** Materialise a virtual rrule occurrence as an independent real page. */
  rescheduleVirtualOccurrence: (
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ) => Promise<void>;
  /**
   * Complete a recurring page: clone as done, advance head to next occurrence.
   * The `missedPolicy` controls behaviour when there's a gap between the head's
   * date and today (head is overdue):
   *   - `advance` (default): one rrule step from head — past virtuals stay on
   *     the calendar so the user can address each individually.
   *   - `skip`: exdate every missed occurrence between head and today, then
   *     advance to today/the next non-excluded date — past calendar reads clean.
   * No gap → `advance` is the only sensible choice and the dialog is skipped.
   */
  completeRecurringPage: (pageId: string, missedPolicy?: MissedOccurrencePolicy) => Promise<void>;
  /** Skip a single occurrence of a recurring page (add date to exdates). Returns an undo function. */
  skipOccurrence: (ruleId: string, date: string) => Promise<() => void>;
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
  const reschedulingVirtualRef = useRef<Set<string>>(new Set());
  const [pageErrors, setPageErrors] = useState<Map<string, StorageError>>(new Map());

  // ─── Per-page mutation queue ───────────────────────────────────────────────
  // Serialises concurrent DB writes for the same page so that a fast debounced
  // write and a concurrent scheduleOnce can never interleave or clobber each other.

  const mutationQueues = useRef<Map<string, Promise<void>>>(new Map());

  function enqueue(pageId: string, fn: () => Promise<void>): Promise<void> {
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
    // day" bug). No-op for daily/monthly/multi-day rules.
    const alignedRrule = ruleSnapshot
      ? alignWeeklyRuleToAnchor(ruleSnapshot.rrule, start)
      : undefined;

    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId ? { ...p, scheduledEnd: end ?? null, scheduledStart: start } : p
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
            scheduledStart: start,
          };
          if (end !== undefined) next.scheduledEnd = end;
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
            scheduledEnd: end ?? null,
            scheduledStart: start,
          });
        } else {
          await adapter.createPageSchedule({
            pageId,
            scheduledStart: start,
            ...(end !== undefined && { scheduledEnd: end }),
            timezone: tz,
          });
        }
        if (ruleSnapshot) {
          await adapter.updateRecurrenceRule(ruleSnapshot.id, {
            // Lockstep with the head denorm (end ?? null), incl. clearing —
            // see the optimistic update above for why a stale end corrupts
            // the next occurrence on completion.
            scheduledEnd: end ?? null,
            scheduledStart: start,
            // Realign weekly BYDAY to the moved weekday (no-op when unchanged).
            ...(alignedRrule && alignedRrule !== ruleSnapshot.rrule ? { rrule: alignedRrule } : {}),
          });
          // Persist the head's pages.scheduled_start denorm directly.
          // refresh_schedule_denorm SKIPS rrule-backed pages (it can't tell a
          // move from a lingering past anchor), so without this the denorm
          // stays at the pre-move value — which completion then clones into the
          // "done" block (it lands at the original time) and which a reload
          // renders the head at. That stale denorm is the "moving a recurring
          // head then completing reverts to its original time" bug.
          await adapter.updatePage(pageId, { scheduledEnd: end ?? null, scheduledStart: start });
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
      setPages((prev) => [...prev, result.clone]);
      // Rule state syncs from the post-merge exdates the backend returns, not
      // a locally computed array — see addExdates in CompleteRecurringInput.
      setRecurrenceRules((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: result.ruleExdates } : r))
      );
    } finally {
      reschedulingVirtualRef.current.delete(guardKey);
    }
  }

  function listSchedulesRange(start: string, end: string) {
    return adapter.listPageSchedulesRange(start, end);
  }

  async function completeRecurringPage(
    pageId: string,
    missedPolicy: MissedOccurrencePolicy = "advance"
  ): Promise<void> {
    // Re-entrancy guard: the checkbox path is fire-and-forget and not disabled
    // in flight, and the backend mints one clone + one head-advance per call —
    // a re-entrant call (or, now that completion is queued, a SERIALIZED
    // second call) would complete two occurrences for one gesture.
    if (completingRecurringRef.current.has(pageId)) return;
    completingRecurringRef.current.add(pageId);
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
      await enqueue(pageId, () => completeRecurringPageQueued(pageId, missedPolicy));
    } finally {
      completingRecurringRef.current.delete(pageId);
    }
  }

  async function completeRecurringPageQueued(
    pageId: string,
    missedPolicy: MissedOccurrencePolicy
  ): Promise<void> {
    const rule = recurrenceRulesRef.current.find((r) => r.pageId === pageId);
    if (!rule) throw new Error(`No recurrence rule for page ${pageId}`);

    const head = pagesRef.current.find((p) => p.id === pageId);
    const headDate = head?.scheduledStart ? parseLocalISO(head.scheduledStart) : new Date();
    const todayStart = startOfDay(new Date());
    const completedDate = head?.scheduledStart?.slice(0, 10);

    // Compute the missed-occurrence gap (rrule occurrences strictly between
    // the head and today, not already in exdates). Only relevant for skip —
    // advance leaves them alone so they keep showing on the calendar for the
    // user to address one at a time.
    const gapDates =
      missedPolicy === "skip" && todayStart > headDate
        ? missedOccurrencesBetween(
            rule.rrule,
            rule.scheduledStart,
            headDate,
            todayStart,
            rule.rruleExdates
          )
        : [];

    // afterDate per policy. advance = one rrule step past head; skip jumps
    // to today (or stays at headDate if head is in the future).
    //
    // For skip we pass `yesterday` rather than `todayStart` because
    // nextOccurrenceAfter is day-level strict-after (cursor = endOfDay(afterDate)).
    // Passing today would skip today's own occurrence even when the rule has
    // one — making "advance to today" land on tomorrow. Passing yesterday lets
    // today's occurrence be the result when the rule produces one.
    const afterDate =
      missedPolicy === "advance"
        ? headDate
        : todayStart > headDate
          ? addDays(todayStart, -1)
          : headDate;

    // Exdates the advance-computation should respect: existing + head's date
    // (clone occupies it) + every gap date (skip removes them).
    const exdatesForAdvance = [
      ...rule.rruleExdates,
      ...(completedDate ? [completedDate] : []),
      ...gapDates,
    ];
    const next = nextOccurrenceAfter(rule.rrule, rule.scheduledStart, afterDate, exdatesForAdvance);
    const nextEnd =
      next && rule.scheduledEnd ? computeNextEnd(rule.scheduledEnd, next.scheduledStart) : null;

    // Exdates to ADD: head's date + all gap dates. Skip adds the gap so the
    // rule's expansion stops emitting those days; advance only adds head. The
    // backend merges these into the current row — never send a full
    // replacement array, which would erase exdates persisted since this
    // snapshot (an interleaved skip) and resurrect their occurrences.
    const addExdates = [...(completedDate ? [completedDate] : []), ...gapDates];

    // The exdate update is folded INTO the completion command (one atomic
    // transaction) rather than issued as a second, concurrent write. Two writes
    // racing the same WAL pool deadlock with SQLITE_BUSY (code 517) and the
    // whole completion is lost — the recurring-checkbox "nothing happens" bug.
    const result = await adapter.completeRecurringPage({
      nextScheduledEnd: nextEnd,
      nextScheduledStart: next?.scheduledStart ?? null,
      pageId,
      ...(addExdates.length > 0 ? { addExdates, ruleId: rule.id } : {}),
    });

    if (result.ruleExdates) {
      const ruleExdates = result.ruleExdates;
      setRecurrenceRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, rruleExdates: ruleExdates } : r))
      );
    }
    setPages((prev) => {
      const updated = prev.map((p) => (p.id === pageId ? result.head : p));
      return [...updated, result.clone];
    });
  }

  async function skipOccurrence(ruleId: string, date: string): Promise<() => void> {
    // Exdate writes go through the DB-side merge ops, never a full-array
    // read-modify-write from React state — that races other exdate writers
    // (a completion mid-flight, another skip) and silently erases their dates.
    const updated = await adapter.addRuleExdates(ruleId, [date]);
    setRecurrenceRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: updated.rruleExdates } : r))
    );

    return () => {
      // Undo removes exactly the skipped date from the CURRENT row. Restoring
      // the array captured at skip time would erase any exdate persisted
      // inside the undo-toast window (e.g. a completion's date), resurrecting
      // that occurrence next to its done clone.
      void adapter.removeRuleExdate(ruleId, date).then((restored) => {
        setRecurrenceRules((prev) =>
          prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: restored.rruleExdates } : r))
        );
      });
    };
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
    clearSchedule,
    completeRecurringPage,
    createFolder,
    createPage,
    createRecurrence,
    deleteFolder,
    deletePage,
    deleteRecurrence,
    flushPage,
    folders,
    getPage,
    listCompletedPages,
    listSchedulesRange,
    mergePages,
    pageErrors,
    pages,
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
    skipOccurrence,
    softDeleteFolder,
    softDeletePage,
    tags,
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
