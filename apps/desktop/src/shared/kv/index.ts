// A module accessor like shared/platform, because callers are a mix of hooks, contexts and plain
// modules that all read during render, where a provider lookup would buy nothing.
//
// The default wraps window.localStorage. Every method swallows its own failure: a Storage call
// can throw when the quota is full or in a private mode that exposes the object but refuses to
// use it, and losing a panel width is never worth taking the render down.

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
      // Index walk rather than Object.keys, which picks up anything on the Storage prototype.
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
      // Storage unavailable: nothing to remove.
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota or private mode: the preference is lost, the render is not.
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
