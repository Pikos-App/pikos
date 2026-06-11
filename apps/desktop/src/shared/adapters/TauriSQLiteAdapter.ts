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
} from "@pikos/core";
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
} from "@pikos/core";
import { toStorageError } from "@pikos/core";
import { invoke as rawInvoke } from "@tauri-apps/api/core";

import { markLocalWrite } from "@/shared/lib/externalChange";
import { createLogger } from "@/shared/logger";

const log = createLogger("IPC-watchdog");

// ─── Dev-mode IPC watchdog ────────────────────────────────────────────────────
// Catches render-loop bugs that flood the Tauri IPC channel before they crash
// the webview. If any command fires more than WATCHDOG_THRESHOLD times within
// WATCHDOG_WINDOW_MS, we log an error + stack trace pointing at the caller —
// and throttle subsequent warnings for the same command so the console stays
// readable. DEV-only; `invoke` passes straight through in production.

const WATCHDOG_WINDOW_MS = 100;
const WATCHDOG_THRESHOLD = 20;
const WATCHDOG_COOLDOWN_MS = 2000;
const callLog = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function watchdog(command: string): void {
  const now = performance.now();
  const timestamps = callLog.get(command) ?? [];
  const cutoff = now - WATCHDOG_WINDOW_MS;
  let firstInWindow = 0;
  while (firstInWindow < timestamps.length && timestamps[firstInWindow]! < cutoff) {
    firstInWindow++;
  }
  const recent = firstInWindow === 0 ? timestamps : timestamps.slice(firstInWindow);
  recent.push(now);
  callLog.set(command, recent);

  if (recent.length <= WATCHDOG_THRESHOLD) return;
  const cooldown = cooldownUntil.get(command) ?? 0;
  if (now < cooldown) return;
  cooldownUntil.set(command, now + WATCHDOG_COOLDOWN_MS);

  // Pass an Error so DevTools renders a clickable stack trace pointing at
  // the effect/component responsible for the runaway calls.
  log.error(
    `"${command}" fired ${recent.length}× in ${WATCHDOG_WINDOW_MS}ms — likely render-loop bug. ` +
      `Further warnings for this command suppressed for ${WATCHDOG_COOLDOWN_MS}ms.`,
    new Error("IPC flood stack trace")
  );
}

// Commands that mutate the workspace DB. Issuing one opens a suppression
// window so the DB watcher's change event for our own write doesn't trigger a
// redundant reload (see shared/lib/externalChange.ts).
const WRITE_COMMANDS = new Set([
  "create_page",
  "update_page",
  "delete_page",
  "soft_delete_page",
  "restore_page",
  "reorder_pages",
  "complete_recurring_page",
  "create_folder",
  "update_folder",
  "delete_folder",
  "soft_delete_folder",
  "restore_folder",
  "reorder_folders",
  "create_page_schedule",
  "update_page_schedule",
  "delete_page_schedule",
  "create_recurrence_rule",
  "update_recurrence_rule",
  "delete_recurrence_rule",
  "create_page_reminder",
  "delete_page_reminder",
  "delete_page_reminders",
  "backdate_page",
  "reset_db",
  "wipe_app_data",
]);

// Rust commands serialize errors as { kind, message } (see
// apps/desktop/src-tauri/src/error.rs::AppError). Convert at the boundary
// into a typed StorageError so UI code can branch on `kind` and never
// stringifies a raw IPC payload (which would render "[object Object]").
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV) watchdog(command);
  if (WRITE_COMMANDS.has(command)) markLocalWrite();
  return rawInvoke<T>(command, args).catch((err: unknown) => {
    throw toStorageError(err);
  });
}

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

  softDeletePage(id: string): Promise<void> {
    return invoke<void>("soft_delete_page", { id });
  }

  restorePage(id: string): Promise<void> {
    return invoke<void>("restore_page", { id });
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

  setPagesStatus(
    ids: string[],
    status: PageStatus,
    completedAt: string | null
  ): Promise<PageSummary[]> {
    return invoke<PageSummary[]>("set_pages_status", { completedAt, ids, status });
  }

  listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse> {
    return invoke<CompletedPagesResponse>("list_completed_pages", { filter });
  }

  searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse> {
    return invoke<SearchResponse>("search_pages", { includeCompleted, query });
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

  softDeleteFolder(id: string): Promise<void> {
    return invoke<void>("soft_delete_folder", { id });
  }

  restoreFolder(id: string): Promise<void> {
    return invoke<void>("restore_folder", { id });
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

  addRuleExdates(id: string, dates: string[]): Promise<PageRecurrenceRule> {
    return invoke<PageRecurrenceRule>("add_rule_exdates", { dates, id });
  }

  removeRuleExdate(id: string, date: string): Promise<PageRecurrenceRule> {
    return invoke<PageRecurrenceRule>("remove_rule_exdate", { date, id });
  }

  deleteRecurrenceRule(id: string): Promise<void> {
    return invoke<void>("delete_recurrence_rule", { id });
  }

  getRecurrenceRule(pageId: string): Promise<PageRecurrenceRule | null> {
    return invoke<PageRecurrenceRule | null>("get_recurrence_rule", { pageId });
  }

  listRecurrenceRules(): Promise<PageRecurrenceRule[]> {
    return invoke<PageRecurrenceRule[]>("list_recurrence_rules");
  }

  completeRecurringPage(data: CompleteRecurringInput): Promise<CompleteRecurringResult> {
    return invoke<CompleteRecurringResult>("complete_recurring_page", { data });
  }

  rescheduleVirtualOccurrence(data: RescheduleVirtualInput): Promise<RescheduleVirtualResult> {
    return invoke<RescheduleVirtualResult>("reschedule_virtual_occurrence", { data });
  }

  // ─── Reminders ──────────────────────────────────────────────────────────────

  createPageReminder(data: NewPageReminder): Promise<PageReminder> {
    return invoke<PageReminder>("create_page_reminder", { data });
  }

  listPageReminders(pageId: string): Promise<PageReminder[]> {
    return invoke<PageReminder[]>("list_page_reminders", { pageId });
  }

  deletePageReminder(id: string): Promise<void> {
    return invoke<void>("delete_page_reminder", { id });
  }

  deletePageReminders(pageId: string): Promise<void> {
    return invoke<void>("delete_page_reminders", { pageId });
  }
}
