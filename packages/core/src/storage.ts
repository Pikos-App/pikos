import type {
  AccountWithCalendars,
  CalendarSyncResult,
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompleteRecurringInput,
  CompleteRecurringResult,
  FocusSession,
  Folder,
  NotificationHistoryEntry,
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
  TrashedPage,
  UncompleteRecurringInput,
} from "./types";

// ─── Page input helpers ───────────────────────────────────────────────────────
// sort_order excluded — backend assigns max+1 on create

// scheduleLocked (active page_sync row) and isRecurring (a page_recurrence_rules
// row exists) are both derived, never inputs — excluded from both write shapes.
// A page becomes recurring by gaining a rule, not by being written as one.
export type NewPage = Omit<
  Page,
  "id" | "createdAt" | "updatedAt" | "sortOrder" | "scheduleLocked" | "isRecurring"
> & {
  /** Optional override for created_at (used during import to preserve original dates). */
  createdAt?: string;
  /** Optional override for updated_at (used during import to preserve original dates). */
  updatedAt?: string;
};
export type PageUpdate = Partial<
  Omit<Page, "id" | "createdAt" | "updatedAt" | "scheduleLocked" | "isRecurring">
>;
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

// ─── Focus session input helpers ─────────────────────────────────────────────

/** One finished focus session. The caller times it and writes on stop, so the
 *  wall-clock span is the user's, not the backend's — `durationS` is stored
 *  rather than derived so a suspend or a clock change can't rewrite history. */
export interface NewFocusSession {
  pageId: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
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

// ─── Workspace data lifecycle ─────────────────────────────────────────────────

/** Formats the Export panel offers. A SQLite backup is `backupDatabase`, not
 *  an export: it round-trips, the others are one-way renderings. */
export type WorkspaceExportFormat = "csv" | "ics" | "markdown";

export interface WorkspaceExportOptions {
  /** Include events mirrored in from connected calendars. Ones the user has
   *  completed or edited are always included regardless. */
  includeSynced: boolean;
}

/** One bar of the "what you did" chart on the Data settings panel. */
export interface WorkspaceWeekActivity {
  week: string;
  created: number;
  edited: number;
  completed: number;
  focus_minutes: number;
}

/**
 * Aggregate counts for the Data settings panel. snake_case throughout: this is
 * the backend's serde shape, and renaming the keys here would only move the
 * translation somewhere less visible.
 */
export interface WorkspaceUsageStats {
  total_pages: number;
  total_folders: number;
  total_schedules: number;
  total_focus_sessions: number;
  total_focus_minutes: number;
  total_completed: number;
  total_words: number;
  weekly_activity: WorkspaceWeekActivity[];
  has_folders: boolean;
  has_schedules: boolean;
  has_recurring: boolean;
  has_focus_sessions: boolean;
  has_subtasks: boolean;
  has_tags: boolean;
  has_priorities: boolean;
  has_reminders: boolean;
  has_calendar_sync: boolean;
  first_page_date: string | null;
}

export interface StorageAdapter {
  // Pages
  getPage(id: string): Promise<Page | null>;
  createPage(data: NewPage): Promise<Page>;
  updatePage(id: string, updates: PageUpdate): Promise<Page>;
  deletePage(id: string): Promise<void>;
  /**
   * Drop a withheld upstream description once the user has resolved its notice,
   * by folding it into the body or by deciding against it. Clears only that
   * column: the seed hash stays stale on purpose, so the body keeps reading as
   * the user's and the next upstream change parks rather than overwrites.
   */
  clearPendingDescription(id: string): Promise<void>;
  /** Soft-delete: sets deleted_at timestamp. Page is hidden from all queries but recoverable. */
  softDeletePage(id: string): Promise<void>;
  restorePage(id: string): Promise<void>;
  /** The trash, newest deletion first: soft-deleted pages the retention sweep
   *  has not destroyed yet. Restoring one is `restorePage`; destroying one is
   *  `deletePage`, which is also the path that declines to destroy a mirror. */
  listTrashedPages(): Promise<TrashedPage[]>;
  /**
   * Destroy trashed pages deleted more than `olderThanDays` ago; returns how
   * many actually went. `0` empties the trash — the same sweep, not a second
   * path. A synced mirror is kept and stays tombstoned: its row carries the
   * suppression that stops the next sync pass re-creating the event, so the
   * count can be lower than what the trash listed.
   */
  purgeTrashedPages(olderThanDays: number): Promise<number>;
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
  /** The given rules' override rows (`ruleId` set), regardless of moved position
   *  — feeds the calendar's occurrence-exclusion set for cross-week moves. */
  listPageSchedulesForRules(ruleIds: string[]): Promise<PageSchedule[]>;

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
   * the client-rendered virtual (occurrenceDate/scheduledStart). */
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

