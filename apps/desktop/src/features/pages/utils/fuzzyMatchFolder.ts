import type { Folder } from "@pikos/core";

/**
 * Maps a parsed `folderQuery` string from the NLP parser to an actual Folder
 * by name, with three tiers of precedence: exact case-insensitive match,
 * prefix match, then substring match. Returns null when no folder matches.
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
