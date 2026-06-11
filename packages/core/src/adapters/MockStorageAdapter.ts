// In-memory StorageAdapter for tests — injected via VITE_TEST_MODE.

import type {
  FolderUpdate,
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
  RescheduleVirtualInput,
  RescheduleVirtualResult,
  SearchResponse,
  SearchResult,
} from "../types";
import { nowLocalISO } from "../utils/dates";
import { extractText } from "../utils/extractText";
import { isDone, isOpen } from "../utils/page";

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

function nextSortOrder(items: { sortOrder: number }[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((i) => i.sortOrder)) + 1;
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
    const haystack = `${page.title} ${page.subtitle ?? ""} ${page.content}`.toLowerCase();
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
  private softDeleted = new Set<string>();
  private softDeletedFolders = new Set<string>();

  clear(): void {
    this.pages.clear();
    this.folders.clear();
    this.schedules.clear();
    this.rules.clear();
    this.reminders.clear();
    this.softDeleted.clear();
    this.softDeletedFolders.clear();
  }

  // ─── Pages ──────────────────────────────────────────────────────────────────

  getPage(id: string): Promise<Page | null> {
    return Promise.resolve(this.pages.get(id) ?? null);
  }

  createPage(data: NewPage): Promise<Page> {
    const page: Page = {
      ...data,
      // Mirror the Rust adapter, which extracts plain text from Tiptap JSON on
      // every save so FTS indexes the visible body, not the structural tokens.
      contentText: data.contentText ?? deriveContentText(data.content),
      createdAt: now(),
      id: uuid(),
      sortOrder: nextSortOrder([...this.pages.values()]),
      updatedAt: now(),
    };
    this.pages.set(page.id, page);
    return Promise.resolve(page);
  }

  updatePage(id: string, updates: PageUpdate): Promise<Page> {
    const existing = this.pages.get(id);
    if (!existing) return Promise.reject(new Error(`Page not found: ${id}`));
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
    return Promise.resolve();
  }

  softDeletePage(id: string): Promise<void> {
    this.softDeleted.add(id);
    return Promise.resolve();
  }

  restorePage(id: string): Promise<void> {
    this.softDeleted.delete(id);
    return Promise.resolve();
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
    const q = query.toLowerCase().trim();
    if (!q) return Promise.resolve({ completedCount: 0, results: [] });
    const titleResults: SearchResult[] = [];
    const contentResults: SearchResult[] = [];
    let completedCount = 0;
    for (const page of this.pages.values()) {
      if (this.softDeleted.has(page.id)) continue;
      const titleMatch = page.title.toLowerCase().includes(q);
      // Match against subtitle + extracted plain text — never the raw Tiptap
      // JSON. Rust's FTS index sees the same surface, so the mock returning
      // pages because the user typed "paragraph" or "type" would be a lie.
      const text = `${page.subtitle ?? ""} ${page.contentText ?? ""}`.toLowerCase();
      const contentMatch = text.includes(q);
      if (!titleMatch && !contentMatch) continue;
      if (isDone(page)) {
        completedCount++;
        if (!includeCompleted) continue;
      }
      const bodyText = (page.contentText ?? "").slice(0, 80);
      const meta = {
        contentPreview: bodyText,
        priority: page.priority,
        scheduledDate: page.scheduledStart ?? null,
        status: page.status,
        subtitle: page.subtitle ?? null,
        tags: page.tags,
      } as const;
      if (titleMatch && contentMatch) {
        const idx = text.indexOf(q);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + q.length + 40);
        const excerpt = text.slice(start, end);
        titleResults.push({
          excerpt,
          id: page.id,
          matchSource: "both",
          title: page.title,
          ...meta,
        });
      } else if (titleMatch) {
        titleResults.push({
          excerpt: "",
          id: page.id,
          matchSource: "title",
          title: page.title,
          ...meta,
        });
      } else if (contentMatch) {
        const idx = text.indexOf(q);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + q.length + 40);
        const excerpt = text.slice(start, end);
        contentResults.push({
          excerpt,
          id: page.id,
          matchSource: "content",
          title: page.title,
          ...meta,
        });
      }
    }
    // Title matches first (mimics bm25 weighting)
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
      sortOrder: nextSortOrder([...this.folders.values()]),
      updatedAt: now(),
    };
    this.folders.set(folder.id, folder);
    return Promise.resolve(folder);
  }

  updateFolder(id: string, updates: FolderUpdate): Promise<Folder> {
    const existing = this.folders.get(id);
    if (!existing) return Promise.reject(new Error(`Folder not found: ${id}`));
    const updated: Folder = { ...existing, ...updates, id, updatedAt: now() };
    this.folders.set(id, updated);
    return Promise.resolve(updated);
  }

  deleteFolder(id: string): Promise<void> {
    // Soft-delete all pages in this folder (mirrors Rust backend behavior)
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.softDeleted.add(page.id);
    }
    this.folders.delete(id);
    return Promise.resolve();
  }

  softDeleteFolder(id: string): Promise<void> {
    this.softDeletedFolders.add(id);
    for (const page of this.pages.values()) {
      if (page.folderId === id) this.softDeleted.add(page.id);
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

  listPageSchedulesRange(start: string, end: string): Promise<PageSchedule[]> {
    const results = [...this.schedules.values()].filter((s) => {
      // Match Rust's range query: schedules belonging to a soft-deleted page
      // are excluded (the SQL joins pages and filters `deleted_at IS NULL`).
      if (this.softDeleted.has(s.pageId)) return false;
      const sDate = s.scheduledStart.slice(0, 10);
      const eDate = s.scheduledEnd ? s.scheduledEnd.slice(0, 10) : null;
      if (eDate === null) return sDate >= start && sDate <= end;
      return sDate <= end && eDate >= start;
    });
    return Promise.resolve(
      results.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
    );
  }

  // ─── Recurrence rules ────────────────────────────────────────────────────────

  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
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
    return Promise.resolve(rule);
  }

  updateRecurrenceRule(id: string, updates: RecurrenceRuleUpdate): Promise<PageRecurrenceRule> {
    const existing = this.rules.get(id);
    if (!existing) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    const updated = { ...existing };
    if (updates.rrule !== undefined) updated.rrule = updates.rrule;
    if (updates.rruleExdates !== undefined) updated.rruleExdates = updates.rruleExdates;
    if (updates.scheduledStart !== undefined) updated.scheduledStart = updates.scheduledStart;
    if (updates.timezone !== undefined) updated.timezone = updates.timezone;
    if (updates.scheduledEnd === null) delete updated.scheduledEnd;
    else if (updates.scheduledEnd !== undefined) updated.scheduledEnd = updates.scheduledEnd;
    this.rules.set(id, updated);
    return Promise.resolve(updated);
  }

  addRuleExdates(id: string, dates: string[]): Promise<PageRecurrenceRule> {
    const rule = this.rules.get(id);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    // Merge into the CURRENT row (mirrors the Rust read-merge-write tx) — never
    // a replacement, so exdates written since the caller's snapshot survive.
    const merged = [...rule.rruleExdates];
    for (const d of dates) {
      if (!merged.includes(d)) merged.push(d);
    }
    const updated = { ...rule, rruleExdates: merged };
    this.rules.set(id, updated);
    return Promise.resolve(updated);
  }

  removeRuleExdate(id: string, date: string): Promise<PageRecurrenceRule> {
    const rule = this.rules.get(id);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${id}`));
    const updated = { ...rule, rruleExdates: rule.rruleExdates.filter((d) => d !== date) };
    this.rules.set(id, updated);
    return Promise.resolve(updated);
  }

  deleteRecurrenceRule(id: string): Promise<void> {
    this.rules.delete(id);
    return Promise.resolve();
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

  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult> {
    const head = this.pages.get(data.pageId);
    if (!head) throw new Error(`Page not found: ${data.pageId}`);

    const cloneId = uuid();
    const timestamp = now();
    // `completedAt` follows the local-wall-clock convention (date-compared
    // against the local day in the Completed view), unlike created/updated_at
    // which are UTC. Mirrors the Rust adapter's now_local_iso(). Using the UTC
    // `now()` here would hide the clone from Today's Completed section whenever
    // UTC's date differs from the local date.
    const completedAt = nowLocalISO();
    const clone: Page = {
      ...head,
      completedAt,
      content: head.content,
      createdAt: timestamp,
      id: cloneId,
      sortOrder: nextSortOrder([...this.pages.values()]),
      status: "done",
      updatedAt: timestamp,
    };
    this.pages.set(cloneId, clone);

    if (data.nextScheduledStart) {
      head.scheduledStart = data.nextScheduledStart;
      head.scheduledEnd = data.nextScheduledEnd;
      head.updatedAt = timestamp;
    } else {
      head.status = "done";
      head.completedAt = completedAt;
      head.updatedAt = timestamp;
    }

    // Exdate update folded into the same call and MERGED into the current row
    // (mirrors the Rust adapter's in-transaction read-merge-write), so exdates
    // persisted after the caller's snapshot survive the completion.
    let ruleExdates: string[] | null = null;
    if (data.ruleId && data.addExdates) {
      const rule = this.rules.get(data.ruleId);
      if (rule) {
        const merged = [...rule.rruleExdates];
        for (const d of data.addExdates) {
          if (!merged.includes(d)) merged.push(d);
        }
        this.rules.set(data.ruleId, { ...rule, rruleExdates: merged });
        ruleExdates = merged;
      }
    }

    return Promise.resolve({ clone: toSummary(clone), head: toSummary(head), ruleExdates });
  }

  rescheduleVirtualOccurrence(data: RescheduleVirtualInput): Promise<RescheduleVirtualResult> {
    const rule = this.rules.get(data.ruleId);
    if (!rule) return Promise.reject(new Error(`Recurrence rule not found: ${data.ruleId}`));
    const head = this.pages.get(rule.pageId);
    if (!head || this.softDeleted.has(rule.pageId)) {
      return Promise.reject(new Error(`Page not found: ${rule.pageId}`));
    }

    const timestamp = now();
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
}
