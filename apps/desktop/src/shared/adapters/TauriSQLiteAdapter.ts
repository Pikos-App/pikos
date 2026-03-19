// TauriSQLiteAdapter — calls Rust Tauri commands for all storage operations.
// Lives in apps/desktop (Tauri deps). Types imported from @pikos/core (no Tauri).

import type {
  Folder,
  Page,
  PageFilter,
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  SearchResult,
} from "@pikos/core";
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
} from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";

/**
 * Open (or create) the SQLite workspace at `path` and run migrations.
 * Must be called by WorkspaceContext before any storage operations.
 */
export function connectDb(path: string): Promise<void> {
  return invoke<void>("connect_db", { path });
}

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

  listPages(filter?: PageFilter): Promise<PageSummary[]> {
    return invoke<PageSummary[]>("list_pages", { filter: filter ?? null });
  }

  listPagesToday(): Promise<PageSummary[]> {
    return invoke<PageSummary[]>("list_pages_today");
  }

  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void> {
    return invoke<void>("reorder_pages", { folderId, orderedIds });
  }

  searchPages(query: string): Promise<SearchResult[]> {
    return invoke<SearchResult[]>("search_pages", { query });
  }

  searchTags(query: string): Promise<string[]> {
    return invoke<string[]>("search_tags", { query });
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

  // ─── Schedules ──────────────────────────────────────────────────────────────

  createPageSchedule(data: NewPageSchedule): Promise<PageSchedule> {
    return invoke<PageSchedule>("create_page_schedule", { data });
  }

  updatePageSchedule(id: string, updates: PageScheduleUpdate): Promise<PageSchedule> {
    return invoke<PageSchedule>("update_page_schedule", { id, updates });
  }

  deletePageSchedule(id: string): Promise<void> {
    return invoke<void>("delete_page_schedule", { id });
  }

  listPageSchedules(pageId: string): Promise<PageSchedule[]> {
    return invoke<PageSchedule[]>("list_page_schedules", { pageId });
  }

  listPageSchedulesRange(start: string, end: string): Promise<PageSchedule[]> {
    return invoke<PageSchedule[]>("list_page_schedules_range", { end, start });
  }

  // ─── Recurrence rules ────────────────────────────────────────────────────────

  createRecurrenceRule(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    return invoke<PageRecurrenceRule>("create_recurrence_rule", { data });
  }

  updateRecurrenceRule(id: string, updates: RecurrenceRuleUpdate): Promise<PageRecurrenceRule> {
    return invoke<PageRecurrenceRule>("update_recurrence_rule", { id, updates });
  }

  deleteRecurrenceRule(id: string): Promise<void> {
    return invoke<void>("delete_recurrence_rule", { id });
  }

  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null> {
    return invoke<PageRecurrenceRule | null>("get_recurrence_rule", { pageId });
  }
}
