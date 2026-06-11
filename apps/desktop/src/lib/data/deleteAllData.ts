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
import { load } from "@tauri-apps/plugin-store";

import { createLogger } from "@/shared/logger";

const LOCAL_STORAGE_PREFIX = "pikos:";

const log = createLogger("deleteAllData");

export async function deleteAllData(): Promise<void> {
  // Rust side: drops the DB pool, then removes app_data_dir and app_log_dir.
  await invoke("wipe_app_data");

  // Empty the in-memory workspaces store. wipe_app_data removed the file on
  // disk, but tauri-plugin-store re-saves every loaded store on RunEvent::Exit
  // — which fires during relaunch() below. Without this, the old workspace
  // entry (still held in the live resource) gets written back, so the
  // relaunched app finds a non-empty workspace list, takes the
  // existing-workspace path, and skips the first-run tutorial seed. load()
  // dedups by path, so this is the exact store the exit handler will save.
  //
  // This MUST NOT silently no-op. A swallowed failure here resurrects the old
  // workspace and breaks the reseed — exactly the regression that shipped when
  // `store:allow-clear` was missing from capabilities (clear() threw and the
  // catch hid it). Log loudly, and fall back to emptying the key directly
  // (store:allow-set) if clear() is ever unavailable again.
  try {
    const store = await load("workspaces.json", { autoSave: false, defaults: {} });
    try {
      await store.clear();
    } catch (clearErr) {
      log.error("store.clear failed — falling back to emptying workspaces key", clearErr);
      await store.set("workspaces", []);
    }
    await store.save();
  } catch (e) {
    log.error("could not empty workspaces store — relaunch may not reseed", e);
  }

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
