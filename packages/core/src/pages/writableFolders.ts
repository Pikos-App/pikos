import type { Folder } from "../types";

/**
 * Folders a page may be placed in, by create or by move. External-calendar
 * folders are excluded: they are system-managed, only the reconciler seeds
 * them, and the backend refuses both gestures — a page that did land in one
 * would be trapped there by the placement lock. Offering one silently reverts
 * the gesture, so every surface that picks a folder resolves against this list.
 */
export function writableFolders(folders: Folder[]): Folder[] {
  return folders.filter((folder) => !folder.isExternalCalendar);
}

/**
 * Which folder a page created from a view lands in: the active folder, else the
 * configured default, else Inbox (null). Both candidates are looked up in
 * `writableFolders`, so a view or a stale setting naming a folder that cannot
 * hold pages falls through to the next one instead of failing the create.
 */
export function folderIdForNewPage(
  viewId: string,
  folders: Folder[],
  defaultFolderId: string | null
): string | null {
  const writable = writableFolders(folders);
  return (
    writable.find((folder) => folder.id === viewId)?.id ??
    writable.find((folder) => folder.id === defaultFolderId)?.id ??
    null
  );
}
