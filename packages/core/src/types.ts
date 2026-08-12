// ─── Workspace ───────────────────────────────────────────────────────────────
// Multi-workspace: each workspace is a separate SQLite file. The list of known
// workspaces lives in @tauri-apps/plugin-store (JSON config, not SQLite).

export interface Workspace {
  id: string; // UUID
  name: string;
  dbPath: string; // absolute path to the workspace .sqlite file
  createdAt: string; // ISO 8601
  lastOpenedAt: string | null;
}

// ─── Folder ──────────────────────────────────────────────────────────────────

export interface Folder {
  id: string; // UUID
  name: string;
  parentId: string | null; // always null in v1; reserved for nested folders
  sortOrder: number; // manual position in the flat folder list
  color?: string;
  icon?: string;
  // System-managed: drives the placement lock + separate sidebar area.
  isExternalCalendar: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── Page ────────────────────────────────────────────────────────────────────

export type PageStatus = "not_started" | "done";

// 0 = none  1 = urgent  2 = high  3 = medium  4 = low
export type PagePriority = 0 | 1 | 2 | 3 | 4;

export interface Page {
  id: string; // UUID
  folderId: string | null;
  title: string;
  subtitle?: string | null; // one-sentence summary; shown in page list + calendar blocks; in FTS
  content: string; // Tiptap JSON string (NOT markdown)
  // Internal FTS denorm — extracted plain text from Tiptap JSON.
  // Written by the adapter on every content save; never rendered in UI directly.
  contentText?: string;
  status: PageStatus;
  priority: PagePriority;
  tags: string[]; // normalized in tags/page_tags tables; denorm JSON on pages row
  sortOrder: number; // manual position within folder (or inbox)
  scheduledStart?: string | null; // ISO 8601 — denorm of next upcoming page_schedules row
  scheduledEnd?: string | null; // ISO 8601 — denorm of next upcoming page_schedules row
  completedAt?: string | null; // ISO 8601
  links?: string[]; // [[wikilink]] target page UUIDs; stored as JSON array
  parentId?: string | null; // sub-page nesting
  lastOpenedAt?: string | null; // ISO 8601; updated on open → drives recent-pages query
  deletedAt?: string | null; // ISO 8601; NULL = not deleted, set = trashed
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  scheduleLocked: boolean; // derived: active page_sync row owns the schedule → render read-only
  // Derived from the rule's existence. The Today predicate needs it to spare a
  // past synced one-off from overdue while leaving recurring heads alone.
  isRecurring: boolean;
  // Derived from page_sync.sync_state (null for native pages); 'detached' → broken-sync treatment.
  syncState?: "active" | "detached" | "tombstoned" | null;
  // Source/authoring IANA zone (from the schedule/rule). Consumed at render only
  // for synced (locked) pages — they show absolute in the viewer's zone; native floats.
  timezone?: string | null;
  // Completion map for a RECURRING series (native + synced): occurrence-date
  // (YYYY-MM-DD) → done-clone page id. Expansion hides completed occurrences; an
  // uncomplete is routed by the clone id. Null/absent for non-recurring.
  completedOccurrences?: Record<string, string> | null;
  // Dismissed occurrence dates (YYYY-MM-DD) for a recurring series, from skip_set.
  // Excluded from expansion. Null/absent when nothing is skipped.
  skippedOccurrences?: string[] | null;
  // Calendar-owned read-only mirror metadata (from page_sync). Rendered only while
  // the page is locked (active sync); null/absent for native pages.
  mirrorLocation?: string | null;
  mirrorAttendees?: string[] | null; // attendee emails
  // Upstream description change withheld because the user edited the body; drives
  // the editor's passive "calendar description changed" notice. Null = nothing pending.
  pendingDescription?: string | null;
  // Local day this page first synced; absent on a native page. The render floor
  // for a synced series — occurrences before it are expanded from the provider's
  // original DTSTART over a period whose cancellations were never fetched, and
  // sit below the head floor, so they can't be actioned. Same anchor as that
  // floor, so what renders and what can become the head agree.
  syncedSince?: string | null;
}

// ─── PageSchedule ─────────────────────────────────────────────────────────────
// One explicit calendar block (from page_schedules table).
// All-day vs timed is inferred from scheduledStart format:
//   'YYYY-MM-DD'          → all-day (no timezone needed)
//   'YYYY-MM-DDTHH:MM:SS' → timed   (timezone required)
// ruleId + originalDate are only set when this row overrides a virtual
// recurrence occurrence; both are null for plain one-off schedules.

export interface PageSchedule {
  id: string; // UUID
  pageId: string;
  scheduledStart: string; // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS' local wall-clock
  scheduledEnd?: string; // same format; null = single day or 1h default
  timezone?: string; // IANA source zone; metadata only, not consumed by expansion
  ruleId?: string; // links override rows back to their PageRecurrenceRule
  originalDate?: string; // the virtual rrule date this row overrides ('YYYY-MM-DD')
  status: "not_started" | "done" | "skipped";
  createdAt: string; // ISO 8601
}

// ─── PageRecurrenceRule ────────────────────────────────────────────────────────
// One row per recurring page. Calendar expands virtual occurrences via rrule.js.
// Exceptions: rruleExdates (skip) or a page_schedules row with ruleId set (override).

export interface PageRecurrenceRule {
  id: string; // UUID
  pageId: string;
  rrule: string; // iCal RRULE string e.g. 'FREQ=WEEKLY;BYDAY=MO'
  rruleExdates: string[]; // ISO date strings excluded from expansion
  scheduledStart: string; // base occurrence start (local wall-clock)
  scheduledEnd?: string; // base occurrence end; undefined = 1h default
  timezone: string; // IANA source zone; metadata only, not consumed by expansion
  createdAt: string; // ISO 8601
}

/** One raw rrule occurrence from a batched engine expansion — rule-level EXDATEs
 * applied, but NOT the completed/skip exclusion union (that stays client-side). */
export interface RawOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

/** A rule's raw occurrences for a range, keyed by rule id. A rule the engine
 * can't parse is absent from the batch — the caller falls back to the rrule.js
 * expansion for it. */
export interface RawRuleExpansion {
  ruleId: string;
  occurrences: RawOccurrence[];
}

// ─── PageReminder ────────────────────────────────────────────────────────────

export interface PageReminder {
  id: string; // UUID
  pageId: string;
  minutesBefore: number; // 0 = at start, 5, 10, 15, 30, etc.
  createdAt: string; // ISO 8601
}

// ─── FolderNode ───────────────────────────────────────────────────────────────
// In v1, children is always [] (flat list); the type supports nesting for later.

export interface FolderNode extends Folder {
  children: FolderNode[];
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

export interface Tag {
  name: string;
  pageCount: number;
  pageIds: string[];
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  title: string;
  excerpt: string; // plain text snippet from FTS5 — frontend handles highlighting
  matchSource: "title" | "content" | "subtitle" | "both";
  status: PageStatus;
  subtitle?: string | null;
  scheduledDate?: string | null; // ISO 8601 — denorm scheduled_start from pages
  priority: PagePriority;
  tags: string[];
  contentPreview: string; // first ~80 chars of body — fallback line 2 when no metadata
}

export interface SearchResponse {
  results: SearchResult[];
  /** Number of completed pages matching the query (always counted, even when excluded from results). */
  completedCount: number;
}

// ─── FocusSession ─────────────────────────────────────────────────────────────
// Table exists; currently surfaced only in settings usage stats (no timer UI yet).

export interface FocusSession {
  id: string; // UUID
  pageId?: string;
  startedAt: string; // ISO 8601
  endedAt?: string; // ISO 8601; undefined while in progress
  durationS?: number; // denorm seconds; undefined while in progress
}

// ─── PageSummary ─────────────────────────────────────────────────────────
// Lightweight projection for list views — excludes content and contentText.
// Used by listPages / listPagesToday to avoid pulling large Tiptap JSON
// blobs over IPC for every page in a folder.

export type PageSummary = Omit<Page, "content" | "contentText">;

// ─── Recurring completion ────────────────────────────────────────────────────

/** Input for completing the head occurrence of a native recurring page. The
 * completed occurrence is the head's own date (derived server-side); the backend
 * records it in `completed_set` and recomputes the head. */
export interface CompleteRecurringInput {
  pageId: string;
  /** Missed-occurrence dates (YYYY-MM-DD) the "advance to today" gap dialog
   * dismisses — written to the skip-set. Empty for a plain completion. */
  skipDates?: string[];
  /** Synced series only: the client-rendered occurrence being completed, since the
   * reconciler pins the head at the base. Native omits these — its occurrence is the
   * head's own oldest-open date, derived server-side. */
  occurrenceDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
}

export interface CompleteRecurringResult {
  clone: PageSummary;
  /** The head after recompute — advanced to the next open occurrence, or done. */
  head: PageSummary;
}

/** Reverse a recurring completion (native or synced) by occurrence date: deletes the
 * done clone via its back-link, drops the completed-set entry, and recomputes. */
export interface UncompleteRecurringInput {
  pageId: string;
  occurrenceDate: string;
}

/** Dismiss (or, via undo, restore) one recurring occurrence to/from the skip-set
 * (native or synced — the skip-set is user state, distinct from provider EXDATEs). */
export interface SkipOccurrenceInput {
  pageId: string;
  occurrenceDate: string;
}

/** Input for materializing a virtual rrule occurrence at a new time. */
export interface RescheduleVirtualInput {
  ruleId: string;
  /** The rule-generated date being detached (YYYY-MM-DD) — added to exdates. */
  originalDate: string;
  scheduledStart: string;
  scheduledEnd?: string;
  timezone: string;
}

export interface RescheduleVirtualResult {
  /** The independent clone page, scheduled at the new time (denorm set). Null
   *  when the occurrence already had an override row and that row moved in
   *  place — no clone, no exdate change. */
  clone: PageSummary | null;
  /** Post-merge exdates for the rule. */
  ruleExdates: string[];
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface PageFilter {
  folderId?: string | null;
  status?: PageStatus;
  priority?: PagePriority;
  tags?: string[];
  query?: string;
  scheduledAfter?: string; // ISO 8601
  scheduledBefore?: string; // ISO 8601
  /** When true, only pages with a non-null scheduledStart match — used to
   * pull scheduled completed pages into the calendar view without also
   * loading every unscheduled completed page ever created. */
  hasSchedule?: boolean;
}

// ─── Completed pages (lazy-loaded) ──────────────────────────────────────────

export interface CompletedPagesFilter {
  folderId?: string | null; // null = inbox, undefined = all folders
  completedSince?: string; // ISO 8601 date — e.g. today's date for Today view
  limit: number;
  offset: number;
}

export interface CompletedPagesResponse {
  pages: PageSummary[];
  total: number; // total matching count (ignoring limit/offset)
}

// ─── Calendar sync ─────────────────────────────────────────────────────────────

export interface SyncAccount {
  id: string;
  provider: string; // 'caldav' | 'google'
  displayName: string; // email (Google) / server·username (CalDAV)
  authKind: string; // 'basic' | 'oauth'
  createdAt: string;
  // A poll hit a rejected credential. The scheduler skips the account while this is
  // set, so the panel has to surface it — nothing else will.
  reconnectNeeded: boolean;
}

export interface SyncCalendar {
  id: string;
  accountId: string;
  calendarId: string; // provider's calendar identifier
  displayName: string;
  color: string | null; // Pikos palette colour, not provider hex
  enabled: boolean; // per-calendar opt-in
  lastSyncedAt: string | null;
  folderId: string | null; // the calendar's system folder, set while enabled
}

/** An account plus its calendars — the account-centric panel read (getSyncStatus). */
export interface AccountWithCalendars extends SyncAccount {
  calendars: SyncCalendar[];
}

/** One calendar's resync outcome (resyncSyncAccount). */
export interface CalendarSyncResult {
  calendarId: string;
  status: "synced" | "offline" | "reconnectNeeded";
  fullResync: boolean;
}
