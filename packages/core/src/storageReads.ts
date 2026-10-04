import type { StorageAdapter } from "./storage";

/**
 * The adapter methods that change no rows. Anything not listed is taken to be a write, so a
 * method missing here costs an extra refresh, never a missed one; a write listed here would leave
 * views stale after it.
 */
export const STORAGE_READS: ReadonlySet<keyof StorageAdapter> = new Set<keyof StorageAdapter>([
  "backupDatabase",
  "backupBeforeImport",
  "changeState",
  "countViews",
  "expandRecurrenceRange",
  "exportWorkspace",
  "getFolder",
  "getPage",
  "getPageIfNewer",
  "getPages",
  "getRecurrenceRule",
  "getSyncStatus",
  "getUsageStats",
  "googleSyncAvailable",
  "listBackups",
  "listCompletedPages",
  "listCompletedWindow",
  "listFolders",
  "listNotificationHistory",
  "listPageReminders",
  "listPages",
  "listPageSchedules",
  "listPageSchedulesForRules",
  "listPagesToday",
  "listRange",
  "listRecentPages",
  "listRecurrenceRules",
  "listSeriesHeads",
  "listSyncCalendars",
  "listTags",
  "listTrashedPages",
  "listView",
  "listViewIds",
  "searchPages",
  "searchTags",
]);

export interface WriteWatcher {
  started: (method: string, args: unknown[]) => void;
  /** Called once per write, succeeded or failed. */
  settled: (method: string, args: unknown[]) => void;
}

/** The adapter, reporting each write as it starts and settles. The original promise is returned
 *  untouched, so a caller's rejection handling is unchanged. */
export function watchWrites<A extends StorageAdapter>(adapter: A, watcher: WriteWatcher): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || STORAGE_READS.has(prop as keyof StorageAdapter)) {
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
      return (...args: unknown[]) => {
        const method = String(prop);
        const settle = () => watcher.settled(method, args);
        watcher.started(method, args);
        let result: unknown;
        try {
          result = value.apply(target, args);
        } catch (error) {
          settle();
          throw error;
        }
        if (result instanceof Promise) result.then(settle, settle);
        else settle();
        return result;
      };
    },
  });
}
