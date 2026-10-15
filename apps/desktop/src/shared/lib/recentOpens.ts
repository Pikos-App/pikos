import type { PageSummary } from "@pikos/core";

/**
 * When each page was last opened this session, kept apart from the page list.
 *
 * Opening a page saves `lastOpenedAt` to the database, but writing it into the in-memory list would
 * replace that list on every click, and everything derived from it (the list rows, the calendar,
 * the folder counts) would recompute over every page: seconds per click at 200,000 pages. Only the
 * search palette's recent pages reads the time, so it reads it from here, over the list's copy.
 */
const opened = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function recordOpen(pageId: string): string {
  const at = new Date().toISOString();
  opened.set(pageId, at);
  version++;
  for (const listener of listeners) listener();
  return at;
}

export function lastOpened(page: PageSummary): string | null {
  return opened.get(page.id) ?? page.lastOpenedAt ?? null;
}

export function subscribeToOpens(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function opensVersion(): number {
  return version;
}
