import type { Folder } from "@pikos/core";

/**
 * Folders a page may be moved into. Excludes external-calendar folders — the
 * backend rejects a move into one, so offering it would silently revert.
 */
export function folderMoveTargets(folders: Folder[]): Folder[] {
  return folders.filter((folder) => !folder.isExternalCalendar);
}