  // Focus sessions
  /** Record a finished focus session. Write-only: the Data panel reads the
   *  totals through `getUsageStats`, which aggregates the table rather than
   *  listing it. Refuses a non-positive duration or a page that does not exist —
   *  a bad row here would only ever surface as a total nobody can explain. */
  createFocusSession(data: NewFocusSession): Promise<FocusSession>;

  // Reminders
  createPageReminder(data: NewPageReminder): Promise<PageReminder>;
  /** All reminders for a page, sorted by minutesBefore ascending. */
  listPageReminders(pageId: string): Promise<PageReminder[]>;
  deletePageReminder(id: string): Promise<void>;
  /** Delete all reminders for a page (reset to global default). */
  deletePageReminders(pageId: string): Promise<void>;
  /** The notification log, newest first, capped at `limit` — what the scheduler
   * fired, and what quiet hours silenced. Read-only: the log's only writer is
   * the Rust scheduler, so there is no create/update counterpart here. */
  listNotificationHistory(limit: number): Promise<NotificationHistoryEntry[]>;

  // Calendar sync
  /** Validate a CalDAV connection (autodiscovery), then persist the account +
   * its discovered (disabled) calendars; credentials go to the OS keychain. */
  connectCaldavAccount(data: NewCaldavConnection): Promise<AccountWithCalendars>;
  /** Replace a CalDAV account's stored password and clear `reconnectNeeded`. Takes
   * no server URL or username: both come from the keychain blob, so a reconnect
   * can't drift the account's identity and mint a duplicate instead of repairing. */
  reconnectCaldavAccount(accountId: string, password: string): Promise<AccountWithCalendars>;
  /** Run the Google OAuth grant (opens the user's browser) and persist the
   * account + its discovered (disabled) calendars. Resolves only once the user
   * finishes in the browser, so callers must show a waiting state. */
  connectGoogleAccount(): Promise<AccountWithCalendars>;
  /** Whether this build ships the Google OAuth client. False hides the option
   * rather than offering a connect that can only fail. */
  googleSyncAvailable(): Promise<boolean>;
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
  /** Record a colour the user picked, from the panel or the sidebar. Unlike the one
   * `toggleSyncCalendar` assigns, this latches: re-discovery stops following the
   * provider's colour for this calendar. */
  setSyncCalendarColor(syncCalendarId: string, color: string): Promise<SyncCalendar>;
  /** Poll every enabled calendar on the account; returns per-calendar outcomes. */
  resyncSyncAccount(accountId: string): Promise<CalendarSyncResult[]>;
  /** Same poll, but from scratch: drops each calendar's cursor first so the
   * provider re-sends everything. The repair path when a mirror looks out of
   * date; re-delivered events that haven't changed are left untouched. */
  refreshSyncAccount(accountId: string): Promise<CalendarSyncResult[]>;
  /** Account-centric status tree for the Calendar Sync panel. */
  getSyncStatus(): Promise<AccountWithCalendars[]>;

  // Workspace data lifecycle
  // These are storage operations, not shell ones: they read, copy, render or
  // destroy the workspace's own data. The file dialog that shows the user
  // where a backup landed is the platform's job; producing it is this one's.
  /** Write a full database backup; resolves to where it landed. */
  backupDatabase(): Promise<string>;
  /** Snapshot taken before an import so the user can roll back. Best-effort at
   *  the call site — an import must not fail because the backup did. */
  backupBeforeImport(): Promise<void>;
  /** Render the workspace into `format`; resolves to where it landed. */
  exportWorkspace(format: WorkspaceExportFormat, options: WorkspaceExportOptions): Promise<string>;
  /** Aggregate counts for the Data settings panel. */
  getUsageStats(): Promise<WorkspaceUsageStats>;
  /** Dev tool: empty every table so a seed scenario can start from nothing.
   *  Leaves the database file and the workspace registry in place — unlike
   *  `wipeAllData`, this is a truncate, not an uninstall. */
  resetWorkspaceData(): Promise<void>;
  /** Destroy the workspace: database, backups and assets. The caller relaunches
   *  afterwards, so nothing here has to leave the app in a usable state. */
  wipeAllData(): Promise<void>;
  /** Drop the calendar-sync credentials this workspace's accounts hold in the
   *  OS keychain. Must run before `wipeAllData` — the account ids it keys on
   *  live in the database that call destroys. */
  releaseSyncCredentials(): Promise<void>;
}
