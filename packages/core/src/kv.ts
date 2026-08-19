// The small synchronous key-value store the UI keeps its preferences in.
//
// Deliberately synchronous, and deliberately string-in/string-out. Synchronous
// because every caller reads during render — a panel width, the theme, the last
// active view — and an async read would put a flash of the default value in
// front of the user on every launch. A phone can back this with an MMKV-style
// store, which is synchronous for the same reason; what it cannot back is a
// promise-shaped interface without reintroducing that flash.
//
// Strings because the values on disk today are JSON strings written by
// `useLocalStorage`, and the seam has to preserve them byte for byte.

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Every key currently held, in no particular order. Used by the
   *  delete-all-data sweep, which removes by prefix. */
  keys(): string[];
}

/** In-memory KeyValueStore — for tests and for hosts with no persistence. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}
