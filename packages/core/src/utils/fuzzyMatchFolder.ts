import type { Folder } from "../types";

/**
 * Resolves the parser's `folderQuery` to a Folder: exact case-insensitive match, then prefix,
 * then substring; null when none match. The CLI resolves the same queries through
 * `pikos_db::fuzzy_match_folder`; both answer to `tests/fixtures/folder-matching.json`.
 */
export function fuzzyMatchFolder(query: string, folders: Folder[]): Folder | null {
  if (!query) return null;
  const normalizedQuery = query.toLowerCase();
  return (
    folders.find((folder) => folder.name.toLowerCase() === normalizedQuery) ??
    folders.find((folder) => folder.name.toLowerCase().startsWith(normalizedQuery)) ??
    folders.find((folder) => folder.name.toLowerCase().includes(normalizedQuery)) ??
    null
  );
}
