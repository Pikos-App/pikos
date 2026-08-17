/**
 * Split text the way FTS5's unicode61 tokenizer does — runs of letters and numbers in
 * any script, with every other character a separator. The index is the authority here,
 * not either implementation: `search_pages_impl` builds its MATCH from the same split,
 * and both sides answer to `tests/fixtures/search-tokenization.json`. The character
 * class has to be Unicode-aware (`\p{L}\p{N}`, the categories unicode61 keeps): an
 * ASCII-only class cuts "café" into "caf", which the index never does.
 *
 * Substring matching was the obvious shortcut and it is wrong in both directions: it
 * finds "eeting" inside "Meeting", which the index never does, and it misses "team
 * meeting" on a page holding both words apart, which the index always finds. An e2e
 * written against either behaviour proves nothing.
 */
export function ftsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
