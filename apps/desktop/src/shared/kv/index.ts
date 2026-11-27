// A module accessor like shared/platform, because callers are a mix of hooks, contexts and plain
// modules that all read during render, where a provider lookup would buy nothing.
//
// The default wraps window.localStorage. Every method contains its own failure: a Storage call
// can throw when the quota is full or in a private mode that exposes the object but refuses to
// use it, and losing a panel width is never worth taking the render down. A write that's lost
// is logged, because the setting then comes back changed on the next launch.

import type { KeyValueStore } from "@pikos/core";

import { createLogger, throttled } from "@/shared/logger";

const log = throttled(createLogger("kv"));

const webStorage: KeyValueStore = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
      // eslint-disable-next-line pikos/no-silent-catch -- reads run on every render, and an unreadable store reads as empty
    } catch {
      return null;
    }
  },
  keys() {
    try {
      // Index walk rather than Object.keys, which picks up anything on the Storage prototype.
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) out.push(key);
      }
      return out;
      // eslint-disable-next-line pikos/no-silent-catch -- reads run on every render, and an unreadable store reads as empty
    } catch {
      return [];
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      log.warn(`removing a stored setting failed (${key})`, e);
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // Quota or private mode: the preference is lost, the render is not.
      log.warn(`saving a stored setting failed (${key})`, e);
    }
  },
};

let override: KeyValueStore | null = null;

export function getKeyValueStore(): KeyValueStore {
  return override ?? webStorage;
}

export function setKeyValueStore(next: KeyValueStore | null): void {
  override = next;
}
