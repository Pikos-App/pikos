// Extracted from FindContentPopover for testability (no ProseMirror dependency).

export interface TextMatch {
  /** 0-based index into the flat text string. */
  start: number;
  end: number;
}

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
