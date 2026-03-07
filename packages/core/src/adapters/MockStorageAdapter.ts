// MockStorageAdapter — in-memory implementation for Vitest + Playwright tests.
// Injected via VITE_TEST_MODE. Zero Tauri deps.

import type {
  Folder,
  Page,
  PageFilter,
  PageRecurrenceRule,
  PageSchedule,
  SearchResult,
} from "../types";
import type {
  FolderUpdate,
  NewFolder,
  NewPage,
  NewPageSchedule,
  NewRecurrenceRule,
  PageScheduleUpdate,
  PageUpdate,
  RecurrenceRuleUpdate,
  StorageAdapter,
} from "../storage";

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function nextSortOrder(items: { sortOrder: number }[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((i) => i.sortOrder)) + 1;
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
  if (filter.scheduledAfter !== undefined && page.scheduledStart !== undefined) {
    if (page.scheduledStart < filter.scheduledAfter) return false;
  }
  if (filter.scheduledBefore !== undefined && page.scheduledStart !== undefined) {
    if (page.scheduledStart > filter.scheduledBefore) return false;
  }
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

  // ─── Pages ──────────────────────────────────────────────────────────────────

  getPage(id: string): Promise<Page | null> {
    return Promise.resolve(this.pages.get(id) ?? null);
  }

  createPage(data: NewPage): Promise<Page> {
    const page: Page = {
      ...data,
      id: uuid(),
      sortOrder: nextSortOrder([...this.pages.values()]),
      createdAt: now(),
      updatedAt: now(),
    };
    this.pages.set(page.id, page);
    return Promise.resolve(page);
  }

  updatePage(id: string, updates: PageUpdate): Promise<Page> {
    const existing = this.pages.get(id);
    if (!existing) return Promise.reject(new Error(`Page not found: ${id}`));
    const updated: Page = { ...existing, ...updates, id, updatedAt: now() };
    this.pages.set(id, updated);
    return Promise.resolve(updated);
  }

  deletePage(id: string): Promise<void> {
    this.pages.delete(id);
    return Promise.resolve();
  }

  listPages(filter?: PageFilter): Promise<Page[]> {
    const all = [...this.pages.values()];
    const filtered = filter ? all.filter((p) => matchesFilter(p, filter)) : all;
    return Promise.resolve(filtered.sort((a, b) => a.sortOrder - b.sortOrder));
  }

  listPagesToday(): Promise<Page[]> {
    const today = new Date().toISOString().slice(0, 10);
    const pageIds = new Set(
      [...this.schedules.values()]
        .filter((s) => s.scheduledStart.slice(0, 10) <= today)
        .map((s) => s.pageId)
    );
    const results = [...this.pages.values()]
      .filter((p) => pageIds.has(p.id) && p.status !== "done")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return Promise.resolve(results);
  }

  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, i) => {
      const page = this.pages.get(id);
      if (page) this.pages.set(id, { ...page, sortOrder: i, updatedAt: now() });
    });
    return Promise.resolve();
  }

  searchPages(query: string): Promise<SearchResult[]> {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const page of this.pages.values()) {
      const text = `${page.title} ${page.subtitle ?? ""} ${page.content}`.toLowerCase();
      if (text.includes(q)) {
        const idx = text.indexOf(q);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + q.length + 40);
        const excerpt = text.slice(start, end).replace(q, `<mark>${q}</mark>`);
        results.push({ id: page.id, title: page.title, excerpt });
      }
    }
    return Promise.resolve(results);
  }

  // ─── Folders ────────────────────────────────────────────────────────────────

  getFolder(id: string): Promise<Folder | null> {
    return Promise.resolve(this.folders.get(id) ?? null);
  }

  createFolder(data: NewFolder): Promise<Folder> {
    const folder: Folder = {
      ...data,
      id: uuid(),
      sortOrder: nextSortOrder([...this.folders.values()]),
      createdAt: now(),
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
    this.folders.delete(id);
    return Promise.resolve();
  }

  listFolders(): Promise<Folder[]> {
    return Promise.resolve([...this.folders.values()].sort((a, b) => a.sortOrder - b.sortOrder));
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
      status: "not_started",
      createdAt: now(),
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
    const rule: PageRecurrenceRule = {
      id: uuid(),
      pageId: data.pageId,
      rrule: data.rrule,
      rruleExdates: data.rruleExdates ?? [],
      scheduledStart: data.scheduledStart,
      ...(data.scheduledEnd !== undefined && { scheduledEnd: data.scheduledEnd }),
      timezone: data.timezone,
      createdAt: now(),
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

  deleteRecurrenceRule(id: string): Promise<void> {
    this.rules.delete(id);
    return Promise.resolve();
  }

  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null> {
    const rule = [...this.rules.values()].find((r) => r.pageId === pageId) ?? null;
    return Promise.resolve(rule);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _refreshDenorm(pageId: string): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const today = new Date().toISOString().slice(0, 10);
    const next = [...this.schedules.values()]
      .filter((s) => s.pageId === pageId && !s.ruleId && s.scheduledStart >= today)
      .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0];
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
