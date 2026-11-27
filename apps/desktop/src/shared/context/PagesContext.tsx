// The data surface for pages, folders, tags and recurrence rules: declares the contract every
// consumer reads (PagesContextValue) and composes it from the hooks beside it, one per job.

import type {
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompleteRecurringResult,
  Folder,
  Page,
  PageRecurrenceRule,
  PageStatus,
  PageSummary,
  Placement,
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
import { storageErrorUserMessage, toStorageError } from "@pikos/core";
import { createContext, type ReactNode, useContext } from "react";

import { postNotice } from "@/shared/events/noticeBus";
import { recordOpen } from "@/shared/lib/recentOpens";
import { createLogger } from "@/shared/logger";

import { useAppSettings } from "./AppSettingsContext";
import { useFolderWrites } from "./useFolderWrites";
import { usePagesStore } from "./usePagesStore";
import { usePageWriteQueue } from "./usePageWriteQueue";
import { type NewPageFields, usePageWrites } from "./usePageWrites";
import { type GapRunOptions, useRecurringWrites } from "./useRecurringWrites";
import { useScheduleWrites } from "./useScheduleWrites";
import { useWorkspaceInternal } from "./WorkspaceContext";

export type { GapRunOptions };

const log = createLogger("PagesContext");

export interface PagesContextValue {
  folders: Folder[];
  tags: Tag[];
  recurrenceRules: PageRecurrenceRule[];
  getPage: (id: string) => Promise<Page | null>;
  /** The full page once every write of it from this window has landed, so a read after an
   *  outside change never sees the database without a save of ours that is still on its way. */
  getPageAfterWrites: (id: string) => Promise<Page | null>;
  createPage: (opts: NewPageFields) => Promise<Page>;
  updatePage: (id: string, patch: PageUpdate) => void;
  recordPageOpened: (id: string) => void;
  flushPage: (id: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  clearPendingDescription: (id: string) => Promise<void>;
  softDeletePage: (id: string) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
  /** No DB write: the colour is already persisted (external-calendar recolor writes via the sync
   *  adapter), so this avoids a full workspace reload to repaint one swatch. */
  patchFolderColor: (folderId: string, color: string) => void;
  deleteFolder: (id: string) => Promise<void>;
  softDeleteFolder: (id: string) => Promise<void>;
  restoreFolder: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  movePages: (ids: string[], place: Placement) => Promise<void>;
  /**
   * Bulk complete/uncomplete in one transaction. Optimistic; rolls back and surfaces a per-page
   * error on failure. One write instead of N concurrent updatePage calls, which race the WAL pool
   * and drop some completions. Non-recurring pages only: recurring completion goes through
   * completeRecurringPage.
   */
  setPagesStatus: (ids: string[], status: PageStatus, completedAt: string | null) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  scheduleOnce: (pageId: string, start: string, end?: string) => Promise<void>;
  clearSchedule: (pageId: string) => Promise<void>;
  createRecurrence: (data: NewRecurrenceRule) => Promise<PageRecurrenceRule>;
  updateRecurrence: (ruleId: string, updates: RecurrenceRuleUpdate) => Promise<PageRecurrenceRule>;
  deleteRecurrence: (ruleId: string) => Promise<void>;
  /** The given rules' override rows, regardless of moved position. */
  listOverridesForRules: (ruleIds: string[]) => Promise<import("@pikos/core").PageSchedule[]>;
  expandRecurrenceRange: (
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) => Promise<import("@pikos/core").RawRuleExpansion[]>;
  rescheduleVirtualOccurrence: (
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ) => Promise<void>;
  /** Bumped when an override row changes with no page or rule changing: the calendar's override
   *  fetch is keyed on range and rule set, so an in-place move is otherwise invisible to it. */
  overridesVersion: number;
  /**
   * Complete the head's own occurrence. `head` overrides the state lookup so a sequential run can
   * chain off the previous call's recomputed head. Null when the re-entrancy guard swallowed the
   * call.
   */
  completeRecurringPage: (
    pageId: string,
    head?: PageSummary
  ) => Promise<CompleteRecurringResult | null>;
  /** Complete one rendered occurrence of a synced-origin series, keyed on its original date. Null
   *  when the guard swallowed the call. */
  completeSyncedOccurrence: (input: {
    pageId: string;
    occurrenceDate: string;
    scheduledStart: string;
    scheduledEnd?: string;
  }) => Promise<CompleteRecurringResult | null>;
  completeRecurringToToday: (pageId: string, opts?: GapRunOptions) => Promise<void>;
  skipOccurrences: (pageId: string, dates: string[]) => Promise<() => void>;
  /**
   * Uncomplete a recurring done clone (native or synced) rather than flip its status, which a
   * recompute would revert. Returns true when handled; the caller must not fall through.
   */
  maybeUncompleteRecurringClone: (page: PageSummary, nextStatus: PageStatus) => boolean;
  /**
   * Occurrence-uncomplete of a native recurring head. Returns false (non-recurring, active-synced,
   * or legacy completion) to leave the caller to its plain flip.
   */
  uncompleteRecurringHead: (pageId: string) => Promise<boolean>;
  uncompleteRecurringOrFlip: (pageId: string) => Promise<void>;
  listCompletedPages: (filter: CompletedPagesFilter) => Promise<CompletedPagesResponse>;
  mergePages: (incoming: PageSummary[]) => void;
  searchPages: (query: string, includeCompleted?: boolean) => Promise<SearchResponse>;
  searchTags: (query: string) => Promise<string[]>;
  /** Typed so consumers can branch on err.kind without leaking raw sqlx/Tauri text. */
  pageErrors: Map<string, StorageError>;
  clearPageError: (id: string) => void;
}

const PagesContext = createContext<PagesContextValue | null>(null);

export function PagesProvider({ children }: { children: ReactNode }) {
  const { adapter, eventBus, registerDataLoader, viewCache } = useWorkspaceInternal();
  const { emit } = eventBus;
  const { defaultFolderId } = useAppSettings();

  const {
    folders,
    foldersRef,
    mergePages,
    pagesRef,
    recurrenceRules,
    recurrenceRulesRef,
    setFolders,
    setPages,
    setRecurrenceRules,
    tags,
  } = usePagesStore({ adapter, registerDataLoader, viewCache });

  const {
    cancelPendingWrite,
    clearPageError,
    enqueue,
    flushPage,
    optimistic,
    pageErrors,
    updatePage,
  } = usePageWriteQueue({ adapter, emit, mirror: viewCache.mirror });

  function recordPageOpened(id: string): void {
    const at = recordOpen(id);
    // A lost open time costs a recent-pages entry, never data, so it isn't worth a notice.
    enqueue(id, () => adapter.updatePage(id, { lastOpenedAt: at })).catch((e: unknown) => {
      log.warn(`recording page ${id} opened failed`, e);
    });
  }

  const recurring = useRecurringWrites({
    adapter,
    enqueue,
    pagesRef,
    recurrenceRulesRef,
    setPages,
    setRecurrenceRules,
    updatePage,
  });

  const {
    createFolder,
    deleteFolder,
    patchFolderColor,
    reorderFolders,
    restoreFolder,
    softDeleteFolder,
    updateFolder,
  } = useFolderWrites({ adapter, emit, foldersRef, optimistic, setFolders, setPages });

  const {
    clearPendingDescription,
    createPage: createPageOnly,
    deletePage,
    reorderPages,
    restorePage,
    setPagesStatus,
    softDeletePage,
  } = usePageWrites({
    adapter,
    cancelPendingWrite,
    defaultFolderId,
    emit,
    foldersRef,
    optimistic,
    pagesRef,
    setPages,
  });

  const { clearSchedule, scheduleOnce } = useScheduleWrites({
    adapter,
    optimistic,
    pagesRef,
    patchRecomputedHead: recurring.patchRecomputedHead,
    recurrenceRulesRef,
    setPages,
    setRecurrenceRules,
  });

  async function createPage(opts: NewPageFields): Promise<Page> {
    const page = await createPageOnly(opts);
    viewCache.adoptCreated(page);
    return page;
  }

  function getPage(id: string): Promise<Page | null> {
    return viewCache.body(id);
  }

  function getPageAfterWrites(id: string): Promise<Page | null> {
    return enqueue(id, () => viewCache.body(id));
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

  async function movePages(ids: string[], place: Placement): Promise<void> {
    try {
      const { orders } = await adapter.movePages(ids, place);
      const moved = new Map(orders);
      setPages((prev) =>
        prev.map((p) => {
          const sortOrder = moved.get(p.id);
          return sortOrder === undefined ? p : { ...p, sortOrder };
        })
      );
    } catch (err) {
      const error = toStorageError(err);
      // A neighbour that moved or went since the list loaded: the refresh after every write
      // redraws the list as it is, which says enough. Anything else, the move didn't happen.
      const isStaleList = error.kind === "Conflict" || error.kind === "NotFound";
      log.warn(isStaleList ? "move refused" : "move failed", error);
      if (!isStaleList) postNotice(storageErrorUserMessage(error, "moving pages"));
    }
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
    getPageAfterWrites,
    listCompletedPages,
    listOverridesForRules,
    maybeUncompleteRecurringClone,
    mergePages,
    movePages,
    overridesVersion,
    pageErrors,
    patchFolderColor,
    recordPageOpened,
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
