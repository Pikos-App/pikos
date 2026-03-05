// MockStorageAdapter — in-memory implementation for Vitest + Playwright tests.
// Injected via VITE_TEST_MODE. Zero Tauri deps.

import type { Folder, Page, PageFilter, SearchResult } from "../types";
import type { FolderUpdate, NewFolder, NewPage, PageUpdate, StorageAdapter } from "../storage";

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
}
