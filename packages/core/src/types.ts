// @pikos/core — central type definitions
// No Tauri / React / DOM dependencies — safe to import in tests and packages.

// ─── Workspace ───────────────────────────────────────────────────────────────
// Multi-workspace: each workspace is a separate SQLite file. The list of known
// workspaces lives in @tauri-apps/plugin-store (JSON config, not SQLite).

export interface Workspace {
  id: string; // UUID, stable across renames
  name: string; // display name (user-editable)
  dbPath: string; // absolute path to the workspace .sqlite file
  createdAt: string; // ISO 8601
  lastOpenedAt: string | null;
}

// ─── Folder ──────────────────────────────────────────────────────────────────
// v1: flat list only — parentId is always null. Schema supports nesting for later.

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
  tags: string[]; // stored as JSON array in SQLite
  sortOrder: number; // manual position within folder (or inbox)
  scheduledStart?: string | null; // ISO 8601 — denorm of next upcoming page_schedules row
  scheduledEnd?: string | null; // ISO 8601 — denorm of next upcoming page_schedules row
  completedAt?: string | null; // ISO 8601
  links?: string[]; // [[wikilink]] target page UUIDs; stored as JSON array
  parentId?: string | null; // sub-page nesting (GOO-12, max 3 levels)
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

// ─── FolderNode ───────────────────────────────────────────────────────────────
// Used by buildFolderTree() in packages/core/src/page.ts.
// In v1, children is always [] (flat list); the type supports nesting for later.

export interface FolderNode extends Folder {
  children: FolderNode[];
}

// ─── Tag ──────────────────────────────────────────────────────────────────────
// Derived at query time — not stored as a separate table.

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
// Recorded by the built-in focus timer (GOO-78).
// page_id is optional — timer can run without a page association.
// Sessions < 10s are auto-discarded; never written to DB.

export interface FocusSession {
  id: string; // UUID
  pageId?: string; // optional page being worked on
  startedAt: string; // ISO 8601
  endedAt?: string; // ISO 8601; undefined while in progress
  durationS?: number; // denorm seconds; undefined while in progress
}

// ─── PageSummary ─────────────────────────────────────────────────────────
// Lightweight projection for list views — excludes content and contentText.
// Used by listPageSummaries / listPageSummariesToday to avoid pulling large
// Tiptap JSON blobs over IPC for every page in a folder.

export type PageSummary = Omit<Page, "content" | "contentText">;

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface PageFilter {
  folderId?: string | null;
  status?: PageStatus;
  priority?: PagePriority;
  tags?: string[];
  query?: string;
  scheduledAfter?: string; // ISO 8601
  scheduledBefore?: string; // ISO 8601
}
