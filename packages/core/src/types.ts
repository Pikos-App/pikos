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
  timezone?: string; // IANA e.g. 'America/New_York'; required for timed events
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
  timezone: string; // IANA timezone — required for DST-correct expansion
  createdAt: string; // ISO 8601
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

/** Input for completing a recurring page (clone-and-advance). */
export interface CompleteRecurringInput {
  pageId: string;
  nextScheduledStart: string | null;
  nextScheduledEnd: string | null;
  /** Rule to advance the exdates on, folded into the completion transaction so
   * it's atomic and avoids a second concurrent write (which deadlocks the WAL
   * pool with SQLITE_BUSY). Omit when no exdate change is needed. */
  ruleId?: string | null;
  /** Dates to ADD to `ruleId`'s exdates — merged into the current row inside
   * the transaction. A full replacement array is deliberately not accepted: it
   * would erase exdates persisted after this snapshot was computed (an
   * interleaved skip or another completion), resurrecting their occurrences.
   * Ignored unless `ruleId` is set. */
  addExdates?: string[] | null;
}

export interface CompleteRecurringResult {
  clone: PageSummary;
  head: PageSummary;
  /** Post-merge exdates when `ruleId` was supplied — sync local rule state from
   * this, not from a locally computed array. */
  ruleExdates?: string[] | null;
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
  /** The independent clone page, scheduled at the new time (denorm set). */
  clone: PageSummary;
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
