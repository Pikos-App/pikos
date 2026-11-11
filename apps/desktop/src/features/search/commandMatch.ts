export type CommandMatch = {
  /** Lower ranks first: the label's start, then a word's start, then anywhere, then scattered letters. */
  rank: 0 | 1 | 2 | 3;
  /** Positions in the label that matched, for highlighting. */
  indices: number[];
};

function span(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/** How `filter` (already lower-cased) matches a command label, or null for no match. */
export function matchCommand(label: string, filter: string): CommandMatch | null {
  if (filter === "") return { indices: [], rank: 0 };

  const haystack = label.toLowerCase();
  if (haystack.startsWith(filter)) return { indices: span(0, filter.length), rank: 0 };

  const wordStart = haystack.indexOf(` ${filter}`);
  if (wordStart >= 0) return { indices: span(wordStart + 1, filter.length), rank: 1 };

  const anywhere = haystack.indexOf(filter);
  if (anywhere >= 0) return { indices: span(anywhere, filter.length), rank: 2 };

  const indices: number[] = [];
  for (let i = 0; i < haystack.length && indices.length < filter.length; i++) {
    if (haystack[i] === filter[indices.length]) indices.push(i);
  }

  return indices.length === filter.length ? { indices, rank: 3 } : null;
}
