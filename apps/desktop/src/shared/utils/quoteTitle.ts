/** Longest title a toast quotes whole; with the sentence around it, it still fits the toast's two lines. */
const MAX_QUOTED_TITLE_CHARS = 48;

/**
 * A page or folder name in curly quotes for a toast. A long name is cut inside
 * the quotes, so the closing quote survives where the toast's own clamp would drop it.
 */
export function quoteTitle(title: string): string {
  const name = title || "Untitled";
  const isLong = name.length > MAX_QUOTED_TITLE_CHARS;
  const shown = isLong ? `${name.slice(0, MAX_QUOTED_TITLE_CHARS).trimEnd()}…` : name;

  return `“${shown}”`;
}
