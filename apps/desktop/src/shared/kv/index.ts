// How the app reaches its preference store.
//
// Same shape as shared/platform: a module accessor, because the callers are a
// mix of hooks, contexts and plain modules, and because every one of them reads
// during render where a provider lookup would buy nothing.
//
// The default wraps window.localStorage. Every method swallows its own failure
// — a Storage call can throw outright when the quota is full or when the
// browser is in a private mode that exposes the object but refuses to use it,
// and losing a panel width is never worth taking the render down.

import type { KeyValueStore } from "@pikos/core";

const webStorage: KeyValueStore = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  keys() {
    try {
      // Index walk rather than Object.keys: the latter picks up anything on the
      // Storage prototype, which is not what the caller means by "the keys".
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) out.push(key);
      }
      return out;
    } catch {
      return [];
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage unavailable — nothing to remove.
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable (quota, private mode) — the preference is lost, the
      // render is not.
    }
  },
};

let override: KeyValueStore | null = null;

export function getKeyValueStore(): KeyValueStore {
  return override ?? webStorage;
}

/** Test seam. Pass null to restore the window.localStorage-backed default. */
export function setKeyValueStore(next: KeyValueStore | null): void {
  override = next;
}
