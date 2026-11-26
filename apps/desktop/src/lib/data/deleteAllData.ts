// Wipe all local user data and relaunch so the app boots as a fresh install. Relaunch is a hard
// process restart, so in-memory caches, the notification scheduler and every React context start
// over. Calendar-sync credentials and the OAuth grants they belong to sit outside app_data_dir,
// so they get their own pass.

import type { StorageAdapter } from "@pikos/core";
import { load } from "@tauri-apps/plugin-store";

import { STORAGE_KEY_PREFIX } from "@/shared/constants/storage";
import { getKeyValueStore } from "@/shared/kv";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";

const log = createLogger("deleteAllData");

export async function deleteAllData(storage: StorageAdapter): Promise<void> {
  // Must precede the wipe: the account ids this keys on live in the DB it deletes. Best-effort, so
  // an offline revoke can't strand the user with data they asked to delete.
  try {
    await storage.releaseSyncCredentials();
  } catch (e) {
    log.error("could not release calendar-sync credentials — wiping anyway", e);
  }

  await storage.wipeAllData();

  // Empty the in-memory workspaces store. tauri-plugin-store re-saves every loaded store on
  // RunEvent::Exit, which fires during relaunch() below, so without this the old workspace entry
  // is written back and the relaunched app skips the first-run tutorial seed. load() dedups by
  // path, so this is the store the exit handler saves.
  //
  // This must not silently no-op: a swallowed failure resurrects the old workspace and breaks the
  // reseed (clear() throws without `store:allow-clear` in capabilities). Log loudly, and fall
  // back to emptying the key directly (store:allow-set) if clear() is unavailable.
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

  // Clear our `pikos:` keys: the preference store isn't part of the workspace the wipe destroys.
  // Theme survives; it predates the prefix (see shared/constants/storage.ts), so the sweep never
  // names it.
  const kv = getKeyValueStore();
  for (const key of kv.keys()) {
    if (key.startsWith(STORAGE_KEY_PREFIX)) kv.removeItem(key);
  }

  await getPlatform().relaunch();
}
