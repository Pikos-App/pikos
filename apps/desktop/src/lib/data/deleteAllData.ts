// Wipe all local user data: SQLite tables (pages/folders/etc.), pikos:* keys
// in localStorage (theme, calendar, editor, list preferences), and the
// workspace registry. Caller should reload the window after this resolves so
// every context re-reads from a clean slate.

import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

const LOCAL_STORAGE_PREFIX = "pikos:";

export async function deleteAllData(): Promise<void> {
  // SQLite — pages, folders, schedules, recurrence rules, focus sessions.
  await invoke("reset_db");

  // Local preferences keyed under pikos:* (see useLocalStorage callsites).
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

  // Workspace registry — without this, the app would re-open the existing
  // (now-empty) DB on next launch instead of treating it as first run.
  const store = await load("workspaces.json", { autoSave: false, defaults: {} });
  await store.clear();
  await store.save();
}
