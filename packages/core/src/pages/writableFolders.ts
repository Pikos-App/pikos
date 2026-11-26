import type { Folder } from "../types";

/**
 * Folders a page may be placed in, by create or move. External-calendar folders are excluded: only
 * the reconciler seeds them, the backend refuses both gestures, and a page that landed in one
 * would be trapped by the placement lock. Every folder picker resolves against this list, so the
 * gesture never silently reverts.
 */
export function writableFolders(folders: Folder[]): Folder[] {
  return folders.filter((folder) => !folder.isExternalCalendar);
}

/**
 * The folder a page created from a view lands in, so it is in that view: the active folder, the
 * Inbox (null) when that is the view, else the configured default, else Inbox. Candidates are
 * looked up in `writableFolders`, so one that can't hold pages falls through to the next.
 */
export function folderIdForNewPage(
  viewId: string,
  folders: Folder[],
  defaultFolderId: string | null
): string | null {
  if (viewId === "inbox") return null;
  const writable = writableFolders(folders);
  return (
    writable.find((folder) => folder.id === viewId)?.id ??
    writable.find((folder) => folder.id === defaultFolderId)?.id ??
    null
  );
}

/** Whether a page created from a view is dated today to be in it. */
export function datesNewPageToday(viewId: string): boolean {
  return viewId === "today" || viewId === "upcoming";
}

/**
 * Where a restored page belongs when its remembered folder has gone (deleted with it, or emptied
 * from the trash meanwhile). The keep test is existence, not writability: a synced page's calendar
 * folder isn't writable, and judging by that would evict every mirror from its calendar. Only the
 * fallback asks what can hold a page, on the same ladder a new one takes.
 */
export function folderIdForRestoredPage(
  rememberedFolderId: string | null,
  folders: Folder[],
  defaultFolderId: string | null
): string | null {
  if (rememberedFolderId === null) return null;
  if (folders.some((folder) => folder.id === rememberedFolderId)) return rememberedFolderId;
  return writableFolders(folders).find((folder) => folder.id === defaultFolderId)?.id ?? null;
}
