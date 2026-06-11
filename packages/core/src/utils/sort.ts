/** Strip leading emoji (including ZWJ sequences and variation selectors) from a string. */
const EMOJI_PREFIX_RE = /^(?:\p{Extended_Pictographic}|\s|\u200D|\uFE0F|\uFE0E)+/u;
export function stripLeadingEmoji(s: string): string {
  return s.replace(EMOJI_PREFIX_RE, "");
}

// Numeric collation so embedded numbers sort by value (1, 2, 10, 100) rather
// than lexicographically (1, 10, 100, 2).
const COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * Compare two strings alphabetically, ignoring leading emoji. Numbers within
 * the strings are compared numerically (e.g. "Item 2" sorts before "Item 10").
 */
export function emojiAwareCompare(a: string, b: string): number {
  return COLLATOR.compare(stripLeadingEmoji(a), stripLeadingEmoji(b));
}
