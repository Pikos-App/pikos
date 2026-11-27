// In-memory StorageAdapter for tests, injected via VITE_TEST_MODE.

import { StorageError } from "../errors";
import type {
  FolderUpdate,
  NewCaldavConnection,
  NewFocusSession,
  NewFolder,
  NewPage,
  NewPageReminder,
  NewPageSchedule,
  NewRecurrenceRule,
  PageScheduleUpdate,
  PageUpdate,
  RecurrenceRuleUpdate,
  StorageAdapter,
  WorkspaceExportFormat,
  WorkspaceExportOptions,
  WorkspaceUsageStats,
} from "../storage";
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
  SearchResult,
  SkipOccurrenceInput,
  SyncAccount,
  SyncCalendar,
  TagCount,
  TrashedPage,
  UncompleteRecurringInput,
  ViewCounts,
  ViewCursor,
  ViewKey,
  ViewScope,
  ViewWindow,
} from "../types";
import { CONTENT_SCHEMA_VERSION } from "../types";
import { dateKey, formatDateOnly, nowLocalISO, parseLocalISO } from "../utils/dates";
import { extractText } from "../utils/extractText";
import { isDone, isOpen } from "../utils/page";
import { linkTargets } from "../utils/pageLinks";
import { oldestOpenOccurrence, rawExpandRule } from "../utils/recurrence";
import { ftsTokens, mirrorSearchText } from "../utils/search";
import {
  countStarting,
  dayAfter,
  listCompletedOf,
  listRangeOf,
  listViewIdsOf,
  listViewOf,
  ORDER_SPACING,
  UPCOMING_DAYS,
} from "./mockViews";

/**
 * Command-layer guard messages, mirrored verbatim from the Rust writers so a mis-routed write
 * fails identically in test mode and in prod. `guardMessages.test.ts` checks this table
 * against the Rust source and sweeps the writers for refusals missing from it.
 */
export const MIRRORED_GUARD_MESSAGES = {
  createdInCalendarFolder: "Pages cannot be created in an external calendar folder",
  externalFolderLocked:
    "External calendar folders are system-managed — use the Calendar Sync settings to disconnect.",
  intoCalendarFolder: "Pages cannot be moved into an external calendar folder",
  noOccurrence: "Recurring page has no scheduled occurrence to complete.",
  notRecurring: "Occurrence completion applies only to a recurring series.",
  occurrenceAlreadyPassed: "This series has moved past the occurrence you asked to complete.",
  occurrenceNotInSeries: "Occurrence is not part of this synced series.",
  syncedNeedsDate: "Synced occurrence completion requires an occurrence date.",
  syncedNeedsStart: "Synced occurrence completion requires the occurrence start.",
  syncedPlacement:
    "This event is synced from an external calendar — it stays in its calendar folder.",
  syncedReadonly:
    "This event is synced from an external calendar — its title and schedule are read-only.",
} as const;

const {
  createdInCalendarFolder: CREATED_IN_CALENDAR_FOLDER_MSG,
  externalFolderLocked: EXTERNAL_FOLDER_LOCKED_MSG,
  intoCalendarFolder: INTO_CALENDAR_FOLDER_MSG,
  noOccurrence: NO_OCCURRENCE_MSG,
  notRecurring: NOT_RECURRING_MSG,
  occurrenceAlreadyPassed: OCCURRENCE_ALREADY_PASSED_MSG,
  occurrenceNotInSeries: OCCURRENCE_NOT_IN_SERIES_MSG,
  syncedNeedsDate: SYNCED_NEEDS_DATE_MSG,
  syncedNeedsStart: SYNCED_NEEDS_START_MSG,
  syncedPlacement: SYNCED_PLACEMENT_MSG,
  syncedReadonly: SYNCED_READONLY_MSG,
} = MIRRORED_GUARD_MESSAGES;

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/** One word in twenty is "the", about its share of English, so Find on it matches as often as it
 *  would on a real page. */
const SEED_WORDS = [
  "the",
  "meeting",
  "draft",
  "review",
  "garden",
  "budget",
  "travel",
  "notes",
  "design",
  "plan",
  "call",
  "week",
  "about",
  "from",
  "project",
  "after",
  "morning",
  "list",
  "idea",
  "follow",
];

type SeedShape = "prose" | "log";

const SEED_MARKS = [
  { type: "bold" },
  { type: "italic" },
  { type: "code" },
  { attrs: { href: "https://example.com" }, type: "link" },
];

/**
 * An editor document of exactly `words` words in one of the two shapes the large-page research
 * measured: prose mixing headings, bullet and task lists, quotes, code blocks, and marks on a third
 * of its paragraphs; or a log of one short line per paragraph under a heading every 20 lines, as a dated journal runs.
 * Words vary by page so text shaping can't serve one repeated run from cache.
 */
function seededDocument(
  words: number,
  page: number,
  shape: SeedShape
): { content: string; text: string } {
  const runs: string[] = [];
  let used = 0;

  // ProseMirror rejects an empty text node, so a run past the last word is no node at all.
  const run = (n: number, marks?: object[]): object[] => {
    const count = Math.min(n, words - used);
    if (count <= 0) return [];

    const text = Array.from(
      { length: count },
      (_, k) => SEED_WORDS[(used + k + page) % SEED_WORDS.length]
    ).join(" ");
    used += count;
    runs.push(text);

    return [{ text, type: "text", ...(marks ? { marks } : {}) }];
  };
  const paragraph = (content: object[]) => ({ content, type: "paragraph" });
  const space = { text: " ", type: "text" };
  const markedParagraph = (mark: object) =>
    paragraph([...run(20), space, ...run(6, [mark]), space, ...run(24)]);
  const list = (type: "bulletList" | "taskList", items: number, n: number) => ({
    content: Array.from({ length: items }, (_, k) => ({
      content: [paragraph(run(n))],
      type: type === "taskList" ? "taskItem" : "listItem",
      ...(type === "taskList" ? { attrs: { checked: k % 2 === 0 } } : {}),
    })),
    type,
  });

  const blocks: object[] = [];
  for (let cycle = 0; used < words; cycle += 1) {
    if (shape === "log") {
      blocks.push({ attrs: { level: 3 }, content: run(3), type: "heading" });
      for (let line = 0; line < 20; line += 1) blocks.push(paragraph(run(10)));
      continue;
    }

    blocks.push(
      { attrs: { level: 2 }, content: run(5), type: "heading" },
      markedParagraph(SEED_MARKS[cycle % SEED_MARKS.length] ?? {}),
      paragraph(run(50)),
      list("bulletList", 3, 10),
      paragraph(run(50)),
      list("taskList", 3, 8),
      { content: [paragraph(run(25))], type: "blockquote" }
    );
    if (cycle % SEED_MARKS.length === 0) {
      blocks.push({ attrs: { language: null }, content: run(12), type: "codeBlock" });
    }
  }

  return { content: JSON.stringify({ content: blocks, type: "doc" }), text: runs.join("\n") };
}

/** Best-effort plain text from a Tiptap JSON string, matching the search text the Rust writer stores. */
function deriveContentText(content: string): string {
  try {
    return extractText(JSON.parse(content));
  } catch {
    return "";
  }
}

function deriveLinks(content: string): string[] {
  try {
    return linkTargets(JSON.parse(content));
  } catch {
    return [];
  }
}

/** Mirrors `original_date_in_rule_basis` (pages.rs), which owns the reasoning. */
function originalDateInRuleBasis(occurrenceDate: string, ruleStart: string): string {
  const day = occurrenceDate.slice(0, 10);
  const time = ruleStart.split("T")[1];
  return time ? `${day}T${time}` : day;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Manual order with the database's tie-break: order value, then creation, then id. */
function byManualOrder(a: PageSummary, b: PageSummary): number {
  return a.sortOrder - b.sortOrder || byText(a.createdAt, b.createdAt) || byText(a.id, b.id);
}

// Reduced rather than spread: `Math.max(...array)` overflows the stack past roughly a hundred
// thousand elements.
function nextSortOrder(items: { sortOrder: number }[]): number {
  if (items.length === 0) return 0;
  let max = -Infinity;
  for (const item of items) {
    if (item.sortOrder > max) max = item.sortOrder;
  }
  return max + 1;
}

/** All terms present, the last as a prefix: the query `search_pages_impl` builds. */
function ftsMatches(terms: string[], document: string): boolean {
  const docTokens = ftsTokens(document);
  return terms.every((term, i) =>
    i === terms.length - 1 ? docTokens.some((d) => d.startsWith(term)) : docTokens.includes(term)
  );
}

/** The shape of `excerpt_around` and `join_blocks` (search.rs), which own why. */
function excerptAround(text: string, terms: string[]): string {
  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" \u00B7 ");
  const lower = body.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).find((i) => i >= 0) ?? -1;
  if (hit < 0) return "";

  const half = 60;
  const start = hit > half ? body.lastIndexOf(" ", hit - half) + 1 : 0;
  const spaceAfter = body.indexOf(" ", hit + half);
  const end = hit + half < body.length && spaceAfter >= 0 ? spaceAfter : body.length;

  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < body.length ? "\u2026" : "";
  return `${prefix}${body.slice(start, end).trim()}${suffix}`;
}

/** `hard_delete_would_resurrect`: the trash keeps any linked page that isn't detached. */
function deleteWouldResurrect(page: Page): boolean {
  return page.syncState != null && page.syncState !== "detached";
}

function toSummary(page: Page): PageSummary {
  const { content: _, ...summary } = page;
  return summary;
}

