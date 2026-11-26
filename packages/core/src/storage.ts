import type {
  AccountWithCalendars,
  BackupEntry,
  CalendarSyncResult,
  ChangeState,
  CompletedCursor,
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompletedWindow,
  CompleteRecurringInput,
  CompleteRecurringResult,
  FocusSession,
  Folder,
  MoveOutcome,
  NotificationHistoryEntry,
  Page,
  PageFilter,
  PageIfNewer,
  PageRecurrenceRule,
  PageReminder,
  PageSchedule,
  PageStatus,
  PageSummary,
  Placement,
  RawRuleExpansion,
  RescheduleVirtualInput,
  RescheduleVirtualResult,
  SearchResponse,
  SkipOccurrenceInput,
  SyncCalendar,
  TagCount,
  TrashedPage,
  UncompleteRecurringInput,
  ViewCounts,
  ViewCursor,
  ViewKey,
  ViewScope,
  ViewWindow,
} from "./types";

// Fields none of which is the caller's to state are excluded from both write shapes.
//
// scheduleLocked (an active page_sync row) and isRecurring (a
// page_recurrence_rules row exists) are derived: a page becomes recurring by
// gaining a rule, not by being written as one.
//
// contentSchemaVersion is stamped by whichever build wrote the content, so
// accepting it from a caller would let a client claim a document shape it did
// not produce.
//
// sortOrder is excluded from NewPage because the backend assigns max+1.
export type NewPage = Omit<
  Page,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "sortOrder"
  | "scheduleLocked"
  | "isRecurring"
  | "contentSchemaVersion"
  | "detachIsReversible"
> & {
  /** Optional override for created_at (used during import to preserve original dates). */
  createdAt?: string;
  /** Optional override for updated_at (used during import to preserve original dates). */
  updatedAt?: string;
};
export type PageUpdate = Partial<
  Omit<
    Page,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "scheduleLocked"
    | "isRecurring"
    | "detachIsReversible"
    | "contentSchemaVersion"
  >
> & {
  /** The body `content` was typed over: a body changed elsewhere since is merged, not overwritten. */
  baseContent?: string | null;
};
// isExternalCalendar is set by the calendar-sync enable path, never by
// createFolder/updateFolder, so both input shapes exclude it.
export type NewFolder = Omit<
  Folder,
  "id" | "createdAt" | "updatedAt" | "sortOrder" | "isExternalCalendar"
>;
export type FolderUpdate = Partial<
  Omit<Folder, "id" | "createdAt" | "updatedAt" | "isExternalCalendar">
>;

export interface NewCaldavConnection {
  baseUrl: string; // autodiscovery starts here
  username: string;
  password: string; // app-specific password
  displayName: string;
}

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

export interface NewPageReminder {
  pageId: string;
  minutesBefore: number;
}

/** One finished focus session. `durationS` is stored rather than derived so a
 *  suspend or a clock change can't rewrite history. */
export interface NewFocusSession {
  pageId: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
}

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

/** Formats the Export panel offers. A SQLite backup is `backupDatabase`, not
 *  an export: it round-trips, the others are one-way renderings. */
export type WorkspaceExportFormat = "csv" | "ics" | "markdown";

export interface WorkspaceExportOptions {
  /** Include events mirrored in from connected calendars. Ones the user has
   *  completed or edited are always included regardless. */
  includeSynced: boolean;
}

export interface WorkspaceWeekActivity {
  week: string;
  created: number;
  edited: number;
  completed: number;
  focus_minutes: number;
}

