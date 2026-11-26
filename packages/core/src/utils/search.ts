/**
 * Splits text as FTS5's unicode61 tokenizer does: runs of letters and numbers in any script,
 * every other character a separator. The index is the authority: `search_pages_impl` builds its
 * MATCH from the same split, and both answer to `tests/fixtures/search-tokenization.json`. The
 * class must be Unicode-aware (`\p{L}\p{N}`): an ASCII-only one cuts "café" into "caf".
 *
 * Substring matching is wrong both ways: it finds "eeting" in "Meeting" and misses "team
 * meeting" on a page holding both words apart.
 */
export function ftsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The calendar-owned metadata a mirror page contributes to the index, as one blob; null when
 * there is none. Twin of `mirror_search_text` in `reconciler.rs`, which fills the denorm
 * `pages_fts` reads: a field added on one side only is findable in the app and not in test mode.
 */
export function mirrorSearchText(
  location: string | null | undefined,
  attendees: readonly string[] | null | undefined
): string | null {
  const parts = [location ?? "", ...(attendees ?? [])].filter((p) => p.trim() !== "");
  return parts.length > 0 ? parts.join("\n") : null;
}
