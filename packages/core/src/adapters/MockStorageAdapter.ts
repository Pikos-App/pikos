// In-memory StorageAdapter for tests — injected via VITE_TEST_MODE.

import { StorageError } from "../errors";
import type {
  FolderUpdate,
  NewCaldavConnection,
  NewFolder,
  NewPage,
  NewPageReminder,
  NewPageSchedule,
  NewRecurrenceRule,
  PageScheduleUpdate,
  PageUpdate,
  RecurrenceRuleUpdate,
  StorageAdapter,
} from "../storage";
import type {
  AccountWithCalendars,
  CalendarSyncResult,
  CompletedPagesFilter,
  CompletedPagesResponse,
  CompleteRecurringInput,
  CompleteRecurringResult,
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
  SearchResult,
  SkipOccurrenceInput,
  SyncAccount,
  SyncCalendar,
  TrashedPage,
  UncompleteRecurringInput,
} from "../types";
import { dateKey, formatDateOnly, nowLocalISO, parseLocalISO } from "../utils/dates";
import { extractText } from "../utils/extractText";
import { isDone, isOpen } from "../utils/page";
import { oldestOpenOccurrence, rawExpandRule } from "../utils/recurrence";
import { ftsTokens, mirrorSearchText } from "../utils/search";

/**
 * Command-layer guard messages, mirrored verbatim from the Rust writers so a
 * mis-routed write fails identically in test mode and in prod. The mock is the
 * only place e2e and unit tests ever see these rejections, so a message the
 * backend has since reworded still reads as correct here and the test asserting
 * it still passes — against words no user is shown. `guardMessages.test.ts` checks
 * this table against the Rust source rather than trusting lockstep edits, and
 * sweeps the writers for refusals missing from it.
 */
export const MIRRORED_GUARD_MESSAGES = {
  createdInCalendarFolder: "Pages cannot be created in an external calendar folder",
  externalFolderLocked:
    "External calendar folders are system-managed — use the Calendar Sync settings to disconnect.",
  intoCalendarFolder: "Pages cannot be moved into an external calendar folder",
  noOccurrence: "Recurring page has no scheduled occurrence to complete.",
  notRecurring: "Occurrence completion applies only to a recurring series.",
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

/** Best-effort plain-text extraction from a Tiptap JSON string. Mirrors the
 *  Rust adapter's contentText denorm so the mock's FTS surface matches prod. */
function deriveContentText(content: string): string {
  try {
    return extractText(JSON.parse(content));
  } catch {
    return "";
  }
}

/** An occurrence's own start in the basis a provider's override carries. Mirrors
 *  `original_date_in_rule_basis` (pages.rs), which owns the reasoning. */
function originalDateInRuleBasis(occurrenceDate: string, ruleStart: string): string {
  const day = occurrenceDate.slice(0, 10);
  const time = ruleStart.split("T")[1];
  return time ? `${day}T${time}` : day;
}

function nextSortOrder(items: { sortOrder: number }[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((i) => i.sortOrder)) + 1;
}

/** All terms must be present, the last one as a prefix — the shape of the query
 *  `search_pages_impl` builds (implicit AND, trailing `*` on the final token). */
function ftsMatches(terms: string[], document: string): boolean {
  const docTokens = ftsTokens(document);
  return terms.every((term, i) =>
    i === terms.length - 1 ? docTokens.some((d) => d.startsWith(term)) : docTokens.includes(term)
  );
}

function excerptAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).find((i) => i >= 0) ?? -1;
  if (hit < 0) return "";
  return text.slice(Math.max(0, hit - 40), hit + 40);
}

function toSummary(page: Page): PageSummary {
  const { content: _, contentText: _ct, ...summary } = page;
  return summary;
}

