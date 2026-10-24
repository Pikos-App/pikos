import type { Folder, PageSummary, PageUpdate } from "@pikos/core";
import {
  fuzzyMatchFolder,
  NLP_PRIORITY_MAP,
  parseInput,
  parseLocalISO,
  writableFolders,
} from "@pikos/core";

export interface BlockTitleEdit {
  patch: PageUpdate;
  rrule: string | null;
}

/** A title typed on a calendar block, read as Quick Add reads it, minus the date (`ParseOptions.rename`). */
export function blockTitleEdit(
  typed: string,
  openingTitle: string,
  page: PageSummary,
  folders: Folder[]
): BlockTitleEdit {
  const slot = page.scheduledStart ? parseLocalISO(page.scheduledStart) : undefined;
  const result = parseInput(typed, slot, { rename: true });
  const parsed = result.type === "finite" ? result.inputs[0] : result.input;

  const patch: PageUpdate = { title: parsed?.title || openingTitle };

  if (parsed?.tags.length) {
    patch.tags = [...new Set([...page.tags, ...parsed.tags])];
  }

  if (parsed?.priority !== undefined) {
    patch.priority = parsed.priority === null ? 0 : (NLP_PRIORITY_MAP[parsed.priority] ?? 0);
  }

  if (parsed?.folderQuery) {
    const match = fuzzyMatchFolder(parsed.folderQuery, writableFolders(folders));
    const isInbox = parsed.folderQuery.toLowerCase() === "inbox";
    if (match) {
      patch.folderId = match.id;
    } else if (isInbox) {
      patch.folderId = null;
    }
  }

  return { patch, rrule: result.type === "recurring" ? result.rrule : null };
}
