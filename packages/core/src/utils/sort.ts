// Sort utilities — emoji-aware string comparison for user-facing labels.

/** Strip leading emoji (including ZWJ sequences and variation selectors) from a string. */
const EMOJI_PREFIX_RE = /^(?:\p{Extended_Pictographic}|\s|\u200D|\uFE0F|\uFE0E)+/u;
export function stripLeadingEmoji(s: string): string {
  return s.replace(EMOJI_PREFIX_RE, "");
}

/** Compare two strings alphabetically, ignoring leading emoji. */
export function emojiAwareCompare(a: string, b: string): number {
  return stripLeadingEmoji(a).localeCompare(stripLeadingEmoji(b));
}
