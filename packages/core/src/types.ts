import type { Folder } from "./generated/Folder";
import type { PageSummary } from "./generated/PageSummary";
import type { SearchResult } from "./generated/SearchResult";

export interface Workspace {
  id: string; // UUID
  name: string;
  dbPath: string; // absolute path to the workspace .sqlite file
  createdAt: string; // ISO 8601
  lastOpenedAt: string | null;
}

// Wire types are generated from the Rust structs that produce them (scripts/gen-ts-bindings.sh)
// and re-exported here so consumers keep one import path and the shapes cannot drift.
export type { BackupEntry } from "./generated/BackupEntry";
export type { BackupKind } from "./generated/BackupKind";
export type { ChangeState } from "./generated/ChangeState";
export type { CompletedCursor } from "./generated/CompletedCursor";
export type { CompletedWindow } from "./generated/CompletedWindow";
export type { DateBounds } from "./generated/DateBounds";
export type { FocusSession } from "./generated/FocusSession";
export type { Folder } from "./generated/Folder";
export type { MoveOutcome } from "./generated/MoveOutcome";
export type { NotificationHistoryEntry } from "./generated/NotificationHistoryEntry";
export type { Page } from "./generated/Page";
export type { PageIfNewer } from "./generated/PageIfNewer";
export type { PageRecurrenceRule } from "./generated/PageRecurrenceRule";
export type { PageReminder } from "./generated/PageReminder";
export type { PageSchedule } from "./generated/PageSchedule";
export type { PageSummary } from "./generated/PageSummary";
export type { Placement } from "./generated/Placement";
export type { SearchResult } from "./generated/SearchResult";
export type { TagCount } from "./generated/TagCount";
export type { TrashedPage } from "./generated/TrashedPage";
export type { ViewCounts } from "./generated/ViewCounts";
export type { ViewCursor } from "./generated/ViewCursor";
export type { ViewKey } from "./generated/ViewKey";
export type { ViewScope } from "./generated/ViewScope";
export type { ViewSort } from "./generated/ViewSort";
export type { ViewWindow } from "./generated/ViewWindow";

export type PageStatus = "not_started" | "done";

// 0 none, 1 urgent, 2 high, 3 medium, 4 low
export type PagePriority = 0 | 1 | 2 | 3 | 4;

/**
 * The Tiptap document schema this build writes and can safely read.
 *
 * Mirrors `pikos_db::CONTENT_SCHEMA_VERSION`, which is the authority since the database
 * outlives any one client. A test in `crates/pikos-db` reads this file and fails if the two
 * drift apart.
 */
export const CONTENT_SCHEMA_VERSION = 2;

/** Rule-level EXDATEs are applied; the completed and skip exclusions are not (the client
 * applies them). */
export interface RawOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

/** A rule's raw occurrences for a range. A rule the engine can't parse is absent from the
 * batch, and the caller falls back to the rrule.js expansion for it. */
export interface RawRuleExpansion {
  ruleId: string;
  occurrences: RawOccurrence[];
}

// `children` is always [] today (a flat list); the type allows nesting.
export interface FolderNode extends Folder {
  children: FolderNode[];
}

export interface Tag {
  name: string;
  pageCount: number;
  pageIds: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  /** Completed pages matching the query, counted even when excluded from `results`. */
  completedCount: number;
  /** The query matched more pages than search scanned, so `completedCount` may be short. */
  completedCountCapped: boolean;
}

/** Completes one occurrence of a recurring page; the backend records it in `completed_set` and
 * recomputes the head. */
export interface CompleteRecurringInput {
  pageId: string;
  /** Synced series only: the client-rendered occurrence being completed, since the reconciler
   * pins the head at the base. Native omits these; its occurrence is the head's own
   * oldest-open date, derived server-side. */
  occurrenceDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  /** The occurrence the caller last saw as open. Supplied, the completion applies to
   * that occurrence or to nothing: already done returns its clone, and a series that
   * moved on for any other reason is refused rather than advanced again. Guards a
   * second writer (the CLI) against the desktop, whose in-flight guard it can't see. */
  expectedOccurrenceDate?: string;
}

export interface CompleteRecurringResult {
  clone: PageSummary;
  /** The head after recompute — advanced to the next open occurrence, or done. */
  head: PageSummary;
}

/** Reverses a recurring completion by occurrence date. */
export interface UncompleteRecurringInput {
  pageId: string;
  occurrenceDate: string;
}

/** Dismisses (or, undone, restores) one occurrence. The skip-set is user state, distinct from
 * provider EXDATEs. */
export interface SkipOccurrenceInput {
  pageId: string;
  occurrenceDate: string;
}

export interface RescheduleVirtualInput {
  ruleId: string;
  /** The rule-generated date being detached (YYYY-MM-DD), added to exdates. */
  originalDate: string;
  scheduledStart: string;
  scheduledEnd?: string;
  timezone: string;
}

export interface RescheduleVirtualResult {
  /** Null when the occurrence already had an override row and that row moved in place: no
   *  clone, no exdate change. */
  clone: PageSummary | null;
  /** The rule's exdates after the merge. */
  ruleExdates: string[];
}

export interface PageFilter {
  folderId?: string | null;
  status?: PageStatus;
  priority?: PagePriority;
  tags?: string[];
  query?: string;
  scheduledAfter?: string; // ISO 8601
  scheduledBefore?: string; // ISO 8601
  /** Only pages with a scheduledStart match, so the calendar can pull scheduled completed pages
   * without loading every unscheduled one. */
  hasSchedule?: boolean;
}

export interface CompletedPagesFilter {
  folderId?: string | null; // null = inbox, undefined = all folders
  completedSince?: string; // ISO 8601 date
  limit: number;
  offset: number;
}

export interface CompletedPagesResponse {
  pages: PageSummary[];
  total: number; // matching count, ignoring limit/offset
}

export interface SyncAccount {
  id: string;
  provider: string; // 'caldav' | 'google'
  displayName: string; // email (Google) / server·username (CalDAV)
  authKind: string; // 'basic' | 'oauth'
  createdAt: string;
  // A poll hit a rejected credential. The scheduler skips the account while this is set, so the
  // panel has to surface it.
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
  // Pages left behind when the calendar was unsynced. Re-enabling re-links them and takes back
  // their title, time and folder, so the toggle confirms first, and only when this is above zero.
  detachedPages: number;
}

/** An account plus its calendars, as `getSyncStatus` returns it. */
export interface AccountWithCalendars extends SyncAccount {
  calendars: SyncCalendar[];
}

export interface CalendarSyncResult {
  calendarId: string;
  status: "synced" | "offline" | "reconnectNeeded";
  fullResync: boolean;
}
