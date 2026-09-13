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

/**
 * The calendar-owned metadata a mirror page contributes to the index, as one
 * blob. Twin of `mirror_search_text` in `reconciler.rs`, which writes it to the
 * `pages.mirror_search_text` denorm `pages_fts` reads — a field added on one side
 * and not the other is a page findable in the app and not in test mode.
 * Null when there is nothing to index.
 */
export function mirrorSearchText(
  location: string | null | undefined,
  attendees: readonly string[] | null | undefined
): string | null {
  const parts = [location ?? "", ...(attendees ?? [])].filter((p) => p.trim() !== "");
  return parts.length > 0 ? parts.join("\n") : null;
}