/** snake_case throughout: this is the backend's serde shape, and renaming the keys here would
 *  only move the translation somewhere less visible. */
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
  /** The withheld description as Tiptap JSON shaped like a seed, addresses linked, or null once
   *  nothing is parked. */
  pendingDescriptionDocument(id: string): Promise<string | null>;
  /** Hides the page from all queries; recoverable with `restorePage`. */
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
  /** Summaries without content; `getPage` has the full page. */
  listPages(filter?: PageFilter): Promise<PageSummary[]>;
  /** Open pages with any schedule row on or before today, sorted by sortOrder. */
  listPagesToday(): Promise<PageSummary[]>;
  /** `orderedIds` is the complete order for `folderId` (null: inbox). */
  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void>;
  /**
   * Set status and completedAt for many pages in one transaction, skipping soft-deleted ids;
   * returns the updated summaries. One atomic write, because N concurrent `updatePage` calls
   * race the WAL pool and drop some completions. Recurring heads must not be passed here (use
   * `completeRecurringPage`).
   */
  setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<PageSummary[]>;
  /** Completed pages, a page of results at a time. */
  listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse>;
  /** The next window of a list after `after`, or from the top; its total on the first window. */
  listView(key: ViewKey, after: ViewCursor | null, limit: number): Promise<ViewWindow>;
  /** A list's ids after `after`, through `through` or to the end: for selecting unloaded rows. */
  listViewIds(
    key: ViewKey,
    after: ViewCursor | null,
    through: ViewCursor | null
  ): Promise<string[]>;
  /** Done pages newest first, a window at a time. `scope` null is every folder, for Today's and
   *  Upcoming's sections, which `since` (a date) limits to pages done on or after it. */
  listCompletedWindow(
    scope: ViewScope | null,
    since: string | null,
    after: CompletedCursor | null,
    limit: number
  ): Promise<CompletedWindow>;
  /** Pages touching the range from `start` (null: no limit) to `end`, UTC instants, placed in
   *  `zone`; done ones too unless `openOnly`. */
  listRange(
    start: string | null,
    end: string,
    zone: string,
    openOnly: boolean
  ): Promise<PageSummary[]>;
  /** Every recurring series' head; finished series too unless `openOnly`; with `since`, only the
   *  heads changed after that change number. */
  listSeriesHeads(openOnly: boolean, since?: number | null): Promise<PageSummary[]>;
  /** The sidebar's counts on `today` (a date) in `zone`. */
  countViews(zone: string, today: string): Promise<ViewCounts>;
  /** Summaries of `ids` that exist and aren't trashed, in the order asked. */
  getPages(ids: string[]): Promise<PageSummary[]>;
  /** The full page, unless the copy held at `known` is still current. */
  getPageIfNewer(id: string, known: number | null): Promise<PageIfNewer>;
  /** Open pages opened before, most recent first, without `exclude`. */
  listRecentPages(exclude: string | null, limit: number): Promise<PageSummary[]>;
  /** Tags on open pages, most used first. */
  listTags(): Promise<TagCount[]>;
  /** The pages, not trashed, whose bodies link to `id`, by title. */
  listBacklinks(id: string): Promise<PageSummary[]>;
  /** Move `ids`, in that order, between two open neighbours in their folder's manual order.
   *  Rejects with a conflict when the neighbours aren't where they were. */
  movePages(ids: string[], place: Placement): Promise<MoveOutcome>;
  /** The change counter, its epoch, and how many changes this process made. */
  changeState(): Promise<ChangeState>;
  /** Title matches rank above content matches. */
  searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse>;
  /** Tag names that start with `query`. */
  searchTags(query: string): Promise<string[]>;

  getFolder(id: string): Promise<Folder | null>;
  createFolder(data: NewFolder): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  /** Soft-deletes the folder and all its pages; recoverable with `restoreFolder`. */
  softDeleteFolder(id: string): Promise<void>;
  /** Restores a soft-deleted folder and all its pages. */
  restoreFolder(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
  reorderFolders(orderedIds: string[]): Promise<void>;

  /** Also refreshes the page's denormalised scheduled_start/end. */
  createPageSchedule(data: NewPageSchedule): Promise<PageSchedule>;
  updatePageSchedule(id: string, updates: PageScheduleUpdate): Promise<PageSchedule>;
  /** Also refreshes the page's denormalised scheduled_start/end. */
  deletePageSchedule(id: string): Promise<void>;
  /** Explicit blocks only, no virtual rrule occurrences. */
  listPageSchedules(pageId: string): Promise<PageSchedule[]>;
  /** The given rules' override rows (`ruleId` set), wherever they were moved to; the calendar
   *  needs them to exclude occurrences moved across weeks. */
  listPageSchedulesForRules(ruleIds: string[]): Promise<PageSchedule[]>;

  /** A page has at most one rule; errors if one exists, so call `getRecurrenceRule` first. */
  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule>;
  updateRecurrenceRule(id: string, updates: RecurrenceRuleUpdate): Promise<PageRecurrenceRule>;
  /** Add EXDATEs to a rule, merged in the database in one transaction, then recompute the head.
   * For provider and manual EXDATE writes; user dismissals use `skipOccurrence`. Never send
   * `updateRecurrenceRule` a full array computed client-side: it races other writers and erases
   * their dates. */
  addRuleExdates(id: string, dates: string[]): Promise<PageRecurrenceRule>;
  removeRuleExdate(id: string, date: string): Promise<PageRecurrenceRule>;
  deleteRecurrenceRule(id: string): Promise<void>;
  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null>;
  /** Rules of non-deleted pages. */
  listRecurrenceRules(): Promise<PageRecurrenceRule[]>;
  /** Raw rrule expansion for the range; see {@link RawRuleExpansion}. The caller applies the
   * completed and skipped exclusions. */
  expandRecurrenceRange(
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ): Promise<RawRuleExpansion[]>;

  /** Complete one occurrence of a recurring page, native or synced: a done clone and a
   * completed-set entry, then the head moves to the next open occurrence (or done). Native
   * completes the head's own occurrence; synced passes the client-rendered virtual
   * (occurrenceDate/scheduledStart). */
  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult>;
  /** Reverse a recurring completion by occurrence date: delete the clone, drop the
   * completed-set entry, recompute the head. */
  uncompleteRecurringOccurrence(data: UncompleteRecurringInput): Promise<void>;
  /** Dismiss one occurrence to the skip-set and recompute the head. The skip-set is user state,
   * distinct from provider EXDATEs. */
  skipOccurrence(data: SkipOccurrenceInput): Promise<void>;
  undoSkipOccurrence(data: SkipOccurrenceInput): Promise<void>;
  /** Heal the display cache of every native recurring series; returns the summaries whose head
   * changed so the caller patches only those. */
  recomputeRecurringSchedules(): Promise<PageSummary[]>;
  /** Materialize a virtual occurrence at a new time: clone the head, schedule the clone and
   * exdate the original date, in one transaction. */
  rescheduleVirtualOccurrence(data: RescheduleVirtualInput): Promise<RescheduleVirtualResult>;

  /** Record a finished focus session. Write-only: the Data panel reads totals through
   *  `getUsageStats`. Refuses a non-positive duration or a page that does not exist, since a
   *  bad row would only surface as a total nobody can explain. */
  createFocusSession(data: NewFocusSession): Promise<FocusSession>;

  createPageReminder(data: NewPageReminder): Promise<PageReminder>;
  /** Sorted by minutesBefore ascending. */
  listPageReminders(pageId: string): Promise<PageReminder[]>;
  deletePageReminder(id: string): Promise<void>;
  /** Resets the page to the global default. */
  deletePageReminders(pageId: string): Promise<void>;
  /** The notification log, newest first: what the scheduler fired and what quiet hours
   * silenced. Read-only, since the Rust scheduler is its only writer. */
  listNotificationHistory(limit: number): Promise<NotificationHistoryEntry[]>;

  /** Validate a CalDAV connection (autodiscovery), then persist the account and its discovered
   * (disabled) calendars; credentials go to the OS keychain. */
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
  /** Tears down the account's synced pages and folders and removes its keychain entry. */
  disconnectSyncAccount(accountId: string): Promise<void>;
  listSyncCalendars(accountId: string): Promise<SyncCalendar[]>;
  /** Enable (create folder and colour) or disable (tear down) a calendar.
   * `syncCalendarId` is the sync_calendar row id, not the provider calendarId. */
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
  /** Same poll from scratch: drops each calendar's cursor so the provider re-sends everything.
   * The repair path when a mirror looks out of date; unchanged events are left untouched. */
  refreshSyncAccount(accountId: string): Promise<CalendarSyncResult[]>;
  getSyncStatus(): Promise<AccountWithCalendars[]>;

  // The workspace data lifecycle methods below read, copy, render or destroy the workspace's
  // own data, so they belong here and not on the platform. The file dialog that shows where a
  // backup landed is the platform's job.
  /** Write a full database backup; resolves to where it landed. */
  backupDatabase(): Promise<string>;
  /** Snapshots sitting beside the workspace, newest first. Written by the
   *  migrator and by imports; this is the only way to read them back. */
  listBackups(): Promise<BackupEntry[]>;
  /** Replace the workspace with a snapshot and restart into it. Never resolves
   *  on success — the process re-execs — so callers must not sequence work
   *  after it. Rejects, with the app still running, when the snapshot is
   *  damaged or was written by a newer build. */
  restoreBackup(fileName: string): Promise<void>;
  /** Snapshot taken before an import so the user can roll back. Best-effort at
   *  the call site — an import must not fail because the backup did. */
  backupBeforeImport(): Promise<void>;
  /** Render the workspace into `format`; resolves to where it landed. */
  exportWorkspace(format: WorkspaceExportFormat, options: WorkspaceExportOptions): Promise<string>;
  /** Write one page as Markdown, for sharing on its own; resolves to its `.md` file. */
  exportPageMarkdown(id: string): Promise<string>;
  /** Aggregate counts for the Data settings panel. `weekStartsOn` buckets the activity chart,
   *  because the counting happens where the rows are and the preference lives with the user. */
  getUsageStats(weekStartsOn: 0 | 1): Promise<WorkspaceUsageStats>;
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
  /** Note what a new workspace's first-run pages are, right after seeding them, so turning on
   *  device sync can tell a workspace nobody has used from one with work in it. */
  recordFirstRunSeed(): Promise<void>;
}