function matchesFilter(page: Page, text: string, filter: PageFilter): boolean {
  if (filter.folderId !== undefined) {
    if (page.folderId !== filter.folderId) return false;
  }
  if (filter.status !== undefined && page.status !== filter.status) return false;
  if (filter.priority !== undefined && page.priority !== filter.priority) return false;
  if (filter.tags !== undefined && filter.tags.length > 0) {
    if (!filter.tags.every((t) => page.tags.includes(t))) return false;
  }
  if (filter.scheduledAfter !== undefined && page.scheduledStart != null) {
    if (page.scheduledStart < filter.scheduledAfter) return false;
  }
  if (filter.scheduledBefore !== undefined && page.scheduledStart != null) {
    if (page.scheduledStart > filter.scheduledBefore) return false;
  }
  if (filter.hasSchedule === true && page.scheduledStart == null) return false;
  if (filter.query !== undefined && filter.query.length > 0) {
    const q = filter.query.toLowerCase();
    // Title and extracted text only, as the writer does; raw Tiptap JSON would match "paragraph" everywhere.
    const haystack = `${page.title} ${text}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** `pages`, counting every write as the database's change counter does, for `getPageIfNewer` and `changeState`. */
class CountedPages extends Map<string, Page> {
  seq = 0;
  readonly rowSeq = new Map<string, number>();
  private readonly texts = new Map<string, { content: string; text: string }>();

  /** The search text stored beside a body, re-derived only when the body changes. */
  textOf(page: Page): string {
    const cached = this.texts.get(page.id);
    if (cached?.content === page.content) return cached.text;

    const text = deriveContentText(page.content);
    this.texts.set(page.id, { content: page.content, text });
    return text;
  }

  /** Seeds a page's search text without parsing its body. */
  primeText(page: Page, text: string): void {
    this.texts.set(page.id, { content: page.content, text });
  }

  override set(id: string, page: Page): this {
    this.seq += 1;
    // Absent while Map's constructor runs, before the fields above are set.
    this.rowSeq?.set(id, this.seq);
    return super.set(id, page);
  }

  override delete(id: string): boolean {
    this.seq += 1;
    this.texts.delete(id);
    return super.delete(id);
  }
}

/** The next manual order value in a folder: a full gap after its last page, as pikos-db does. */
function nextPageOrder(pages: Iterable<Page>, folderId: string | null): number {
  let max: number | null = null;
  for (const page of pages) {
    if ((page.folderId ?? null) === folderId && (max === null || page.sortOrder > max)) {
      max = page.sortOrder;
    }
  }
  return max === null ? 0 : max + ORDER_SPACING;
}

/** One event a provider holds for a `StagedCalendar`. */
export interface StagedProviderEvent {
  title: string;
  scheduledStart: string;
  scheduledEnd?: string;
  timezone?: string;
  location?: string;
}

/** One calendar a CalDAV server offers, as `stageCaldavCalendars` takes it. */
export interface StagedCalendar {
  displayName: string;
  /** Already a palette entry: setup stores a server's own colour as its nearest one. */
  color?: string;
  events?: StagedProviderEvent[];
}

const CANNED_CALDAV_CALENDARS: StagedCalendar[] = [
  { displayName: "Personal" },
  { displayName: "Work" },
];

export class MockStorageAdapter implements StorageAdapter {
  private pages = new CountedPages();
  private folders = new Map<string, Folder>();
  private schedules = new Map<string, PageSchedule>();
  private rules = new Map<string, PageRecurrenceRule>();
  private reminders = new Map<string, PageReminder>();
  // `focus_sessions`: finished sessions only; a running one lives in the timer's state.
  private focusSessions: FocusSession[] = [];
  // The Rust scheduler is the log's only real writer and has no twin here, so it stays empty
  // unless a test calls `seedNotificationHistory`.
  private notificationHistory: NotificationHistoryEntry[] = [];
  // `pages.deleted_at`: id to trash time, which the trash sort and retention sweep need.
  private softDeleted = new Map<string, string>();
  private softDeletedFolders = new Set<string>();
  private syncAccounts = new Map<string, SyncAccount>();
  private syncCalendars = new Map<string, SyncCalendar>();
  // Disconnected (dormant) accounts: kept for reconnect re-link, hidden from status.
  private dormantAccounts = new Set<string>();
  // Pages each calendar's own teardown severed, so a re-enable reclaims only those (`_relinkCalendar`).
  private detachedByCalendar = new Map<string, string[]>();
  // `page_sync.user_modified`: set by the editor path, never by sync (see `_isOwned`).
  private userModified = new Set<string>();
  private stagedCaldavCalendars: StagedCalendar[] | null = null;
  // What the provider holds for each discovered calendar, keyed by sync_calendar row id.
  private providerEvents = new Map<string, StagedProviderEvent[]>();
  /** The arguments of the most recent `exportWorkspace` call, for assertions. */
  lastExport: { format: WorkspaceExportFormat; options: WorkspaceExportOptions } | null = null;

  clear(): void {
    this.pages.clear();
    this.folders.clear();
    this.schedules.clear();
    this.rules.clear();
    this.reminders.clear();
    this.focusSessions = [];
    this.notificationHistory = [];
    this.softDeleted.clear();
    this.softDeletedFolders.clear();
    this.syncAccounts.clear();
    this.syncCalendars.clear();
    this.dormantAccounts.clear();
    this.detachedByCalendar.clear();
    this.userModified.clear();
    this.stagedCaldavCalendars = null;
    this.providerEvents.clear();
  }

  /** The rejection `ensure_page_schedule_unlocked` throws for a synced (`active`) page, else null. Returned, not thrown, so callers reject the promise and `.rejects` matchers work. */
  private lockedMirrorError(pageId: string | undefined): StorageError | null {
    return pageId != null && this.pages.get(pageId)?.scheduleLocked
      ? new StorageError("Conflict", SYNCED_READONLY_MSG)
      : null;
  }

  /** Mirrors `synced_occurrence_is_valid`: whether `day` (YYYY-MM-DD) is a real occurrence of the page's rule, so a cross-zone off-by-one key can't write an unsuppressable completed-set entry. */
  private syncedOccurrenceValid(pageId: string, day: string): boolean {
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId);
    const page = this.pages.get(pageId);
    if (!rule || !page) return false;
    const lo = parseLocalISO(`${day}T00:00:00`);
    const hi = parseLocalISO(`${day}T23:59:59`);
    return rawExpandRule(rule, page, lo, hi).some((o) => o.originalDate === day);
  }

  getPage(id: string): Promise<Page | null> {
    const page = this.pages.get(id);
    return Promise.resolve(page ? { ...page, rowSeq: this.pages.rowSeq.get(id) ?? 0 } : null);
  }

  createPage(data: NewPage): Promise<Page> {
    // Only the reconciler seeds into a calendar folder (create_page_impl, pages.rs).
    if (data.folderId != null && this.folders.get(data.folderId)?.isExternalCalendar) {
      return Promise.reject(new StorageError("Conflict", CREATED_IN_CALENDAR_FOLDER_MSG));
    }
    return Promise.resolve(this.insertPage(data));
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): create a page inside a calendar folder, which
   * `createPage` refuses. Stands for the reconciler, the only writer that seeds a mirror.
   */
  seedMirrorPage(data: NewPage): Promise<Page> {
    return Promise.resolve(this.insertPage(data));
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): fill the adapter with generated pages so a render
   * can be timed against a realistic row count.
   *
   * Skips `insertPage`: its `nextPageOrder` is O(n) per insert, so a 50,000-page seed takes
   * minutes and measures the seeder. Sort order is the index, which is what it would produce.
   * Bodies vary, since identical ones let text shaping cache in ways a real workspace wouldn't.
   */
  seedPages(
    count: number,
    opts: { completedEvery?: number; bodyWords?: number; bodyShape?: SeedShape } = {}
  ): void {
    const completedEvery = opts.completedEvery ?? 0;
    const stamp = now();
    for (let i = 0; i < count; i += 1) {
      const done = completedEvery > 0 && i % completedEvery === 0;
      const body = opts.bodyWords
        ? seededDocument(opts.bodyWords, i, opts.bodyShape ?? "prose")
        : {
            content: `Seeded body ${i} with a little text so the row has something to measure.`,
            text: "",
          };
      const page: Page = {
        completedAt: done ? stamp : null,
        content: body.content,
        contentSchemaVersion: CONTENT_SCHEMA_VERSION,
        createdAt: stamp,
        detachIsReversible: false,
        folderId: null,
        id: `seed-${i}`,
        isRecurring: false,
        links: [],
        priority: (i % 5) as Page["priority"],
        scheduleLocked: false,
        sortOrder: i,
        status: done ? "done" : "not_started",
        subtitle: null,
        tags: [],
        title: `Seeded page ${i}`,
        updatedAt: stamp,
      };
      this.pages.set(page.id, page);
      this.pages.primeText(page, body.text || body.content);
    }
  }

  private insertPage(data: NewPage): Page {
    const page: Page = {
      ...data,
      // Stamped explicitly, as the Rust writer does, not left to the column default.
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      // An import supplies these and they are kept.
      createdAt: data.createdAt ?? now(),
      detachIsReversible: false,
      id: data.id ?? uuid(),
      isRecurring: false,
      links: deriveLinks(data.content),
      scheduleLocked: false,
      sortOrder: nextPageOrder(this.pages.values(), data.folderId ?? null),
      updatedAt: data.updatedAt ?? now(),
    };
    this.pages.set(page.id, page);
    return page;
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): stamp a page with the synced provenance a real
   * `page_sync` row would derive (`scheduleLocked`, `syncState`, `timezone`, mirror metadata),
   * without a reconciler. `active` locks the schedule; `detached` and `tombstoned` leave it editable.
   */
  markPageSynced(
    pageId: string,
    opts: {
      timezone?: string;
      state?: "active" | "detached" | "tombstoned";
      location?: string | null;
      attendees?: string[] | null;
      pendingDescription?: string | null;
      /** Local day the page first synced; defaults to today, as a fresh sync would. */
      syncedSince?: string | null;
      /** `page_sync.user_modified`. Only the editor path sets it in the app, so a fixture needing an already-owned mirror has to pass it here. */
      userModified?: boolean;
    } = {}
  ): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const state = opts.state ?? "active";
    // Sticky, like the column: a later re-stamp never disowns a mirror.
    if (opts.userModified) this.userModified.add(pageId);
    this.pages.set(pageId, {
      ...page,
      mirrorAttendees: opts.attendees ?? page.mirrorAttendees ?? null,
      mirrorLocation: opts.location ?? page.mirrorLocation ?? null,
      pendingDescription: opts.pendingDescription ?? page.pendingDescription ?? null,
      scheduleLocked: state === "active",
      syncedSince: opts.syncedSince ?? page.syncedSince ?? formatDateOnly(new Date()),
      syncState: state,
      timezone: opts.timezone ?? page.timezone ?? null,
    });
  }

  /** Test/seed-only (NOT on `StorageAdapter`): reads `page_sync.user_modified` back. */
  isPageUserModified(pageId: string): boolean {
    return this.userModified.has(pageId);
  }

  /**
   * Test-only (NOT on `StorageAdapter`): parks the head on a date the derivation disagrees
   * with, as a session left open across midnight does. `updatePage` refuses a locked mirror's
   * schedule, so nothing else can.
   */
  setHeadScheduleForTest(pageId: string, scheduledStart: string): void {
    const page = this.pages.get(pageId);
    if (page) this.pages.set(pageId, { ...page, scheduledStart });
  }

  updatePage(id: string, update: PageUpdate): Promise<Page> {
    // One window writes the mock, so a body never changes under the editor that typed over it.
    const { baseContent: _typedOver, ...updates } = update;
    const existing = this.pages.get(id);
    if (!existing) return Promise.reject(new Error(`Page not found: ${id}`));
    // Placement lock, keyed on the live sync link: nothing moves into a calendar folder and an
    // actively synced page can't leave. The reclaim path writes the folder directly.
    if (updates.folderId !== undefined) {
      const target = updates.folderId != null ? this.folders.get(updates.folderId) : undefined;
      if (target?.isExternalCalendar) {
        return Promise.reject(new StorageError("Conflict", INTO_CALENDAR_FOLDER_MSG));
      }
      if (existing.scheduleLocked) {
        return Promise.reject(new StorageError("Conflict", SYNCED_PLACEMENT_MSG));
      }
    }
    // Title and schedule are calendar-owned on a synced page (update_page_impl, pages.rs).
    if (
      updates.title !== undefined ||
      updates.scheduledStart !== undefined ||
      updates.scheduledEnd !== undefined
    ) {
      const locked = this.lockedMirrorError(id);
      if (locked) return Promise.reject(locked);
    }
    // Editing an authored field claims ownership; arranging does not (`marks_ownership`, pages.rs).
    if (Object.keys(updates).some((k) => k !== "sortOrder" && k !== "lastOpenedAt")) {
      this.userModified.add(id);
    }
    const updated: Page = { ...existing, ...updates, id, updatedAt: now() };
    if (updates.content !== undefined) updated.links = deriveLinks(updates.content);
    this.pages.set(id, updated);
    return Promise.resolve(updated);
  }

  deletePage(id: string): Promise<void> {
    this.pages.delete(id);
    // The schema cascades these; the mock must too.
    for (const [rid, r] of this.reminders) if (r.pageId === id) this.reminders.delete(rid);
    for (const [sid, s] of this.schedules) if (s.pageId === id) this.schedules.delete(sid);
    for (const [rid, r] of this.rules) if (r.pageId === id) this.rules.delete(rid);
    return Promise.resolve();
  }

  clearPendingDescription(id: string): Promise<void> {
    const page = this.pages.get(id);
    // Only the column, as the writer does; the body keeps reading as the user's.
    if (page) this.pages.set(id, { ...page, pendingDescription: null });
    return Promise.resolve();
  }

  /** One paragraph per line like the writer's seed builder, without its address linking. */
  pendingDescriptionDocument(id: string): Promise<string | null> {
    const pending = this.pages.get(id)?.pendingDescription;
    if (pending == null) return Promise.resolve(null);

    const content = pending
      .split("\n")
      .map((line) =>
        line
          ? { content: [{ text: line, type: "text" }], type: "paragraph" }
          : { type: "paragraph" }
      );
    return Promise.resolve(JSON.stringify({ content, type: "doc" }));
  }

  /** Trash a page or bring it back, touching its row as the writer's `deleted_at` update does, so
   *  the change counter moves and a cache reading it refreshes. Guarded like the writer: a second
   *  delete must not overwrite the original stamp and hand the page another 30 days. */
  private setTrashed(id: string, trashed: boolean): void {
    if (trashed === this.softDeleted.has(id)) return;
    if (trashed) this.softDeleted.set(id, now());
    else this.softDeleted.delete(id);
    const page = this.pages.get(id);
    if (page) this.pages.set(id, page);
  }

  softDeletePage(id: string): Promise<void> {
    this.setTrashed(id, true);
    return Promise.resolve();
  }

  restorePage(id: string): Promise<void> {
    this.setTrashed(id, false);
    return Promise.resolve();
  }

  listTrashedPages(): Promise<TrashedPage[]> {
    const rows: TrashedPage[] = [];
    for (const [id, deletedAt] of this.softDeleted) {
      const page = this.pages.get(id);
      if (!page) continue;
      const folder = page.folderId == null ? null : this.folders.get(page.folderId);
      rows.push({
        deletedAt,
        // A folder trashed with the page has no surviving name to show — the
        // Rust subquery filters on `folders.deleted_at IS NULL` for the same reason.
        folderName: folder && !this.softDeletedFolders.has(folder.id) ? folder.name : null,
        id,
        isSynced: deleteWouldResurrect(page),
        title: page.title,
      });
    }
    return Promise.resolve(rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)));
  }

  purgeTrashedPages(olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(0, olderThanDays) * 86_400_000).toISOString();
    let purged = 0;
    for (const [id, deletedAt] of [...this.softDeleted]) {
      if (deletedAt > cutoff) continue;
      const page = this.pages.get(id);
      if (page && deleteWouldResurrect(page)) continue;
      this.softDeleted.delete(id);
      void this.deletePage(id);
      purged++;
    }
    return Promise.resolve(purged);
  }

  listPages(filter?: PageFilter): Promise<PageSummary[]> {
    const all = [...this.pages.values()].filter((p) => !this.softDeleted.has(p.id));
    const filtered = filter
      ? all.filter((p) => matchesFilter(p, this.pages.textOf(p), filter))
      : all;
    return Promise.resolve(filtered.sort((a, b) => a.sortOrder - b.sortOrder).map(toSummary));
  }

  listPagesToday(): Promise<PageSummary[]> {
    const today = new Date().toISOString().slice(0, 10);
    const pageIds = new Set(
      [...this.schedules.values()]
        .filter((s) => s.scheduledStart.slice(0, 10) <= today)
        .map((s) => s.pageId)
    );
    const results = [...this.pages.values()]
      .filter((p) => pageIds.has(p.id) && isOpen(p) && !this.softDeleted.has(p.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return Promise.resolve(results.map(toSummary));
  }

  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, i) => {
      const page = this.pages.get(id);
      if (page) this.pages.set(id, { ...page, sortOrder: i, updatedAt: now() });
    });
    return Promise.resolve();
  }

  setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<PageSummary[]> {
    const updated: PageSummary[] = [];
    for (const id of ids) {
      const existing = this.pages.get(id);
      if (!existing || this.softDeleted.has(id)) continue;
      const next: Page = { ...existing, completedAt, status, updatedAt: now() };
      this.pages.set(id, next);
      updated.push(toSummary(next));
    }
    return Promise.resolve(updated);
  }

  listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse> {
    let all = [...this.pages.values()].filter((p) => !this.softDeleted.has(p.id) && isDone(p));

    if (filter.folderId !== undefined) {
      all = all.filter((p) => p.folderId === filter.folderId);
    }
    if (filter.completedSince !== undefined) {
      all = all.filter(
        (p) => p.completedAt != null && p.completedAt.slice(0, 10) >= filter.completedSince!
      );
    }

    all.sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

    const total = all.length;
    const pages = all.slice(filter.offset, filter.offset + filter.limit).map(toSummary);
    return Promise.resolve({ pages, total });
  }

  /** Open and done pages that aren't trashed, as the database's list reads see them. */
  private livePages(): PageSummary[] {
    return [...this.pages.values()]
      .filter((p) => !this.softDeleted.has(p.id))
      .map((p) => ({ ...toSummary(p), rowSeq: this.pages.rowSeq.get(p.id) ?? 0 }));
  }

  listView(key: ViewKey, after: ViewCursor | null, limit: number): Promise<ViewWindow> {
    return Promise.resolve(listViewOf(this.livePages(), key, after, limit));
  }

  listViewIds(
    key: ViewKey,
    after: ViewCursor | null,
    through: ViewCursor | null
  ): Promise<string[]> {
    return Promise.resolve(listViewIdsOf(this.livePages(), key, after, through));
  }

  listCompletedWindow(
    scope: ViewScope | null,
    since: string | null,
    after: CompletedCursor | null,
    limit: number
  ): Promise<CompletedWindow> {
    return Promise.resolve(listCompletedOf(this.livePages(), scope, since, after, limit));
  }

  listRange(
    start: string | null,
    end: string,
    zone: string,
    openOnly: boolean
  ): Promise<PageSummary[]> {
    return Promise.resolve(listRangeOf(this.livePages(), start, end, zone, openOnly));
  }

  listSeriesHeads(openOnly: boolean, since: number | null = null): Promise<PageSummary[]> {
    const ruled = new Set([...this.rules.values()].map((r) => r.pageId));
    return Promise.resolve(
      this.livePages()
        .filter((p) => ruled.has(p.id) && (!openOnly || isOpen(p)))
        .filter((p) => since === null || (p.rowSeq ?? 0) > since)
        .sort(byManualOrder)
    );
  }

  countViews(zone: string, today: string): Promise<ViewCounts> {
    const pages = this.livePages();
    const folders: Record<string, number> = {};
    let inbox = 0;
    for (const page of pages.filter(isOpen)) {
      if (page.folderId == null) inbox += 1;
      else folders[page.folderId] = (folders[page.folderId] ?? 0) + 1;
    }
    return Promise.resolve({
      folders,
      inbox,
      today: countStarting(pages, zone, null, dayAfter(today)),
      upcoming: countStarting(pages, zone, today, dayAfter(today, UPCOMING_DAYS)),
    });
  }

  getPages(ids: string[]): Promise<PageSummary[]> {
    const live = new Map(this.livePages().map((p) => [p.id, p]));
    return Promise.resolve(ids.flatMap((id) => live.get(id) ?? []));
  }

  getPageIfNewer(id: string, known: number | null): Promise<PageIfNewer> {
    const page = this.pages.get(id);
    if (!page || this.softDeleted.has(id)) return Promise.resolve({ kind: "missing" });
    const rowSeq = this.pages.rowSeq.get(id) ?? 0;
    if (known != null && known >= rowSeq) return Promise.resolve({ kind: "current" });
    return Promise.resolve({ kind: "newer", page: { ...page, rowSeq }, rowSeq });
  }

  listRecentPages(exclude: string | null, limit: number): Promise<PageSummary[]> {
    return Promise.resolve(
      this.livePages()
        .filter((p) => isOpen(p) && p.lastOpenedAt != null && p.id !== exclude)
        .sort((a, b) => byText(b.lastOpenedAt!, a.lastOpenedAt!))
        .slice(0, limit)
    );
  }

  listBacklinks(id: string): Promise<PageSummary[]> {
    return Promise.resolve(
      this.livePages()
        .filter((p) => p.id !== id && (p.links ?? []).includes(id))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
    );
  }

  listTags(): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const page of this.livePages().filter(isOpen)) {
      for (const tag of new Set(page.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Promise.resolve(
      [...counts]
        .map(([name, pageCount]) => ({ name, pageCount }))
        .sort((a, b) => b.pageCount - a.pageCount || byText(a.name, b.name))
    );
  }

  /** `move_pages` in pikos-db: values strictly between the neighbours, a renumber of the folder,
   *  done pages included, when they run out of room, and a conflict when they moved. */
  movePages(ids: string[], place: Placement): Promise<MoveOutcome> {
    const conflict = (why: string) =>
      Promise.reject(new StorageError("Conflict", `the list changed: ${why}`));
    const invalid = (why: string) => Promise.reject(new StorageError("Invalid", why));
    const open = (id: string) => {
      const page = this.pages.get(id);
      return page && !this.softDeleted.has(id) && isOpen(page) ? page : null;
    };
    if (ids.length === 0) return invalid("nothing to move");
    const moved = ids.map(open);
    if (moved.some((p) => p == null)) return conflict("a moved page isn't open");
    const folderId = moved[0]!.folderId ?? null;
    if (moved.some((p) => (p!.folderId ?? null) !== folderId)) {
      return invalid("moved pages must share a folder");
    }
    const below = place.after == null ? null : open(place.after);
    const above = place.before == null ? null : open(place.before);
    if ((place.after != null && !below) || (place.before != null && !above)) {
      return conflict("a neighbour isn't an open page");
    }
    if ([below, above].some((n) => n && (n.folderId ?? null) !== folderId)) {
      return conflict("a neighbour is in another folder");
    }
    const between = [...this.pages.values()].filter(
      (p) =>
        !this.softDeleted.has(p.id) &&
        isOpen(p) &&
        (p.folderId ?? null) === folderId &&
        !ids.includes(p.id) &&
        (!below || byManualOrder(p, below) > 0) &&
        (!above || byManualOrder(p, above) < 0)
    );
    if (between.length > 0) return conflict("its neighbours aren't next to each other");

    const k = ids.length;
    const bounds = (): [number, number] => {
      const low = below ? this.pages.get(below.id)!.sortOrder : null;
      const high = above ? this.pages.get(above.id)!.sortOrder : null;
      if (low != null && high != null) return [low, high];
      if (low != null) return [low, low + (k + 1) * ORDER_SPACING];
      if (high != null) return [high - (k + 1) * ORDER_SPACING, high];
      return [0, (k + 1) * ORDER_SPACING];
    };
    let [low, high] = bounds();
    const renumbered = high - low - 1 < k;
    if (renumbered) {
      [...this.pages.values()]
        .filter((p) => !this.softDeleted.has(p.id) && (p.folderId ?? null) === folderId)
        .sort(byManualOrder)
        .forEach((p, i) => this.pages.set(p.id, { ...p, sortOrder: (i + 1) * ORDER_SPACING }));
      [low, high] = bounds();
    }
    const stamp = now();
    const orders = ids.map((id, i): [string, number] => {
      const value = low + Math.floor(((high - low) * (i + 1)) / (k + 1));
      this.pages.set(id, { ...this.pages.get(id)!, sortOrder: value, updatedAt: stamp });
      return [id, value];
    });
    return Promise.resolve({ orders, renumbered });
  }

  changeState(): Promise<ChangeState> {
    return Promise.resolve({ epoch: "mock", ownChanges: this.pages.seq, seq: this.pages.seq });
  }

  searchTags(query: string): Promise<string[]> {
    const q = query.toLowerCase();
    const names = new Set<string>();
    for (const page of this.pages.values()) {
      for (const tag of page.tags) {
        if (tag.toLowerCase().startsWith(q)) names.add(tag);
      }
    }
    return Promise.resolve([...names].sort().slice(0, 20));
  }

  searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse> {
    const terms = ftsTokens(query);
    if (terms.length === 0) {
      return Promise.resolve({ completedCount: 0, completedCountCapped: false, results: [] });
    }
    const titleResults: SearchResult[] = [];
    const contentResults: SearchResult[] = [];
    let completedCount = 0;
    for (const page of this.pages.values()) {
      if (this.softDeleted.has(page.id)) continue;
      // One indexed document, so a query spanning two fields still matches. Extracted text, never
      // raw Tiptap JSON, which would hit on "paragraph".
      const subtitle = page.subtitle ?? "";
      const body = this.pages.textOf(page);
      const mirror = mirrorSearchText(page.mirrorLocation, page.mirrorAttendees) ?? "";
      if (!ftsMatches(terms, [page.title, subtitle, body, page.tags.join(" "), mirror].join(" "))) {
        continue;
      }
      if (isDone(page)) {
        completedCount++;
        if (!includeCompleted) continue;
      }
      // The writer's own post-selection labelling (search.rs), a looser test than selection.
      const titleLower = page.title.toLowerCase();
      const titleMatch = terms.some((t) => titleLower.includes(t));
      const subtitleLower = subtitle.toLowerCase();
      const subtitleMatch = terms.some((t) => subtitleLower.includes(t));
      // The excerpt is body only (`build_excerpt`); a hit only in mirror metadata quotes that, as
      // `build_mirror_excerpt` does (search.rs).
      const excerpt =
        excerptAround(body, terms) || excerptAround(mirror.replace(/\n/g, " · "), terms);
      const contentMatch = excerpt !== "";
      const matchSource =
        titleMatch && contentMatch
          ? "both"
          : titleMatch
            ? "title"
            : subtitleMatch
              ? "subtitle"
              : "content";
      const meta = {
        contentPreview: body.slice(0, 80),
        folderId: page.folderId,
        isRecurring: page.isRecurring,
        priority: page.priority,
        scheduledDate: page.scheduledStart ?? null,
        scheduledEnd: page.scheduledEnd ?? null,
        scheduleLocked: page.scheduleLocked,
        status: page.status,
        subtitle: page.subtitle ?? null,
        tags: page.tags,
      } as const;
      const result: SearchResult = {
        excerpt,
        id: page.id,
        matchSource,
        title: page.title,
        ...meta,
      };
      if (titleMatch) titleResults.push(result);
      else contentResults.push(result);
    }
    // Title matches first. Not a bm25 reproduction, so tests shouldn't assert beyond title-before-content.
    const results = [...titleResults, ...contentResults].slice(0, 20);
    return Promise.resolve({ completedCount, completedCountCapped: false, results });
  }

  getFolder(id: string): Promise<Folder | null> {
    return Promise.resolve(this.folders.get(id) ?? null);
  }

  createFolder(data: NewFolder): Promise<Folder> {
    const folder: Folder = {
      ...data,
      createdAt: now(),
      id: uuid(),
      isExternalCalendar: false,
      sortOrder: nextSortOrder([...this.folders.values()]),
      updatedAt: now(),
    };
    this.folders.set(folder.id, folder);
    return Promise.resolve(folder);
  }

  updateFolder(id: string, updates: FolderUpdate): Promise<Folder> {
    const existing = this.folders.get(id);
    if (!existing) return Promise.reject(new Error(`Folder not found: ${id}`));
    // A calendar folder can't be reparented and nothing nests under one (update_folder_impl, folders.rs).
    if (updates.parentId !== undefined) {
      const intoExternal =
        updates.parentId != null && this.folders.get(updates.parentId)?.isExternalCalendar;
      if (intoExternal || existing.isExternalCalendar) {
        return Promise.reject(new StorageError("Conflict", EXTERNAL_FOLDER_LOCKED_MSG));
      }
    }
    const updated: Folder = { ...existing, ...updates, id, updatedAt: now() };
    this.folders.set(id, updated);
    // A sidebar recolour reaches the calendar too, as in the real writer.
    if (typeof updates.color === "string") {
      for (const cal of this.syncCalendars.values()) {
        if (cal.folderId === id) this.syncCalendars.set(cal.id, { ...cal, color: updates.color });
      }
    }
    return Promise.resolve(updated);
  }

  deleteFolder(id: string): Promise<void> {
    if (this.folders.get(id)?.isExternalCalendar) {
      return Promise.reject(new StorageError("Conflict", EXTERNAL_FOLDER_LOCKED_MSG));
    }
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.setTrashed(page.id, true);
    }
    this.folders.delete(id);
    return Promise.resolve();
  }

  softDeleteFolder(id: string): Promise<void> {
    if (this.folders.get(id)?.isExternalCalendar) {
      return Promise.reject(new StorageError("Conflict", EXTERNAL_FOLDER_LOCKED_MSG));
    }
    this.softDeletedFolders.add(id);
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.setTrashed(page.id, true);
    }
    return Promise.resolve();
  }

  restoreFolder(id: string): Promise<void> {
    this.softDeletedFolders.delete(id);
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.setTrashed(page.id, false);
    }
    return Promise.resolve();
  }

  listFolders(): Promise<Folder[]> {
    return Promise.resolve(
      [...this.folders.values()]
        .filter((f) => !this.softDeletedFolders.has(f.id))
        .sort((a, b) => a.sortOrder - b.sortOrder)
    );
  }

  reorderFolders(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, i) => {
      const folder = this.folders.get(id);
      if (folder) this.folders.set(id, { ...folder, sortOrder: i, updatedAt: now() });
    });
    return Promise.resolve();
  }

  createPageSchedule(data: NewPageSchedule): Promise<PageSchedule> {
    const locked = this.lockedMirrorError(data.pageId);
    if (locked) return Promise.reject(locked);
    const schedule: PageSchedule = {
      id: uuid(),
      pageId: data.pageId,
      scheduledStart: data.scheduledStart,
      ...(data.scheduledEnd !== undefined && { scheduledEnd: data.scheduledEnd }),
      ...(data.timezone !== undefined && { timezone: data.timezone }),
      ...(data.ruleId !== undefined && { ruleId: data.ruleId }),
      ...(data.originalDate !== undefined && { originalDate: data.originalDate }),
      createdAt: now(),
      status: "not_started",
    };
    this.schedules.set(schedule.id, schedule);
    this._refreshDenorm(data.pageId);
    return Promise.resolve(schedule);
  }

  updatePageSchedule(id: string, updates: PageScheduleUpdate): Promise<PageSchedule> {
    const existing = this.schedules.get(id);
    if (!existing) return Promise.reject(new Error(`Schedule not found: ${id}`));
    const locked = this.lockedMirrorError(existing.pageId);
    if (locked) return Promise.reject(locked);
    const updated = { ...existing };
    if (updates.scheduledStart !== undefined) updated.scheduledStart = updates.scheduledStart;
    if (updates.status !== undefined) updated.status = updates.status;
    if (updates.scheduledEnd === null) delete updated.scheduledEnd;
    else if (updates.scheduledEnd !== undefined) updated.scheduledEnd = updates.scheduledEnd;
    this.schedules.set(id, updated);
    this._refreshDenorm(existing.pageId);
    return Promise.resolve(updated);
  }

  deletePageSchedule(id: string): Promise<void> {
    const schedule = this.schedules.get(id);
    const locked = this.lockedMirrorError(schedule?.pageId);
    if (locked) return Promise.reject(locked);
    this.schedules.delete(id);
    if (schedule) this._refreshDenorm(schedule.pageId);
    return Promise.resolve();
  }

  listPageSchedules(pageId: string): Promise<PageSchedule[]> {
    const results = [...this.schedules.values()]
      .filter((s) => s.pageId === pageId)
      .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
    return Promise.resolve(results);
  }

  listPageSchedulesForRules(ruleIds: string[]): Promise<PageSchedule[]> {
    if (ruleIds.length === 0) return Promise.resolve([]);
    const wanted = new Set(ruleIds);
    const results = [...this.schedules.values()].filter((s) => {
      // Schedules of a soft-deleted page are excluded, as the SQL join does.
      if (this.softDeleted.has(s.pageId)) return false;
      return s.ruleId != null && wanted.has(s.ruleId);
    });
    return Promise.resolve(
      results.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
    );
  }

  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const locked = this.lockedMirrorError(data.pageId);
    if (locked) return Promise.reject(locked);
    // The SQL enforces UNIQUE(page_id), so a test creating two rules fails here, not only in prod.
    for (const existing of this.rules.values()) {
      if (existing.pageId === data.pageId) {
        return Promise.reject(
          new Error(`UNIQUE constraint failed: page_recurrence_rules.page_id (${data.pageId})`)
        );
      }
    }
    const rule: PageRecurrenceRule = {
      id: uuid(),
      pageId: data.pageId,
      rrule: data.rrule,
      rruleExdates: data.rruleExdates ?? [],
      scheduledStart: data.scheduledStart,
      ...(data.scheduledEnd !== undefined && { scheduledEnd: data.scheduledEnd }),
      createdAt: now(),
      timezone: data.timezone,
    };
    this.rules.set(rule.id, rule);
    this.setRecurringFlag(rule.pageId, true);
    this.recomputeHead(rule.pageId);
    return Promise.resolve(rule);
  }

  updateRecurrenceRule(id: string, updates: RecurrenceRuleUpdate): Promise<PageRecurrenceRule> {
    const existing = this.rules.get(id);
    if (!existing) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    const locked = this.lockedMirrorError(existing.pageId);
    if (locked) return Promise.reject(locked);
    const updated = { ...existing };
    if (updates.rrule !== undefined) updated.rrule = updates.rrule;
    if (updates.rruleExdates !== undefined) updated.rruleExdates = updates.rruleExdates;
    if (updates.scheduledStart !== undefined) updated.scheduledStart = updates.scheduledStart;
    if (updates.timezone !== undefined) updated.timezone = updates.timezone;
    if (updates.scheduledEnd === null) delete updated.scheduledEnd;
    else if (updates.scheduledEnd !== undefined) updated.scheduledEnd = updates.scheduledEnd;
    this.rules.set(id, updated);
    this.recomputeHead(updated.pageId);
    return Promise.resolve(updated);
  }

  addRuleExdates(id: string, dates: string[]): Promise<PageRecurrenceRule> {
    const rule = this.rules.get(id);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    const locked = this.lockedMirrorError(rule.pageId);
    if (locked) return Promise.reject(locked);
    // Merges into the current row, never replaces it, so exdates written since the caller's snapshot survive.
    const merged = [...rule.rruleExdates];
    for (const d of dates) {
      if (!merged.includes(d)) merged.push(d);
    }
    const updated = { ...rule, rruleExdates: merged };
    this.rules.set(id, updated);
    this.recomputeHead(rule.pageId);
    return Promise.resolve(updated);
  }

  removeRuleExdate(id: string, date: string): Promise<PageRecurrenceRule> {
    const rule = this.rules.get(id);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    const locked = this.lockedMirrorError(rule.pageId);
    if (locked) return Promise.reject(locked);
    const updated = { ...rule, rruleExdates: rule.rruleExdates.filter((d) => d !== date) };
    this.rules.set(id, updated);
    this.recomputeHead(rule.pageId);
    return Promise.resolve(updated);
  }

  deleteRecurrenceRule(id: string): Promise<void> {
    const pageId = this.rules.get(id)?.pageId;
    const locked = this.lockedMirrorError(pageId);
    if (locked) return Promise.reject(locked);
    this.rules.delete(id);
    if (pageId != null) this.setRecurringFlag(pageId, false);
    return Promise.resolve();
  }

  /** Mirrors the Rust `is_recurring` projection, stored as a flag here rather than derived per read. */
  private setRecurringFlag(pageId: string, value: boolean): void {
    const page = this.pages.get(pageId);
    if (page) this.pages.set(pageId, { ...page, isRecurring: value });
  }

  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null> {
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId) ?? null;
    return Promise.resolve(rule);
  }

  listRecurrenceRules(): Promise<PageRecurrenceRule[]> {
    // Soft-delete state lives in the in-memory map; `p.deletedAt` is never set by softDeletePage.
    return Promise.resolve([...this.rules.values()].filter((r) => !this.softDeleted.has(r.pageId)));
  }

  expandRecurrenceRange(
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ): Promise<RawRuleExpansion[]> {
    const start = parseLocalISO(rangeStart);
    const end = parseLocalISO(rangeEnd);
    const result = rules.flatMap((rule) => {
      const page = this.pages.get(rule.pageId);
      if (!page) return [];
      return [{ occurrences: rawExpandRule(rule, page, start, end), ruleId: rule.id }];
    });
    return Promise.resolve(result);
  }

  /** Re-derives `head.scheduledStart` (or terminal `done`) from the rule base minus the exclusion
   * union (completed, skip, rruleExdates), as `recompute_recurring_schedule` does. The single
   * writer of a recurring head's cache. Returns whether anything changed. */
  private recomputeHead(pageId: string): boolean {
    const head = this.pages.get(pageId);
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId);
    if (!head || !rule) return false;
    const exclusions = [
      ...rule.rruleExdates,
      ...Object.keys(head.completedOccurrences ?? {}),
      ...(head.skippedOccurrences ?? []),
      // Materialised overrides, as `exclusion_union` (recurrence_derive.rs) has; without them the head can land on a moved occurrence.
      ...[...this.schedules.values()]
        .filter((s) => s.ruleId === rule.id && s.originalDate)
        .map((s) => s.originalDate!),
    ];
    // Synced series floor at their connect day (`synced_head_floor`).
    const next = oldestOpenOccurrence(
      rule.rrule,
      rule.scheduledStart,
      rule.scheduledEnd ?? null,
      exclusions,
      head.syncedSince ?? null
    );
    const before = { end: head.scheduledEnd, start: head.scheduledStart, status: head.status };
    if (next) {
      this.pages.set(pageId, {
        ...head,
        completedAt: head.status === "done" ? null : (head.completedAt ?? null),
        scheduledEnd: next.scheduledEnd,
        scheduledStart: next.scheduledStart,
        status: head.status === "done" ? "not_started" : head.status,
        updatedAt: now(),
      });
    } else if (!head.scheduleLocked || this.tickedThrough(head, rule)) {
      this.pages.set(pageId, {
        ...head,
        completedAt: head.status === "done" ? (head.completedAt ?? null) : nowLocalISO(),
        status: "done",
        updatedAt: now(),
      });
    }
    const after = this.pages.get(pageId)!;
    return (
      before.start !== after.scheduledStart ||
      before.end !== after.scheduledEnd ||
      before.status !== after.status
    );
  }

  /** `ticked_through` (recurrence_derive.rs): an exhausted live mirror completes only once
   *  the person ticked or skipped something and no moved occurrence since connecting is
   *  still open; otherwise it stays as it was. */
  private tickedThrough(head: PageSummary, rule: PageRecurrenceRule): boolean {
    const resolved = new Set(
      [...Object.keys(head.completedOccurrences ?? {}), ...(head.skippedOccurrences ?? [])].map(
        dateKey
      )
    );
    if (resolved.size === 0) return false;
    const floor = head.syncedSince ?? "";
    return ![...this.schedules.values()].some(
      (s) =>
        s.ruleId === rule.id &&
        s.originalDate &&
        dateKey(s.originalDate) >= floor &&
        !resolved.has(dateKey(s.originalDate))
    );
  }

  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult> {
    const head = this.pages.get(data.pageId);
    if (!head)
      return Promise.reject(new StorageError("NotFound", `Page not found: ${data.pageId}`));

    // Completion is set-only: a non-recurring page would mint a clone no series can suppress.
    const hasRule = [...this.rules.values()].some((r) => r.pageId === data.pageId);
    if (!hasRule) return Promise.reject(new StorageError("Conflict", NOT_RECURRING_MSG));

    let occurrenceDate: string;
    let cloneStart: string;
    let cloneEnd: string | null;
    // A supplied key routes an unlocked (detached) series through the validated
    // occurrence path too — its moved override can never be the head (pages.rs).
    if (head.scheduleLocked || data.occurrenceDate) {
      if (!data.occurrenceDate)
        return Promise.reject(new StorageError("Conflict", SYNCED_NEEDS_DATE_MSG));
      if (!data.scheduledStart)
        return Promise.reject(new StorageError("Conflict", SYNCED_NEEDS_START_MSG));
      if (!this.syncedOccurrenceValid(data.pageId, data.occurrenceDate))
        return Promise.reject(new StorageError("Conflict", OCCURRENCE_NOT_IN_SERIES_MSG));
      occurrenceDate = data.occurrenceDate;
      cloneStart = data.scheduledStart;
      cloneEnd = data.scheduledEnd ?? null;
    } else {
      if (!head.scheduledStart)
        return Promise.reject(new StorageError("Conflict", NO_OCCURRENCE_MSG));
      occurrenceDate = head.scheduledStart.slice(0, 10);
      cloneStart = head.scheduledStart;
      cloneEnd = head.scheduledEnd ?? null;
    }

    // A head a second writer advanced: if already complete the race is lost, so return the
    // winner's clone; any other move refuses.
    const expected = data.expectedOccurrenceDate;
    if (expected && expected !== occurrenceDate) {
      const wonId = head.completedOccurrences?.[expected];
      const won = wonId ? this.pages.get(wonId) : undefined;
      if (!won) return Promise.reject(new StorageError("Conflict", OCCURRENCE_ALREADY_PASSED_MSG));
      return Promise.resolve({ clone: toSummary(won), head: toSummary(head) });
    }

    // A repeat completion of the same occurrence returns the existing clone.
    const existingId = head.completedOccurrences?.[occurrenceDate];
    const existing = existingId ? this.pages.get(existingId) : undefined;
    if (existing) {
      return Promise.resolve({ clone: toSummary(existing), head: toSummary(head) });
    }

    const cloneId = uuid();
    const timestamp = now();
    // `completedAt` is local wall-clock (compared with the local day), unlike the UTC
    // created/updated_at. The clone is always a native page, the user's own completion record.
    const clone: Page = {
      ...head,
      completedAt: nowLocalISO(),
      completedOccurrences: null,
      content: head.content,
      createdAt: timestamp,
      detachIsReversible: false,
      id: cloneId,
      scheduledEnd: cloneEnd,
      scheduledStart: cloneStart,
      scheduleLocked: false,
      seriesId: head.id,
      skippedOccurrences: null,
      sortOrder: nextPageOrder(this.pages.values(), head.folderId ?? null),
      status: "done",
      syncState: null,
      updatedAt: timestamp,
    };
    this.pages.set(cloneId, clone);

    // Record on the head, then recompute onto the next open occurrence (or done), for both kinds.
    const completedOccurrences = {
      ...(head.completedOccurrences ?? {}),
      [occurrenceDate]: cloneId,
    };
    this.pages.set(head.id, { ...head, completedOccurrences });
    this.recomputeHead(head.id);

    return Promise.resolve({ clone: toSummary(clone), head: toSummary(this.pages.get(head.id)!) });
  }

  uncompleteRecurringOccurrence(data: UncompleteRecurringInput): Promise<void> {
    const head = this.pages.get(data.pageId);
    const cloneId = head?.completedOccurrences?.[data.occurrenceDate];
    if (!head || !cloneId) return Promise.resolve();
    this.pages.delete(cloneId);
    const { [data.occurrenceDate]: _removed, ...rest } = head.completedOccurrences ?? {};
    this.pages.set(head.id, {
      ...head,
      completedOccurrences: Object.keys(rest).length > 0 ? rest : null,
    });
    this.recomputeHead(head.id);
    return Promise.resolve();
  }

  skipOccurrence(data: SkipOccurrenceInput): Promise<void> {
    const head = this.pages.get(data.pageId);
    if (!head) return Promise.reject(new Error(`Page not found: ${data.pageId}`));
    const skippedOccurrences = [...(head.skippedOccurrences ?? [])];
    if (!skippedOccurrences.includes(data.occurrenceDate))
      skippedOccurrences.push(data.occurrenceDate);
    this.pages.set(head.id, { ...head, skippedOccurrences });
    this.recomputeHead(head.id);
    return Promise.resolve();
  }

  undoSkipOccurrence(data: SkipOccurrenceInput): Promise<void> {
    const head = this.pages.get(data.pageId);
    if (!head?.skippedOccurrences) return Promise.resolve();
    const skippedOccurrences = head.skippedOccurrences.filter((d) => d !== data.occurrenceDate);
    this.pages.set(head.id, {
      ...head,
      skippedOccurrences: skippedOccurrences.length > 0 ? skippedOccurrences : null,
    });
    this.recomputeHead(head.id);
    return Promise.resolve();
  }

  recomputeRecurringSchedules(): Promise<PageSummary[]> {
    const changed: PageSummary[] = [];
    for (const rule of this.rules.values()) {
      if (this.softDeleted.has(rule.pageId)) continue;
      // Active mirrors are healed too; the reason is on `recompute_recurring_schedules_impl`.
      if (this.recomputeHead(rule.pageId)) {
        const head = this.pages.get(rule.pageId);
        if (head) changed.push(toSummary(head));
      }
    }
    return Promise.resolve(changed);
  }

  rescheduleVirtualOccurrence(data: RescheduleVirtualInput): Promise<RescheduleVirtualResult> {
    const rule = this.rules.get(data.ruleId);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${data.ruleId}`));
    const head = this.pages.get(rule.pageId);
    if (!head || this.softDeleted.has(rule.pageId)) {
      return Promise.reject(new Error(`Page not found: ${rule.pageId}`));
    }
    const locked = this.lockedMirrorError(rule.pageId);
    if (locked) return Promise.reject(locked);

    const timestamp = now();

    // Synced origin: the occurrence stays in-series as an override row. Mirrors
    // reschedule_virtual_occurrence_impl (pages.rs), which owns the reasoning.
    if (head.syncState) {
      // Day-keyed: a synced timed override stores originalDate as a full wall-clock.
      const existing = [...this.schedules.values()].find(
        (s) =>
          s.ruleId === data.ruleId &&
          s.originalDate &&
          dateKey(s.originalDate) === data.originalDate
      );
      // Rebuilt, not spread: the move clears the source zone and an all-day target has no end.
      const override: PageSchedule = {
        createdAt: existing?.createdAt ?? timestamp,
        id: existing?.id ?? uuid(),
        originalDate:
          existing?.originalDate ?? originalDateInRuleBasis(data.originalDate, rule.scheduledStart),
        pageId: head.id,
        ruleId: data.ruleId,
        scheduledStart: data.scheduledStart,
        status: existing?.status ?? "not_started",
        ...(data.scheduledEnd !== undefined && { scheduledEnd: data.scheduledEnd }),
      };
      this.schedules.set(override.id, override);
      this.recomputeHead(rule.pageId);
      return Promise.resolve({ clone: null, ruleExdates: [...rule.rruleExdates] });
    }

    const clone: Page = {
      ...head,
      completedAt: null,
      createdAt: timestamp,
      id: uuid(),
      scheduledEnd: data.scheduledEnd ?? null,
      scheduledStart: data.scheduledStart,
      sortOrder: nextPageOrder(this.pages.values(), head.folderId ?? null),
      status: "not_started",
      updatedAt: timestamp,
    };
    this.pages.set(clone.id, clone);

    const schedule: PageSchedule = {
      id: uuid(),
      pageId: clone.id,
      scheduledStart: data.scheduledStart,
      ...(data.scheduledEnd !== undefined && { scheduledEnd: data.scheduledEnd }),
      createdAt: timestamp,
      status: "not_started",
      timezone: data.timezone,
    };
    this.schedules.set(schedule.id, schedule);

    const ruleExdates = rule.rruleExdates.includes(data.originalDate)
      ? [...rule.rruleExdates]
      : [...rule.rruleExdates, data.originalDate];
    this.rules.set(data.ruleId, { ...rule, rruleExdates: ruleExdates });
    this.recomputeHead(rule.pageId);

    return Promise.resolve({ clone: toSummary(clone), ruleExdates });
  }

  createFocusSession(data: NewFocusSession): Promise<FocusSession> {
    // Both refusals mirror `pikos_db::create_focus_session`; a bad row would be invisible in a settings-card sum.
    if (data.durationS <= 0) {
      return Promise.reject(
        new StorageError(
          "Invalid",
          `focus session duration must be positive, got ${data.durationS}`
        )
      );
    }
    if (!this.pages.has(data.pageId)) {
      return Promise.reject(new StorageError("NotFound", `Page not found: ${data.pageId}`));
    }
    const session: FocusSession = { ...data, id: uuid() };
    this.focusSessions.push(session);
    return Promise.resolve(session);
  }

  /** Test-only (NOT on `StorageAdapter`): the sessions written so far, since the interface is write-only. */
  listFocusSessionsForTest(): FocusSession[] {
    return [...this.focusSessions];
  }

  /** The writer's rules: "no reminders" (-1) replaces the page's reminders, a real one replaces
   *  "no reminders", and a lead the page already has returns that reminder. */
  createPageReminder(data: NewPageReminder): Promise<PageReminder> {
    const noReminders = -1;
    for (const [id, r] of this.reminders) {
      if (r.pageId !== data.pageId) continue;
      const replaced =
        data.minutesBefore === noReminders
          ? r.minutesBefore !== noReminders
          : r.minutesBefore === noReminders;
      if (replaced) this.reminders.delete(id);
    }
    const existing = [...this.reminders.values()].find(
      (r) => r.pageId === data.pageId && r.minutesBefore === data.minutesBefore
    );
    if (existing) return Promise.resolve(existing);
    const reminder: PageReminder = {
      createdAt: now(),
      id: uuid(),
      minutesBefore: data.minutesBefore,
      pageId: data.pageId,
    };
    this.reminders.set(reminder.id, reminder);
    return Promise.resolve(reminder);
  }

  listPageReminders(pageId: string): Promise<PageReminder[]> {
    const results = [...this.reminders.values()]
      .filter((r) => r.pageId === pageId)
      .sort((a, b) => a.minutesBefore - b.minutesBefore);
    return Promise.resolve(results);
  }

  deletePageReminder(id: string): Promise<void> {
    this.reminders.delete(id);
    return Promise.resolve();
  }

  deletePageReminders(pageId: string): Promise<void> {
    for (const [id, r] of this.reminders) {
      if (r.pageId === pageId) this.reminders.delete(id);
    }
    return Promise.resolve();
  }

  listNotificationHistory(limit: number): Promise<NotificationHistoryEntry[]> {
    // Joins the page title live, as the writer does: a renamed page shows its new name, a deleted one null.
    const rows = [...this.notificationHistory]
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      .slice(0, Math.max(0, limit))
      .map((entry) => ({
        ...entry,
        pageTitle: entry.pageId != null ? (this.pages.get(entry.pageId)?.title ?? null) : null,
      }));
    return Promise.resolve(rows);
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): puts folders and pages in place exactly as given,
   * ids, order values and timestamps included, for replaying a workspace the real database wrote.
   */
  seedExact(folders: Folder[], pages: Page[]): void {
    for (const folder of folders) this.folders.set(folder.id, folder);
    for (const page of pages) this.pages.set(page.id, page);
  }

  /** Test/seed-only (NOT on `StorageAdapter`): stands in for the Rust scheduler, the log's only writer. */
  seedNotificationHistory(entries: NotificationHistoryEntry[]): void {
    this.notificationHistory = [...entries];
  }

  private _refreshDenorm(pageId: string): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    // As `refresh_schedule_denorm` (schedules.rs): rrule-backed pages own their denorm, so
    // refreshing from page_schedules would clobber the head back to a lingering past anchor row
    // after a completion advance.
    for (const rule of this.rules.values()) {
      if (rule.pageId === pageId) return;
    }
    // The earliest upcoming non-override schedule, else the earliest past one, else null. A
    // past-only event must keep its denorm or the next write reverts a just-created chip.
    const today = new Date().toISOString().slice(0, 10);
    const candidates = [...this.schedules.values()].filter((s) => s.pageId === pageId && !s.ruleId);
    const next = candidates.sort((a, b) => {
      const aGroup = a.scheduledStart >= today ? 0 : 1;
      const bGroup = b.scheduledStart >= today ? 0 : 1;
      if (aGroup !== bGroup) return aGroup - bGroup;
      return a.scheduledStart.localeCompare(b.scheduledStart);
    })[0];
    const updated = { ...page, updatedAt: now() };
    if (next) {
      updated.scheduledStart = next.scheduledStart;
      if (next.scheduledEnd) updated.scheduledEnd = next.scheduledEnd;
      else delete updated.scheduledEnd;
    } else {
      delete updated.scheduledStart;
      delete updated.scheduledEnd;
    }
    this.pages.set(pageId, updated);
  }

  connectCaldavAccount(data: NewCaldavConnection): Promise<AccountWithCalendars> {
    return Promise.resolve(
      this._connectAccount(
        "caldav",
        data.displayName,
        "basic",
        this.stagedCaldavCalendars ?? CANNED_CALDAV_CALENDARS
      )
    );
  }

  reconnectCaldavAccount(accountId: string, password: string): Promise<AccountWithCalendars> {
    const account = this.syncAccounts.get(accountId);
    if (!account) return Promise.reject(new Error(`sync account not found: ${accountId}`));
    // The real path proves the password by discovery; with no server here, an empty one stands in for rejection.
    if (!password) return Promise.reject(new Error("Could not connect. Check the password."));
    const next = { ...account, reconnectNeeded: false };
    this.syncAccounts.set(accountId, next);
    this.dormantAccounts.delete(accountId);
    return Promise.resolve({ ...next, calendars: this._calendarsFor(accountId) });
  }

  connectGoogleAccount(): Promise<AccountWithCalendars> {
    return Promise.resolve(
      this._connectAccount("google", "you@gmail.com", "oauth", [
        { displayName: "you@gmail.com" },
        { displayName: "Team" },
      ])
    );
  }

  googleSyncAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private _connectAccount(
    provider: string,
    displayName: string,
    authKind: string,
    calendars: StagedCalendar[]
  ): AccountWithCalendars {
    // Identity is provider + displayName, dormant or not (`find_account_by_identity_impl`);
    // matching only dormant rows would mint a second account for an already-active identity.
    const existing = [...this.syncAccounts.values()]
      .filter((a) => a.provider === provider && a.displayName === displayName)
      .sort(
        (a, b) => Number(this.dormantAccounts.has(a.id)) - Number(this.dormantAccounts.has(b.id))
      )[0];
    if (existing) {
      this.dormantAccounts.delete(existing.id);
      return { ...existing, calendars: this._calendarsFor(existing.id) };
    }

    const account: SyncAccount = {
      authKind,
      createdAt: now(),
      displayName,
      id: uuid(),
      provider,
      reconnectNeeded: false,
    };
    this.syncAccounts.set(account.id, account);
    for (const staged of calendars) {
      const cal: SyncCalendar = {
        accountId: account.id,
        calendarId: `${provider}-${staged.displayName.toLowerCase()}-cal`,
        color: staged.color ?? null,
        detachedPages: 0,
        displayName: staged.displayName,
        enabled: false,
        folderId: null,
        id: uuid(),
        lastSyncedAt: null,
      };
      this.syncCalendars.set(cal.id, cal);
      if (staged.events) this.providerEvents.set(cal.id, staged.events);
    }
    return { ...account, calendars: this._calendarsFor(account.id) };
  }

  async disconnectSyncAccount(accountId: string): Promise<void> {
    // Dormant, not deleted (`go_dormant`). The folder link is severed here, or a reconnect mints
    // a second folder beside the detached pages.
    for (const cal of this._calendarsFor(accountId)) {
      await this.toggleSyncCalendar(cal.id, false, cal.color);
    }
    this.dormantAccounts.add(accountId);
  }

  /** Ownership, as `PAGE_OWNED_SQL` defines it: anything of the user's on the page.
   *  Errs toward keeping — a page that matches survives teardown, detached. */
  private _isOwned(page: Page): boolean {
    return (
      page.completedAt != null ||
      this.userModified.has(page.id) ||
      (page.tags?.length ?? 0) > 0 ||
      [...this.reminders.values()].some((r) => r.pageId === page.id) ||
      Object.keys(page.completedOccurrences ?? {}).length > 0 ||
      (page.skippedOccurrences?.length ?? 0) > 0
    );
  }

  /** `teardown_calendar`: bare mirrors are destroyed, owned pages detach in place, and the
   *  folder is deleted only when nothing survived it. Returns how many pages detached. A
   *  tombstoned page keeps its trashed copy and loses only the link, so a resync recreates the event. */
  private _teardownCalendar(folderId: string): string[] {
    const detached: string[] = [];
    for (const page of [...this.pages.values()]) {
      if (page.folderId !== folderId || !page.syncState) continue;
      if (page.syncState === "detached") continue;
      if (page.syncState === "tombstoned") {
        this.pages.set(page.id, { ...page, scheduleLocked: false, syncState: null });
        continue;
      }
      if (this._isOwned(page)) {
        // Teardown leaves the calendar row switched off, so switching it on again rejoins the
        // page (`sc.enabled = 0 OR sa.disconnected = 1`).
        this.pages.set(page.id, {
          ...page,
          detachIsReversible: true,
          scheduleLocked: false,
          syncState: "detached",
        });
        detached.push(page.id);
      } else {
        this.pages.delete(page.id);
      }
    }
    const survivors = [...this.pages.values()].some(
      (p) => p.folderId === folderId && !this.softDeleted.has(p.id)
    );
    const folder = this.folders.get(folderId);
    if (!survivors) this.folders.delete(folderId);
    else if (folder) {
      this.folders.set(folderId, { ...folder, isExternalCalendar: false, updatedAt: now() });
    }
    return detached;
  }

  /** What a backfill converges to with no provider to re-read from: the calendar reclaims the
   *  pages its own teardown detached, and a re-linked page is a locked mirror again
   *  (`find_relink` + `reclaim_calendar_folder`). Trashed pages stay severed, as in the real re-link.
   *
   *  Scoped to what this teardown severed: a page severed some other way is one the provider no
   *  longer sends, and reclaiming it would describe a state sync cannot reach. */
  private _relinkCalendar(pageIds: string[]): void {
    for (const pageId of pageIds) {
      const page = this.pages.get(pageId);
      if (!page || page.syncState !== "detached" || this.softDeleted.has(pageId)) continue;
      this.pages.set(pageId, { ...page, scheduleLocked: true, syncState: "active" });
    }
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): the calendars the next CalDAV discovery finds in
   * place of the canned Personal and Work, with each one's colour and the events that switching
   * it on backfills as active mirrors.
   */
  stageCaldavCalendars(calendars: StagedCalendar[]): void {
    this.stagedCaldavCalendars = calendars;
  }

  /** Mirrors each provider event the folder doesn't hold. Title and start stand in for the provider uid, so a re-enable doesn't plant a twin beside a reclaimed page. */
  private _backfillCalendar(syncCalendarId: string, folderId: string): void {
    const key = (title: string, start: string | null | undefined) => `${title}\u0000${start}`;
    const present = new Set(
      [...this.pages.values()]
        .filter((p) => p.folderId === folderId && p.syncState === "active")
        .map((p) => key(p.title, p.scheduledStart))
    );
    for (const event of this.providerEvents.get(syncCalendarId) ?? []) {
      if (present.has(key(event.title, event.scheduledStart))) continue;
      const page = this.insertPage({
        content: "",
        folderId,
        priority: 0,
        scheduledStart: event.scheduledStart,
        status: "not_started",
        tags: [],
        title: event.title,
        ...(event.scheduledEnd ? { scheduledEnd: event.scheduledEnd } : {}),
      });
      this.markPageSynced(page.id, {
        state: "active",
        ...(event.timezone ? { timezone: event.timezone } : {}),
        ...(event.location ? { location: event.location } : {}),
      });
    }
  }

  listSyncCalendars(accountId: string): Promise<SyncCalendar[]> {
    return Promise.resolve(this._calendarsFor(accountId));
  }

  toggleSyncCalendar(
    syncCalendarId: string,
    enabled: boolean,
    color: string | null
  ): Promise<SyncCalendar> {
    const cal = this.syncCalendars.get(syncCalendarId);
    if (!cal) return Promise.reject(new Error(`Sync calendar not found: ${syncCalendarId}`));
    let folderId = cal.folderId;
    let detachedPages = enabled ? 0 : cal.detachedPages;
    if (enabled && !folderId) {
      const folder: Folder = {
        createdAt: now(),
        id: uuid(),
        isExternalCalendar: true,
        name: cal.displayName,
        parentId: null,
        sortOrder: nextSortOrder([...this.folders.values()]),
        updatedAt: now(),
        ...(color != null ? { color } : {}),
      };
      this.folders.set(folder.id, folder);
      folderId = folder.id;
    } else if (!enabled && folderId) {
      const severed = this._teardownCalendar(folderId);
      this.detachedByCalendar.set(syncCalendarId, severed);
      detachedPages = severed.length;
      // Keep the link while the de-flagged folder survives, or a re-enable mints a second folder
      // and strands the detached pages in the first.
      if (!this.folders.has(folderId)) folderId = null;
    }
    // Re-asserts the name and colour the calendar owns, not what the folder had while off.
    if (enabled && folderId) {
      const folder = this.folders.get(folderId);
      if (folder) {
        this.folders.set(folderId, {
          ...folder,
          isExternalCalendar: true,
          name: cal.displayName,
          updatedAt: now(),
          ...(color != null ? { color } : {}),
        });
      }
      this._relinkCalendar(this.detachedByCalendar.get(syncCalendarId) ?? []);
      this.detachedByCalendar.delete(syncCalendarId);
      this._backfillCalendar(syncCalendarId, folderId);
    }
    const updated: SyncCalendar = { ...cal, color, detachedPages, enabled, folderId };
    this.syncCalendars.set(syncCalendarId, updated);
    return Promise.resolve(updated);
  }

  setSyncCalendarColor(syncCalendarId: string, color: string): Promise<SyncCalendar> {
    const cal = this.syncCalendars.get(syncCalendarId);
    if (!cal) return Promise.reject(new Error(`Sync calendar not found: ${syncCalendarId}`));
    const updated: SyncCalendar = { ...cal, color };
    this.syncCalendars.set(syncCalendarId, updated);
    if (cal.folderId) {
      const folder = this.folders.get(cal.folderId);
      if (folder) this.folders.set(cal.folderId, { ...folder, color, updatedAt: now() });
    }
    return Promise.resolve(updated);
  }

  resyncSyncAccount(accountId: string): Promise<CalendarSyncResult[]> {
    return Promise.resolve(this._pollAccount(accountId));
  }

  // Identical to a resync: no cursor to drop, and `fullResync` stays false on the real path too.
  refreshSyncAccount(accountId: string): Promise<CalendarSyncResult[]> {
    return Promise.resolve(this._pollAccount(accountId));
  }

  getSyncStatus(): Promise<AccountWithCalendars[]> {
    return Promise.resolve(
      [...this.syncAccounts.values()]
        .filter((a) => !this.dormantAccounts.has(a.id))
        .map((a) => ({
          ...a,
          calendars: this._calendarsFor(a.id),
        }))
    );
  }

  // No filesystem: writes resolve without doing anything and path-returning calls hand back a stable fake.

  backupDatabase(): Promise<string> {
    return Promise.resolve("/mock/pikos-backup.sqlite");
  }

  backupBeforeImport(): Promise<void> {
    return Promise.resolve();
  }

  /** Two entries so a test can tell "newest first" from "in directory order",
   *  and one of each kind the settings panel labels differently. */
  listBackups(): Promise<BackupEntry[]> {
    return Promise.resolve([
      {
        bytes: 204_800,
        createdAt: "2026-07-02T09:00:00.000Z",
        fileName: "pre-import-2026-07-02T09-00-00.sqlite",
        kind: "preImport",
      },
      {
        bytes: 196_608,
        createdAt: "2026-07-01T09:00:00.000Z",
        fileName: "pre-migration-20260701T090000000Z-v9-to-v12.sqlite",
        kind: "preMigration",
      },
    ]);
  }

  restoreBackup(): Promise<void> {
    return Promise.resolve();
  }

  exportWorkspace(format: WorkspaceExportFormat, options: WorkspaceExportOptions): Promise<string> {
    this.lastExport = { format, options };
    return Promise.resolve(`/mock/pikos-export.${format}`);
  }

  exportPageMarkdown(id: string): Promise<string> {
    return Promise.resolve(`/mock/${id}.md`);
  }

  /** Counted from the in-memory maps so the panel shows the seeded workspace
   *  rather than zeroes. The activity chart has no source here and stays empty. */
  getUsageStats(_weekStartsOn: 0 | 1): Promise<WorkspaceUsageStats> {
    const pages = [...this.pages.values()].filter((p) => !this.softDeleted.has(p.id));
    const tags = new Set(pages.flatMap((p) => p.tags));
    // Truncated like the backend's SQLite integer division; rounding would read higher than prod.
    const focusSeconds = this.focusSessions.reduce((sum, s) => sum + s.durationS, 0);
    return Promise.resolve({
      first_page_date: pages.map((p) => p.createdAt).sort()[0] ?? null,
      has_calendar_sync: this.syncAccounts.size > 0,
      has_focus_sessions: this.focusSessions.length > 0,
      has_folders: this.folders.size > 0,
      has_priorities: pages.some((p) => p.priority !== 0),
      has_recurring: this.rules.size > 0,
      has_reminders: this.reminders.size > 0,
      has_schedules: this.schedules.size > 0,
      has_subtasks: pages.some((p) => p.parentId != null),
      has_tags: tags.size > 0,
      total_completed: pages.filter(isDone).length,
      total_focus_minutes: Math.floor(focusSeconds / 60),
      total_focus_sessions: this.focusSessions.length,
      total_folders: this.folders.size,
      total_pages: pages.length,
      // Pages with a date, as `get_usage_stats` counts them, not schedule rows.
      total_schedules: pages.filter((p) => p.scheduledStart != null).length,
      // Same count as `get_usage_stats`: spaces plus one, per non-empty body.
      total_words: pages
        .map((p) => this.pages.textOf(p))
        .filter((text) => text !== "")
        .reduce((sum, text) => sum + text.split(" ").length, 0),
      weekly_activity: [],
    });
  }

  /** Truncates, matching `reset_db`. */
  resetWorkspaceData(): Promise<void> {
    this.clear();
    return Promise.resolve();
  }

  wipeAllData(): Promise<void> {
    this.clear();
    return Promise.resolve();
  }

  releaseSyncCredentials(): Promise<void> {
    return Promise.resolve();
  }

  recordFirstRunSeed(): Promise<void> {
    return Promise.resolve();
  }

  private _pollAccount(accountId: string): CalendarSyncResult[] {
    const synced = this._calendarsFor(accountId).filter((c) => c.enabled);
    // Stamps freshness as `persist_progress` does, or a mock-mode calendar reads stale forever.
    for (const c of synced) {
      this.syncCalendars.set(c.id, { ...c, lastSyncedAt: now() });
    }
    return synced.map((c) => ({
      calendarId: c.calendarId,
      fullResync: false,
      status: "synced" as const,
    }));
  }

  private _calendarsFor(accountId: string): SyncCalendar[] {
    return [...this.syncCalendars.values()].filter((c) => c.accountId === accountId);
  }
}
