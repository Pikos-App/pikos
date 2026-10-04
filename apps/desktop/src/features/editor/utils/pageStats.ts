const WORDS_PER_MINUTE = 238;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/** Rounded rather than rounded up: rounding up put every short note at "1 min", so
 *  "< 1 min" only ever showed on an empty page. */
export function readingTime(wordCount: number): string {
  const minutes = wordCount / WORDS_PER_MINUTE;
  if (minutes < 1) return "< 1 min";
  return `${Math.round(minutes)} min`;
}
