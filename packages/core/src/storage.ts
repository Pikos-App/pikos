import type {
  AccountWithCalendars,
  CalendarSyncResult,
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompleteRecurringInput,
  CompleteRecurringResult,
  Folder,
  Page,
  PageFilter,
  PageRecurrenceRule,
  PageReminder,
  PageSchedule,
  PageStatus,
  PageSummary,
  RawRuleExpansion,
  RescheduleVirtualInput,
  RescheduleVirtualResult,
  SearchResponse,
  SkipOccurrenceInput,
  SyncCalendar,
  UncompleteRecurringInput,
} from "./types";

// ─── Page input helpers ───────────────────────────────────────────────────────
// sort_order excluded — backend assigns max+1 on create

// scheduleLocked is derived from sync state (active page_sync row), never an
// input — so it's excluded from both write shapes.
export type NewPage = Omit<
  Page,
  "id" | "createdAt" | "updatedAt" | "sortOrder" | "scheduleLocked"
> & {
  /** Optional override for created_at (used during import to preserve original dates). */
  createdAt?: string;
  /** Optional override for updated_at (used during import to preserve original dates). */
  updatedAt?: string;
};
export type PageUpdate = Partial<Omit<Page, "id" | "createdAt" | "updatedAt" | "scheduleLocked">>;
// isExternalCalendar is system-managed (set by the calendar-sync enable path),
// never via createFolder/updateFolder — so it's excluded from both input shapes.
export type NewFolder = Omit<
  Folder,
  "id" | "createdAt" | "updatedAt" | "sortOrder" | "isExternalCalendar"
>;
export type FolderUpdate = Partial<
  Omit<Folder, "id" | "createdAt" | "updatedAt" | "isExternalCalendar">
>;

// ─── Calendar-sync input helpers ──────────────────────────────────────────────

export interface NewCaldavConnection {
  baseUrl: string; // autodiscovery starts here
  username: string;
  password: string; // app-specific password
  displayName: string;
}

// ─── Schedule input helpers ───────────────────────────────────────────────────

export interface NewPageSchedule {
  pageId: string;
  scheduledStart: string; // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS'
  scheduledEnd?: string;
  timezone?: string; // IANA; required for timed events
  ruleId?: string; // set only when materialising an rrule override
  originalDate?: string; // the virtual date being overridden
}

export interface PageScheduleUpdate {
  scheduledStart?: string;
  scheduledEnd?: string | null;
  status?: PageSchedule["status"];
}

// ─── Reminder input helpers ──────────────────────────────────────────────────

export interface NewPageReminder {
  pageId: string;
  minutesBefore: number;
}

// ─── Recurrence rule input helpers ────────────────────────────────────────────

export interface NewRecurrenceRule {
  pageId: string;
  rrule: string;
  rruleExdates?: string[];
  scheduledStart: string;
  scheduledEnd?: string;
  timezone: string;
}

export interface RecurrenceRuleUpdate {
  rrule?: string;
  rruleExdates?: string[];
  scheduledStart?: string;
  scheduledEnd?: string | null;
  timezone?: string;
}

// ─── StorageAdapter ───────────────────────────────────────────────────────────

export interface StorageAdapter {
  // Pages
  getPage(id: string): Promise<Page | null>;
  createPage(data: NewPage): Promise<Page>;
  updatePage(id: string, updates: PageUpdate): Promise<Page>;
  deletePage(id: string): Promise<void>;
  /** Soft-delete: sets deleted_at timestamp. Page is hidden from all queries but recoverable. */
  softDeletePage(id: string): Promise<void>;
  restorePage(id: string): Promise<void>;
  /** List pages without content — use getPage() for full content. */
  listPages(filter?: PageFilter): Promise<PageSummary[]>;
  /** Pages with any page_schedules row <= today, status != done, sorted by sortOrder. */
  listPagesToday(): Promise<PageSummary[]>;
  /** orderedIds = complete ordered list for that folderId (null = inbox/no folder) */
  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void>;
  /**
   * Bulk-set status (+ completedAt) for many pages in ONE transaction. Backs
   * multi-select complete/uncomplete (Cmd+A → Space) — a single atomic write
   * instead of N concurrent updatePage calls that race the WAL pool and drop
   * some completions. Skips soft-deleted ids; returns the updated summaries.
   * Recurring heads must not be passed here (use completeRecurringPage).
   */
  setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<PageSummary[]>;
  /** Paginated completed pages — lazy-loaded when the "Completed" section is expanded. */
  listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse>;
  /** Unified FTS5 search — title matches ranked above content matches via bm25(). */
  searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse>;
  /** Returns tag names whose prefix matches query — for autocomplete. */
  searchTags(query: string): Promise<string[]>;

