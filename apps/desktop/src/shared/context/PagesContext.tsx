// PagesContext — the single data surface for pages, folders, tags and
// recurrence rules. This file declares that surface (PagesContextValue, the
// contract every consumer reads) and composes it; the work is split across
// modules beside it, one per job:
//
//   usePagesStore       the collections, their latest-state refs, the loader
//   usePageWriteQueue   debounce, per-page write serialisation, rollback
//                       snapshots, pageErrors, and the one optimistic() shape
//   usePageWrites       page CRUD + bulk status
//   useFolderWrites     folder CRUD + ordering
//   useScheduleWrites   the one-off schedule block (and the anchor move)
//   useRecurringWrites  rules, completion, uncomplete, skips, virtual moves
//
// Workspace lifecycle (init, reload, resetAndSeed) lives in WorkspaceContext;
// the store registers a data-loader so Workspace can dispatch reloads.
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
import type {
  FolderUpdate,
  NewRecurrenceRule,
  PageUpdate,
  RecurrenceRuleUpdate,
} from "@pikos/core";
import { createContext, type ReactNode, useContext } from "react";

import { useFolderWrites } from "./useFolderWrites";
import { usePagesStore } from "./usePagesStore";
import { usePageWriteQueue } from "./usePageWriteQueue";
import { usePageWrites } from "./usePageWrites";
import { type GapRunOptions, useRecurringWrites } from "./useRecurringWrites";
import { useScheduleWrites } from "./useScheduleWrites";
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

  // Collections, their latest-state mirrors, derived tags, and the loader
  // WorkspaceContext dispatches on init/reload/resetAndSeed.
  const {
    folders,
    foldersRef,
    mergePages,
    pages,
    pagesRef,
    recurrenceRules,
    recurrenceRulesRef,
    setFolders,
    setPages,
    setRecurrenceRules,
    tags,
  } = usePagesStore({ adapter, registerDataLoader });

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

  // Folder CRUD + ordering, which also prunes/restores the pages they hold.
  const {
    createFolder,
    deleteFolder,
    patchFolderColor,
    reorderFolders,
    restoreFolder,
    softDeleteFolder,
    updateFolder,
  } = useFolderWrites({ adapter, foldersRef, optimistic, setFolders, setPages });

  // Page CRUD: create, delete (hard + soft), restore, reorder, bulk status.
  const {
    clearPendingDescription,
    createPage,
    deletePage,
    reorderPages,
    restorePage,
    setPagesStatus,
    softDeletePage,
  } = usePageWrites({ adapter, cancelPendingWrite, emit, optimistic, pagesRef, setPages });

  // The one-off schedule block — which is also how a recurring series' anchor moves.
  const { clearSchedule, scheduleOnce } = useScheduleWrites({
    adapter,
    optimistic,
    pagesRef,
    patchRecomputedHead: recurring.patchRecomputedHead,
    recurrenceRulesRef,
    setPages,
    setRecurrenceRules,
  });

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
