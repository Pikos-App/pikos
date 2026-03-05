// TauriSQLiteAdapter — calls Rust Tauri commands for all storage operations.
// Lives in apps/desktop (has Tauri deps). Do NOT import from packages/core.

import { invoke } from "@tauri-apps/api/core";
import type { Folder, Page, PageFilter, SearchResult } from "@pikos/core";
import type { FolderUpdate, NewFolder, NewPage, PageUpdate, StorageAdapter } from "@pikos/core";

export class TauriSQLiteAdapter implements StorageAdapter {
  // ─── Pages ──────────────────────────────────────────────────────────────────

  getPage(id: string): Promise<Page | null> {
    return invoke<Page | null>("get_page", { id });
  }

  createPage(data: NewPage): Promise<Page> {
    return invoke<Page>("create_page", { data });
  }

  updatePage(id: string, updates: PageUpdate): Promise<Page> {
    return invoke<Page>("update_page", { id, updates });
  }

  deletePage(id: string): Promise<void> {
    return invoke<void>("delete_page", { id });
  }

  listPages(filter?: PageFilter): Promise<Page[]> {
    return invoke<Page[]>("list_pages", { filter: filter ?? null });
  }

  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void> {
    return invoke<void>("reorder_pages", { folderId, orderedIds });
  }

  searchPages(query: string): Promise<SearchResult[]> {
    return invoke<SearchResult[]>("search_pages", { query });
  }

  // ─── Folders ────────────────────────────────────────────────────────────────

  getFolder(id: string): Promise<Folder | null> {
    return invoke<Folder | null>("get_folder", { id });
  }

  createFolder(data: NewFolder): Promise<Folder> {
    return invoke<Folder>("create_folder", { data });
  }

  updateFolder(id: string, updates: FolderUpdate): Promise<Folder> {
    return invoke<Folder>("update_folder", { id, updates });
  }

  deleteFolder(id: string): Promise<void> {
    return invoke<void>("delete_folder", { id });
  }

  listFolders(): Promise<Folder[]> {
    return invoke<Folder[]>("list_folders");
  }

  reorderFolders(orderedIds: string[]): Promise<void> {
    return invoke<void>("reorder_folders", { orderedIds });
  }
}
