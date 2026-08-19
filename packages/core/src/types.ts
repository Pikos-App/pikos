import type { Folder } from "./generated/Folder";
import type { PageSummary } from "./generated/PageSummary";
import type { SearchResult } from "./generated/SearchResult";

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

// ─── Page ────────────────────────────────────────────────────────────────────

// Wire types are generated from the Rust structs that produce them — see
// scripts/gen-ts-bindings.sh. Re-exported here so consumers keep one import path
// and the shapes cannot drift from the backend.
export type { FocusSession } from "./generated/FocusSession";
export type { Folder } from "./generated/Folder";
export type { NotificationHistoryEntry } from "./generated/NotificationHistoryEntry";
export type { Page } from "./generated/Page";
export type { PageRecurrenceRule } from "./generated/PageRecurrenceRule";
export type { PageReminder } from "./generated/PageReminder";
export type { PageSchedule } from "./generated/PageSchedule";
export type { PageSummary } from "./generated/PageSummary";
export type { SearchResult } from "./generated/SearchResult";
export type { TrashedPage } from "./generated/TrashedPage";

export type PageStatus = "not_started" | "done";

// 0 = none  1 = urgent  2 = high  3 = medium  4 = low
export type PagePriority = 0 | 1 | 2 | 3 | 4;

// ─── PageSchedule ─────────────────────────────────────────────────────────────
// One explicit calendar block (from page_schedules table).
// All-day vs timed is inferred from scheduledStart format:
//   'YYYY-MM-DD'          → all-day (no timezone needed)
//   'YYYY-MM-DDTHH:MM:SS' → timed   (timezone required)
// ruleId + originalDate are only set when this row overrides a virtual
// recurrence occurrence; both are null for plain one-off schedules.

// ─── PageRecurrenceRule ────────────────────────────────────────────────────────
// One row per recurring page. Calendar expands virtual occurrences via rrule.js.
// Exceptions: rruleExdates (skip) or a page_schedules row with ruleId set (override).

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

export interface SearchResponse {
  results: SearchResult[];
  /** Number of completed pages matching the query (always counted, even when excluded from results). */
  completedCount: number;
}

// ─── FocusSession ─────────────────────────────────────────────────────────────
// The shape was hand-written and speculative while nothing wrote a row — every
// field past `id` optional, for an in-progress session the table never held. The
// writer only ever inserts finished sessions, so the generated type (re-exported
// above) is the shape now, and the running one lives in the timer's own state.

// ─── PageSummary ─────────────────────────────────────────────────────────
// Lightweight projection for list views — excludes content and contentText.
// Used by listPages / listPagesToday to avoid pulling large Tiptap JSON
// blobs over IPC for every page in a folder.

// ─── Recurring completion ────────────────────────────────────────────────────

/** Input for completing the head occurrence of a native recurring page. The
 * completed occurrence is the head's own date (derived server-side); the backend
 * records it in `completed_set` and recomputes the head. */
export interface CompleteRecurringInput {
  pageId: string;
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
  // Pages left behind when the calendar was unsynced. Re-enabling re-links them and
  // takes back their title, time, and folder, so the toggle confirms first — and
  // stays instant at zero, which is every calendar that was never on.
  detachedPages: number;
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
