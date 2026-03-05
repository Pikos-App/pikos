// StorageAdapter — framework-agnostic interface over the SQLite layer.
// Zero Tauri / React / DOM dependencies — safe to import in tests and packages.

import type { Folder, Page, PageFilter, SearchResult } from "./types";

// ─── Input helpers ────────────────────────────────────────────────────────────
// sort_order excluded — backend assigns max+1 on create

export type NewPage = Omit<Page, "id" | "createdAt" | "updatedAt" | "sortOrder">;
export type PageUpdate = Partial<Omit<Page, "id" | "createdAt" | "updatedAt">>;
export type NewFolder = Omit<Folder, "id" | "createdAt" | "updatedAt" | "sortOrder">;
export type FolderUpdate = Partial<Omit<Folder, "id" | "createdAt" | "updatedAt">>;

// ─── StorageAdapter ───────────────────────────────────────────────────────────

export interface StorageAdapter {
  // Pages
  getPage(id: string): Promise<Page | null>;
  createPage(data: NewPage): Promise<Page>;
  updatePage(id: string, updates: PageUpdate): Promise<Page>;
  deletePage(id: string): Promise<void>;
  listPages(filter?: PageFilter): Promise<Page[]>;
  /** orderedIds = complete ordered list for that folderId (null = inbox/no folder) */
  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void>;
  /** Returns excerpts (SearchResult), not full pages */
  searchPages(query: string): Promise<SearchResult[]>;

  // Folders
  getFolder(id: string): Promise<Folder | null>;
  createFolder(data: NewFolder): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
  reorderFolders(orderedIds: string[]): Promise<void>;
}
