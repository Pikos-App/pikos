// Wipe all local user data and relaunch the app so it boots as a fresh install.
//
// Deleted:
// - SQLite files in the workspace (default.sqlite + WAL/SHM, backups/, assets/,
//   workspaces.json — everything under app_data_dir).
// - Rotating log file under app_log_dir.
// - All `pikos:` keys in the preference store (calendar/editor/list preferences,
//   skipped update version, defaults). The theme key predates that namespace
//   (see shared/constants/storage.ts) and deliberately survives the wipe.
// - Calendar-sync credentials in the OS keychain, and the OAuth grants they
//   belong to. These sit outside app_data_dir, so they need their own pass.
//
// Relaunch is a hard process restart: in-memory caches in tauri-plugin-store,
// the notification scheduler, and every React context all start over from
// nothing.

import type { StorageAdapter } from "@pikos/core";
import { load } from "@tauri-apps/plugin-store";

import { STORAGE_KEY_PREFIX } from "@/shared/constants/storage";
import { getKeyValueStore } from "@/shared/kv";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";

const log = createLogger("deleteAllData");

export async function deleteAllData(storage: StorageAdapter): Promise<void> {
  // Must precede the wipe: the account ids this keys on live in the DB it deletes.
  // Best-effort — an offline revoke can't strand the user with data they asked to
  // delete.
  try {
    await storage.releaseSyncCredentials();
  } catch (e) {
    log.error("could not release calendar-sync credentials — wiping anyway", e);
  }

  // Drops the DB pool, then removes app_data_dir and app_log_dir.
  await storage.wipeAllData();

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

  // The preference store isn't part of the workspace the wipe destroys —
  // clear our keys here. Theme survives: it predates the prefix (see
  // shared/constants/storage.ts), so the sweep never names it.
  const kv = getKeyValueStore();
  for (const key of kv.keys()) {
    if (key.startsWith(STORAGE_KEY_PREFIX)) kv.removeItem(key);
  }

  await getPlatform().relaunch();
}
