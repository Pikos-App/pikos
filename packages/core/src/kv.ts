// Synchronous because every caller reads during render (a panel width, the theme, the last
// active view), and an async read would flash the default value on every launch. String-in,
// string-out because the stored values are JSON strings written by `useLocalStorage`, which
// the seam must preserve byte for byte.
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Every key held, in no particular order; the delete-all-data sweep removes by prefix. */
  keys(): string[];
}

/** For tests and hosts with no persistence. */
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
