/** Strips leading emoji, including ZWJ sequences and variation selectors. */
const EMOJI_PREFIX_RE = /^(?:\p{Extended_Pictographic}|\s|\u200D|\uFE0F|\uFE0E)+/u;
export function stripLeadingEmoji(s: string): string {
  return s.replace(EMOJI_PREFIX_RE, "");
}

// Numeric collation, so embedded numbers sort by value (1, 2, 10) and not lexicographically.
const COLLATOR = new Intl.Collator(undefined, { numeric: true });

/** Alphabetical, ignoring leading emoji; numbers compare by value ("Item 2" before "Item 10"). */
export function emojiAwareCompare(a: string, b: string): number {
  return COLLATOR.compare(stripLeadingEmoji(a), stripLeadingEmoji(b));
}
