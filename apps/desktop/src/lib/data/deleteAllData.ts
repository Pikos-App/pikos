// Wipe all local user data and relaunch the app so it boots as a fresh install.
//
// Deleted:
// - SQLite files in the workspace (default.sqlite + WAL/SHM, backups/, assets/,
//   workspaces.json — everything under app_data_dir).
// - Rotating log file under app_log_dir.
// - All `pikos:*` keys in localStorage (theme, calendar/editor/list
//   preferences, skipped update version, defaults).
//
// Relaunch is a hard process restart: in-memory caches in tauri-plugin-store,
// the notification scheduler, and every React context all start over from
// nothing.

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";

const LOCAL_STORAGE_PREFIX = "pikos:";

export async function deleteAllData(): Promise<void> {
  // Rust side: drops the DB pool, then removes app_data_dir and app_log_dir.
  await invoke("wipe_app_data");

  // localStorage isn't owned by Tauri — clear our keys here.
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // localStorage unavailable — nothing to clear.
  }

  await relaunch();
}
