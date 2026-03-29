// textSearch — pure text-search helpers used by FindContentPopover.
// Extracted for testability (no ProseMirror dependency).

export interface TextMatch {
  /** 0-based index into the flat text string. */
  start: number;
  end: number;
}

/**
 * Find all case-insensitive occurrences of `query` in `text`.
 * Returns an array of { start, end } ranges.
 */
export function findAllMatches(text: string, query: string): TextMatch[] {
  if (!query || !text) return [];
  const matches: TextMatch[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let idx = 0;
  while (idx < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, idx);
    if (found === -1) break;
    matches.push({ end: found + query.length, start: found });
    idx = found + 1;
  }
  return matches;
}

/**
 * Count case-insensitive occurrences of `query` in `text`.
 */
export function countTextMatches(text: string, query: string): number {
  if (!query || !text) return 0;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let count = 0;
  let idx = 0;
  while (idx < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, idx);
    if (found === -1) break;
    count++;
    idx = found + 1;
  }
  return count;
}