  // Folders
  getFolder(id: string): Promise<Folder | null>;
  createFolder(data: NewFolder): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  /** Soft-delete: sets deleted_at on folder and all its pages. Recoverable via restoreFolder. */
  softDeleteFolder(id: string): Promise<void>;
  /** Restore a soft-deleted folder and all its pages by clearing deleted_at. */
  restoreFolder(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
  reorderFolders(orderedIds: string[]): Promise<void>;

  // Schedules
  /** Insert a block. Also refreshes pages.scheduled_start/end denorm. */
  createPageSchedule(data: NewPageSchedule): Promise<PageSchedule>;
  updatePageSchedule(id: string, updates: PageScheduleUpdate): Promise<PageSchedule>;
  /** Remove a block. Also refreshes pages.scheduled_start/end denorm. */
  deletePageSchedule(id: string): Promise<void>;
  /** All explicit blocks for a page (no virtual rrule occurrences). */
  listPageSchedules(pageId: string): Promise<PageSchedule[]>;
  /** All blocks whose date range overlaps [start, end] (YYYY-MM-DD). */
  listPageSchedulesRange(start: string, end: string): Promise<PageSchedule[]>;

  // Recurrence rules
  /** A page has at most one rule. Errors if a rule already exists — call getRecurrenceRule first. */
  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule>;
  updateRecurrenceRule(id: string, updates: RecurrenceRuleUpdate): Promise<PageRecurrenceRule>;
  /** Add EXDATEs to a rule, merged DB-side (read-merge-write in one transaction),
   * then recompute the head. Native user dismissals use skipOccurrence; this is for
   * provider/manual EXDATE writes. Never updateRecurrenceRule with a full array
   * computed client-side, which races other writers and erases their dates. */
  addRuleExdates(id: string, dates: string[]): Promise<PageRecurrenceRule>;
  /** Remove exactly one EXDATE from a rule's current set, then recompute. */
  removeRuleExdate(id: string, date: string): Promise<PageRecurrenceRule>;
  deleteRecurrenceRule(id: string): Promise<void>;
  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null>;
  /** All recurrence rules (for non-deleted pages). */
  listRecurrenceRules(): Promise<PageRecurrenceRule[]>;
  /** Batched raw rrule expansion for the visible range via the Rust engine — see
   * {@link RawRuleExpansion}. The completed/skip exclusion union is applied by the
   * caller, not here. */
  expandRecurrenceRange(
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ): Promise<RawRuleExpansion[]>;

  // Recurring completion
  /** Complete one occurrence of a recurring page (native or synced): done clone +
   * completed-set entry, then recompute the head onto the next open occurrence (or
   * done). Native completes the head's own occurrence (server-derived); synced passes
   * the client-rendered virtual (occurrenceDate/scheduledStart). Gap dismissals go to
   * skipDates. */
  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult>;
  /** Reverse a recurring completion (native or synced) by occurrence date (delete the
   * clone via its back-link, drop the completed-set entry, recompute the head). */
  uncompleteRecurringOccurrence(data: UncompleteRecurringInput): Promise<void>;
  /** Dismiss one recurring occurrence to the skip-set, recomputing the head (native or
   * synced — the skip-set is user state, distinct from provider EXDATEs). */
  skipOccurrence(data: SkipOccurrenceInput): Promise<void>;
  /** Undo a skip: drop the skip-set entry and recompute. */
  undoSkipOccurrence(data: SkipOccurrenceInput): Promise<void>;
  /** Heal the display cache for every native recurring series on load; returns the
   * summaries whose head materially changed so the caller patches only those. */
  recomputeRecurringSchedules(): Promise<PageSummary[]>;
  /** Materialize a virtual occurrence at a new time: clone head + schedule the
   * clone + exdate the original date, in ONE transaction. */
  rescheduleVirtualOccurrence(data: RescheduleVirtualInput): Promise<RescheduleVirtualResult>;

  // Reminders
  createPageReminder(data: NewPageReminder): Promise<PageReminder>;
  /** All reminders for a page, sorted by minutesBefore ascending. */
  listPageReminders(pageId: string): Promise<PageReminder[]>;
  deletePageReminder(id: string): Promise<void>;
  /** Delete all reminders for a page (reset to global default). */
  deletePageReminders(pageId: string): Promise<void>;

  // Calendar sync
  /** Validate a CalDAV connection (autodiscovery), then persist the account +
   * its discovered (disabled) calendars; credentials go to the OS keychain. */
  connectCaldavAccount(data: NewCaldavConnection): Promise<AccountWithCalendars>;
  /** Tear down the account's synced pages/folders and remove its keychain entry. */
  disconnectSyncAccount(accountId: string): Promise<void>;
  listSyncCalendars(accountId: string): Promise<SyncCalendar[]>;
  /** Enable (materialize folder + colour) or disable (teardown) a calendar.
   * `syncCalendarId` is the sync_calendar ROW id, not the provider calendarId. */
  toggleSyncCalendar(
    syncCalendarId: string,
    enabled: boolean,
    color: string | null
  ): Promise<SyncCalendar>;
  /** Poll every enabled calendar on the account; returns per-calendar outcomes. */
  resyncSyncAccount(accountId: string): Promise<CalendarSyncResult[]>;
  /** Account-centric status tree for the Calendar Sync panel. */
  getSyncStatus(): Promise<AccountWithCalendars[]>;
}