function matchesFilter(page: Page, filter: PageFilter): boolean {
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
    // Title and extracted text only, matching the writer's `title LIKE … OR
    // content_text LIKE …`. Searching the raw Tiptap JSON instead made "paragraph"
    // and "doc" match every page here and nothing in the real database.
    const haystack = `${page.title} ${page.contentText ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export class MockStorageAdapter implements StorageAdapter {
  private pages = new Map<string, Page>();
  private folders = new Map<string, Folder>();
  private schedules = new Map<string, PageSchedule>();
  private rules = new Map<string, PageRecurrenceRule>();
  private reminders = new Map<string, PageReminder>();
  // The notification log. Its only real writer is the Rust scheduler, which has
  // no twin here (nothing in test mode ticks a clock or talks to the OS), so
  // this stays empty unless a test seeds it via `seedNotificationHistory`.
  private notificationHistory: NotificationHistoryEntry[] = [];
  // `pages.deleted_at`: the id mapped to *when* it was trashed, not just that it
  // was. The trash sorts on that stamp and the retention sweep compares against
  // it, so a Set (which is all the hidden-from-lists behaviour ever needed) would
  // leave both of those untestable here.
  private softDeleted = new Map<string, string>();
  private softDeletedFolders = new Set<string>();
  private syncAccounts = new Map<string, SyncAccount>();
  private syncCalendars = new Map<string, SyncCalendar>();
  // Disconnected (dormant) accounts: kept for reconnect re-link, hidden from status.
  private dormantAccounts = new Set<string>();
  // Pages each calendar's own teardown severed, so a re-enable reclaims those and
  // not whatever else in the folder happens to be detached — see `_relinkCalendar`.
  private detachedByCalendar = new Map<string, string[]>();
  // `page_sync.user_modified`: set by the editor path, never by sync. One half of
  // the ownership predicate teardown and export share — see `_isOwned`.
  private userModified = new Set<string>();

  clear(): void {
    this.pages.clear();
    this.folders.clear();
    this.schedules.clear();
    this.rules.clear();
    this.reminders.clear();
    this.notificationHistory = [];
    this.softDeleted.clear();
    this.softDeletedFolders.clear();
    this.syncAccounts.clear();
    this.syncCalendars.clear();
    this.dormantAccounts.clear();
    this.detachedByCalendar.clear();
    this.userModified.clear();
  }

  // ─── Command-layer guards ────────────────────────────────────────────────────

  /** The locked-mirror rejection the backend's `ensure_page_schedule_unlocked`
   *  throws for a synced (`active`) page, else null. Returned (not thrown) so callers
   *  reject the promise — a synchronous throw would break `.rejects` matchers. */
  private lockedMirrorError(pageId: string | undefined): StorageError | null {
    return pageId != null && this.pages.get(pageId)?.scheduleLocked
      ? new StorageError("Conflict", SYNCED_READONLY_MSG)
      : null;
  }

  /** Backend `synced_occurrence_is_valid`: is `day` (YYYY-MM-DD) a real occurrence
   *  of the page's rule? Guards against a cross-zone off-by-one occurrence key that
   *  would write an unsuppressable completed-set entry. */
  private syncedOccurrenceValid(pageId: string, day: string): boolean {
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId);
    const page = this.pages.get(pageId);
    if (!rule || !page) return false;
    const lo = parseLocalISO(`${day}T00:00:00`);
    const hi = parseLocalISO(`${day}T23:59:59`);
    return rawExpandRule(rule, page, lo, hi).some((o) => o.originalDate === day);
  }

  // ─── Pages ──────────────────────────────────────────────────────────────────

  getPage(id: string): Promise<Page | null> {
    return Promise.resolve(this.pages.get(id) ?? null);
  }

  createPage(data: NewPage): Promise<Page> {
    // Only the reconciler seeds into a calendar folder — a page created there is
    // trapped by updatePage's placement lock (matches create_page_impl, pages.rs).
    if (data.folderId != null && this.folders.get(data.folderId)?.isExternalCalendar) {
      return Promise.reject(new StorageError("Conflict", CREATED_IN_CALENDAR_FOLDER_MSG));
    }
    return Promise.resolve(this.insertPage(data));
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): create a page inside a calendar
   * folder, which `createPage` refuses. Stands for the reconciler, whose raw SQL
   * is the only writer that seeds a mirror — the command-layer guard exists so
   * that nothing reachable from the UI can. Seeding through `createPage` instead
   * would mean the guard could never be turned on here without breaking every
   * synced fixture, which is how it stayed unmirrored.
   */
  seedMirrorPage(data: NewPage): Promise<Page> {
    return Promise.resolve(this.insertPage(data));
  }

  private insertPage(data: NewPage): Page {
    const page: Page = {
      links: [],
      ...data,
      // Mirror the Rust adapter, which extracts plain text from Tiptap JSON on
      // every save so FTS indexes the visible body, not the structural tokens.
      contentText: data.contentText ?? deriveContentText(data.content),
      createdAt: now(),
      id: uuid(),
      isRecurring: false,
      scheduleLocked: false,
      sortOrder: nextSortOrder([...this.pages.values()]),
      updatedAt: now(),
    };
    this.pages.set(page.id, page);
    return page;
  }

  /**
   * Test/seed-only (NOT on `StorageAdapter`): stamp a page with the synced
   * provenance a real `page_sync` row would derive — `scheduleLocked`,
   * `syncState`, the source `timezone`, and the read-only mirror metadata
   * (`mirrorLocation`, `mirrorAttendees`, `pendingDescription`). Lets the
   * synced-pages seed + UI tests exercise the locked/zoned/detached
   * treatment and the description-changed notice without a reconciler.
   * `active` locks the schedule; `detached`/`tombstoned` leave it editable.
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
      /**
       * `page_sync.user_modified`. In the app only the editor path sets it, so a
       * fixture that needs an already-owned mirror could not build one — the
       * seeded state was unreachable, and teardown destroyed a page the real
       * writer keeps. Seeds pass it the way the SQL seeder binds the column
       * (db/dev/seed.rs); nothing on `StorageAdapter` can.
       */
      userModified?: boolean;
    } = {}
  ): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const state = opts.state ?? "active";
    // Sticky, like the column: once the user owns a mirror, a later re-stamp of
    // its provenance (a resync writing fresh mirror metadata) never disowns it.
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

  /**
   * Test/seed-only (NOT on `StorageAdapter`): read `page_sync.user_modified` back.
   * The flag is otherwise only observable through what teardown does with the page,
   * which is too coarse for the seed-conformance table to name it.
   */
  isPageUserModified(pageId: string): boolean {
    return this.userModified.has(pageId);
  }

  /**
   * Test-only (NOT on `StorageAdapter`): park the head on a date the derivation
   * disagrees with. A session left open across midnight produces exactly this, and
   * no adapter method can — `updatePage` refuses a locked mirror's schedule, which
   * is the case the foreground heal most needs to be tested on.
   */
  setHeadScheduleForTest(pageId: string, scheduledStart: string): void {
    const page = this.pages.get(pageId);
    if (page) this.pages.set(pageId, { ...page, scheduledStart });
  }

  updatePage(id: string, updates: PageUpdate): Promise<Page> {
    const existing = this.pages.get(id);
    if (!existing) return Promise.reject(new Error(`Page not found: ${id}`));
    // Placement lock, keyed on the live sync link rather than the folder: nothing
    // moves into a calendar folder, and an actively-synced page can't leave. Once
    // detached it is the user's and files anywhere. The reclaim path writes the
    // folder directly, as the reconciler does, so it isn't stopped by this.
    if (updates.folderId !== undefined) {
      const target = updates.folderId != null ? this.folders.get(updates.folderId) : undefined;
      if (target?.isExternalCalendar) {
        return Promise.reject(new StorageError("Conflict", INTO_CALENDAR_FOLDER_MSG));
      }
      if (existing.scheduleLocked) {
        return Promise.reject(new StorageError("Conflict", SYNCED_PLACEMENT_MSG));
      }
    }
    // Locked mirror: title + schedule are calendar-owned on a synced page.
    // Body/meta/status/tags stay editable (matches update_page_impl, pages.rs).
    if (
      updates.title !== undefined ||
      updates.scheduledStart !== undefined ||
      updates.scheduledEnd !== undefined
    ) {
      const locked = this.lockedMirrorError(id);
      if (locked) return Promise.reject(locked);
    }
    // Editing an authored field claims ownership, so an upstream delete or an
    // unsync detaches the page instead of destroying it. Reading and arranging
    // author nothing (`marks_ownership`, pages.rs).
    if (Object.keys(updates).some((k) => k !== "sortOrder" && k !== "lastOpenedAt")) {
      this.userModified.add(id);
    }
    const updated: Page = { ...existing, ...updates, id, updatedAt: now() };
    // Keep contentText in sync with content unless the caller explicitly set it.
    if (updates.content !== undefined && updates.contentText === undefined) {
      updated.contentText = deriveContentText(updates.content);
    }
    this.pages.set(id, updated);
    return Promise.resolve(updated);
  }

  deletePage(id: string): Promise<void> {
    this.pages.delete(id);
    // The schema cascades everything hanging off a page; without this the mock
    // keeps orphan rows the real database cannot hold.
    for (const [rid, r] of this.reminders) if (r.pageId === id) this.reminders.delete(rid);
    for (const [sid, s] of this.schedules) if (s.pageId === id) this.schedules.delete(sid);
    for (const [rid, r] of this.rules) if (r.pageId === id) this.rules.delete(rid);
    return Promise.resolve();
  }

  clearPendingDescription(id: string): Promise<void> {
    const page = this.pages.get(id);
    // Only the column, matching the writer: the seeded hash the mock stands in
    // for stays where it was, so the body keeps reading as the user's.
    if (page) this.pages.set(id, { ...page, pendingDescription: null });
    return Promise.resolve();
  }

  softDeletePage(id: string): Promise<void> {
    // Guarded like the writer: a second delete must not overwrite the original
    // stamp and hand the page another 30 days.
    if (!this.softDeleted.has(id)) this.softDeleted.set(id, now());
    return Promise.resolve();
  }

  restorePage(id: string): Promise<void> {
    this.softDeleted.delete(id);
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
        // `EXISTS(page_sync)`: any link at all, which is the predicate the delete
        // path diverts on — not just an active one.
        isSynced: page.syncState != null,
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
      // A mirror keeps its place in the trash: destroying the row would take the
      // tombstone with it and the next sync pass would re-create the event
      // (`purge_trashed_pages_older_than`, which reuses the same divert).
      if (page && page.syncState != null) continue;
      this.softDeleted.delete(id);
      void this.deletePage(id);
      purged++;
    }
    return Promise.resolve(purged);
  }

  listPages(filter?: PageFilter): Promise<PageSummary[]> {
    const all = [...this.pages.values()].filter((p) => !this.softDeleted.has(p.id));
    const filtered = filter ? all.filter((p) => matchesFilter(p, filter)) : all;
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
    if (terms.length === 0) return Promise.resolve({ completedCount: 0, results: [] });
    const titleResults: SearchResult[] = [];
    const contentResults: SearchResult[] = [];
    let completedCount = 0;
    for (const page of this.pages.values()) {
      if (this.softDeleted.has(page.id)) continue;
      // Title, subtitle, body text, tags and a mirror's calendar-owned metadata
      // are one indexed document, so a query spanning two of them still matches.
      // Extracted text, never the raw Tiptap JSON — the index never returns a
      // page because the user typed "paragraph".
      const subtitle = page.subtitle ?? "";
      const body = page.contentText ?? "";
      const mirror = mirrorSearchText(page.mirrorLocation, page.mirrorAttendees) ?? "";
      if (!ftsMatches(terms, [page.title, subtitle, body, page.tags.join(" "), mirror].join(" "))) {
        continue;
      }
      if (isDone(page)) {
        completedCount++;
        if (!includeCompleted) continue;
      }
      // Labelling is the writer's own post-selection heuristic (search.rs), which
      // is a looser substring test than selection — a row is already a hit by here.
      const titleLower = page.title.toLowerCase();
      const titleMatch = terms.some((t) => titleLower.includes(t));
      const subtitleLower = subtitle.toLowerCase();
      const subtitleMatch = terms.some((t) => subtitleLower.includes(t));
      // Matched on, never quoted: the excerpt is body only (`build_excerpt`, search.rs).
      // A hit only in the mirror metadata quotes the metadata — same fallback and
      // display join as `build_mirror_excerpt` (search.rs), which owns why.
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
        contentPreview: (page.contentText ?? "").slice(0, 80),
        priority: page.priority,
        scheduledDate: page.scheduledStart ?? null,
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
    // Title matches first. Deliberately not a bm25 reproduction: the weighted rank
    // is not reachable without the index, so order here is an approximation and no
    // test should assert on it beyond title-before-content.
    const results = [...titleResults, ...contentResults].slice(0, 20);
    return Promise.resolve({ completedCount, results });
  }

  // ─── Folders ────────────────────────────────────────────────────────────────

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
    // Placement lock: a calendar folder can't be reparented and nothing nests under
    // one; name and colour stay editable (matches update_folder_impl, folders.rs).
    if (updates.parentId !== undefined) {
      const intoExternal =
        updates.parentId != null && this.folders.get(updates.parentId)?.isExternalCalendar;
      if (intoExternal || existing.isExternalCalendar) {
        return Promise.reject(new StorageError("Conflict", EXTERNAL_FOLDER_LOCKED_MSG));
      }
    }
    const updated: Folder = { ...existing, ...updates, id, updatedAt: now() };
    this.folders.set(id, updated);
    // Mirrors the real writer: a sidebar recolour reaches the calendar too.
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
    // Soft-delete all pages in this folder (mirrors Rust backend behavior)
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.softDeleted.set(page.id, now());
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
      if (page.folderId === id) this.softDeleted.set(page.id, now());
    }
    return Promise.resolve();
  }

  restoreFolder(id: string): Promise<void> {
    this.softDeletedFolders.delete(id);
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.softDeleted.delete(page.id);
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

  // ─── Schedules ──────────────────────────────────────────────────────────────

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
      // Mirrors Rust: schedules of a soft-deleted page are excluded (the SQL
      // joins pages and filters `deleted_at IS NULL`).
      if (this.softDeleted.has(s.pageId)) return false;
      return s.ruleId != null && wanted.has(s.ruleId);
    });
    return Promise.resolve(
      results.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
    );
  }

  // ─── Recurrence rules ────────────────────────────────────────────────────────

  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const locked = this.lockedMirrorError(data.pageId);
    if (locked) return Promise.reject(locked);
    // SQL enforces UNIQUE(page_id) on page_recurrence_rules — a page has at
    // most one rule. Mirror it so tests that accidentally create two surface
    // the conflict here instead of passing the mock and failing in prod.
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
    // Merge into the CURRENT row (mirrors the Rust read-merge-write tx) — never
    // a replacement, so exdates written since the caller's snapshot survive.
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

  /** Mirrors the Rust `is_recurring` EXISTS projection, which the mock stores as a
   * flag rather than deriving per read — same shape as `scheduleLocked`. */
  private setRecurringFlag(pageId: string, value: boolean): void {
    const page = this.pages.get(pageId);
    if (page) this.pages.set(pageId, { ...page, isRecurring: value });
  }

  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null> {
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId) ?? null;
    return Promise.resolve(rule);
  }

  listRecurrenceRules(): Promise<PageRecurrenceRule[]> {
    // Rust filters via `pages.deleted_at IS NULL`. Mock soft-delete tracks the
    // same state in the in-memory Set, so check there — `p.deletedAt` is never
    // set by softDeletePage and reading it here was always returning everything.
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

  /** Re-derives `head.scheduledStart` (or terminal `done`) from truth — the rule
   * base minus the exclusion union (completed ∪ skip ∪ rruleExdates) — mirroring
   * the Rust `recompute_recurring_schedule`. The single writer of a recurring
   * head's cache; every set-changing op calls it. Returns whether anything changed. */
  private recomputeHead(pageId: string): boolean {
    const head = this.pages.get(pageId);
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId);
    if (!head || !rule) return false;
    const exclusions = [
      ...rule.rruleExdates,
      ...Object.keys(head.completedOccurrences ?? {}),
      ...(head.skippedOccurrences ?? []),
      // Materialised overrides, matching exclusion_union (recurrence_derive.rs) —
      // without them the head can land back on an occurrence that moved away.
      ...[...this.schedules.values()]
        .filter((s) => s.ruleId === rule.id && s.originalDate)
        .map((s) => s.originalDate!),
    ];
    // Synced series floor at their connect day — see `synced_head_floor`.
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
    } else {
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

  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult> {
    const head = this.pages.get(data.pageId);
    if (!head)
      return Promise.reject(new StorageError("NotFound", `Page not found: ${data.pageId}`));

    // Occurrence completion is set-only — a mis-route to a non-recurring page would
    // mint a clone no series can suppress. Reject it (both kinds), as the backend does.
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

    // Idempotency: a repeat completion of the same occurrence returns the existing
    // live clone rather than minting a duplicate (mirrors the Rust guard).
    const existingId = head.completedOccurrences?.[occurrenceDate];
    const existing = existingId ? this.pages.get(existingId) : undefined;
    if (existing) {
      return Promise.resolve({ clone: toSummary(existing), head: toSummary(head) });
    }

    const cloneId = uuid();
    const timestamp = now();
    // `completedAt` follows the local-wall-clock convention (date-compared against
    // the local day in the Completed view), unlike created/updated_at which are UTC.
    // The clone is always a durable NATIVE page (no sync provenance, never locked) —
    // for a synced series it's the user's own completion record.
    const clone: Page = {
      ...head,
      completedAt: nowLocalISO(),
      completedOccurrences: null,
      content: head.content,
      createdAt: timestamp,
      id: cloneId,
      scheduledEnd: cloneEnd,
      scheduledStart: cloneStart,
      scheduleLocked: false,
      skippedOccurrences: null,
      sortOrder: nextSortOrder([...this.pages.values()]),
      status: "done",
      syncState: null,
      updatedAt: timestamp,
    };
    this.pages.set(cloneId, clone);

    // Record the completion on the head, then recompute it onto the next open
    // occurrence (or done) — for both kinds; the reconciler converges a synced head
    // off the same sets on the next sync.
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
      // Active mirrors are healed too, never skipped as reconciler-owned — the
      // reason is on `recompute_recurring_schedules_impl`.
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

    // Synced origin → the occurrence stays in-series as an override row, moved in
    // place when the provider already materialised it. Mirrors the two arms of
    // reschedule_virtual_occurrence_impl (pages.rs), which owns the reasoning.
    if (head.syncState) {
      // Day-keyed: a synced timed override stores originalDate as a full wall-clock.
      const existing = [...this.schedules.values()].find(
        (s) =>
          s.ruleId === data.ruleId &&
          s.originalDate &&
          dateKey(s.originalDate) === data.originalDate
      );
      // Rebuilt rather than spread over: the move clears the source zone (the user
      // asserted a device-local time) and an all-day target carries no end.
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
      sortOrder: nextSortOrder([...this.pages.values()]),
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

  // ─── Reminders ──────────────────────────────────────────────────────────────

  createPageReminder(data: NewPageReminder): Promise<PageReminder> {
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
    // Mirrors the writer's ORDER BY firedAt DESC, LIMIT — and, like it, joins the
    // page title live so a renamed page reads under its current name and a
    // deleted one reads as null.
    const rows = [...this.notificationHistory]
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      .slice(0, Math.max(0, limit))
      .map((entry) => ({
        ...entry,
        pageTitle: entry.pageId != null ? (this.pages.get(entry.pageId)?.title ?? null) : null,
      }));
    return Promise.resolve(rows);
  }

  /** Stand in for the Rust scheduler, the log's only writer, so tests and the
   *  test-mode app can exercise the history surface. Not part of StorageAdapter:
   *  nothing in the product writes this table from TypeScript. */
  seedNotificationHistory(entries: NotificationHistoryEntry[]): void {
    this.notificationHistory = [...entries];
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _refreshDenorm(pageId: string): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    // Mirror the Rust adapter (src-tauri/src/db/schedules.rs:refresh_schedule_denorm):
    // rrule-backed pages own their denorm directly and are skipped here — the
    // head's "current occurrence" is set by complete_recurring_page and by
    // scheduleOnce's explicit denorm write. Refreshing from page_schedules
    // would clobber the head back to a lingering past anchor row after a
    // completion advance. (Prod skips these; the mock must too, or it silently
    // papers over a stale-denorm bug the real app has.)
    for (const rule of this.rules.values()) {
      if (rule.pageId === pageId) return;
    }
    // prefer the earliest UPCOMING non-override schedule; fall back to the
    // earliest past schedule when no future exists; NULL only when no schedules.
    // Stripping the denorm for past-only events was a bug — it caused recent
    // optimistic updates to be overwritten by an empty denorm on next write,
    // which looked like a silent revert of the just-created chip.
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

  // ─── Calendar sync ────────────────────────────────────────────────────────────

  connectCaldavAccount(data: NewCaldavConnection): Promise<AccountWithCalendars> {
    return Promise.resolve(
      this._connectAccount("caldav", data.displayName, "basic", ["Personal", "Work"])
    );
  }

  reconnectCaldavAccount(accountId: string, password: string): Promise<AccountWithCalendars> {
    const account = this.syncAccounts.get(accountId);
    if (!account) return Promise.reject(new Error(`sync account not found: ${accountId}`));
    // The real path proves the password by discovery before storing it; the mock has
    // no server, so an empty one stands in for the rejection e2e needs.
    if (!password) return Promise.reject(new Error("Could not connect. Check the password."));
    const next = { ...account, reconnectNeeded: false };
    this.syncAccounts.set(accountId, next);
    this.dormantAccounts.delete(accountId);
    return Promise.resolve({ ...next, calendars: this._calendarsFor(accountId) });
  }

  connectGoogleAccount(): Promise<AccountWithCalendars> {
    return Promise.resolve(
      this._connectAccount("google", "you@gmail.com", "oauth", ["you@gmail.com", "Team"])
    );
  }

  googleSyncAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private _connectAccount(
    provider: string,
    displayName: string,
    authKind: string,
    calendarNames: string[]
  ): AccountWithCalendars {
    // Identity is provider + displayName, dormant or not: `find_account_by_identity_impl`
    // matches on those two alone and merely *prefers* a live row (`ORDER BY
    // disconnected ASC`). Matching only dormant rows minted a second account for the
    // same identity when the user connected one that was already active.
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
    // Canned discovery so test mode has calendars to toggle.
    for (const name of calendarNames) {
      const cal: SyncCalendar = {
        accountId: account.id,
        calendarId: `${provider}-${name.toLowerCase()}-cal`,
        color: null,
        detachedPages: 0,
        displayName: name,
        enabled: false,
        folderId: null,
        id: uuid(),
        lastSyncedAt: null,
      };
      this.syncCalendars.set(cal.id, cal);
    }
    return { ...account, calendars: this._calendarsFor(account.id) };
  }

  async disconnectSyncAccount(accountId: string): Promise<void> {
    // Dormant, not deleted (`go_dormant`). Severing the folder link here rather than
    // leaving it to disable stranded the detached pages: a reconnect then minted a
    // second folder beside them.
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

  /** `teardown_calendar`: bare mirrors are destroyed, owned pages detach in place,
   *  and the folder is deleted only when nothing survived it — otherwise it stays
   *  as a plain folder. Returns how many pages detached (the re-enable confirm's
   *  count). A tombstoned page keeps its trashed copy and loses only the link, so a
   *  resync recreates the event. */
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
        this.pages.set(page.id, { ...page, scheduleLocked: false, syncState: "detached" });
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

  /** What a backfill converges to with no provider to re-read from: the calendar
   *  reclaims the pages its own teardown detached, and a re-linked page is a locked
   *  mirror again (`find_relink` + `reclaim_calendar_folder`). Trashed pages stay
   *  severed — the real re-link skips them so a resync can't pull one back.
   *
   *  Scoped to what this teardown severed rather than to everything detached in the
   *  folder: a page severed some other way is one the provider is no longer sending,
   *  and a re-link that reclaims it describes a state sync cannot reach. */
  private _relinkCalendar(pageIds: string[]): void {
    for (const pageId of pageIds) {
      const page = this.pages.get(pageId);
      if (!page || page.syncState !== "detached" || this.softDeleted.has(pageId)) continue;
      this.pages.set(pageId, { ...page, scheduleLocked: true, syncState: "active" });
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
      // Keep the link while the de-flagged folder survives, so a re-enable re-flags
      // that one in place. Dropping it mints a second folder of the same name and
      // strands the detached pages in the first.
      if (!this.folders.has(folderId)) folderId = null;
    }
    // Re-enable re-flags a surviving folder, so it re-asserts the name and colour
    // the calendar owns rather than keeping what it had while off.
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

  // Identical to a resync, and deliberately so: there is no cursor here to drop
  // and no provider to re-read from, and `fullResync` stays false on the real
  // path too (the engine reserves it for a cursor the *provider* rejected).
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

  private _pollAccount(accountId: string): CalendarSyncResult[] {
    const synced = this._calendarsFor(accountId).filter((c) => c.enabled);
    // Stamp freshness like `persist_progress` does on every successful poll — the
    // panel's dot and "synced N ago" read it, so without this a mock-mode calendar
    // reads stale forever.
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
