/** The px ladder the editor and the calendar both offer. One list so the two
 *  rows render the same options, and one place to change if the ladder ever
 *  moves — a size missing here is reachable by neither Settings nor ⌘+/⌘−.
 *  The top is 2× the editor default because that is the size the accessibility
 *  guidance asks text to reach, not because 28 renders particularly well. The
 *  bottom is there for the calendar, where a day column is narrow enough that
 *  fitting another event title beats reading comfort. */
export const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24, 28] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

/** The next size up (`1`) or down (`-1`), or the same value at either end.
 *  Matches on the value rather than a ladder position, so a size persisted by an
 *  older ladder still steps instead of stranding the shortcuts. */
export function stepTextSize(size: TextSize, direction: 1 | -1): TextSize {
  if (direction === 1) return TEXT_SIZES.find((s) => s > size) ?? size;
  const smaller = TEXT_SIZES.filter((s) => s < size);
  return smaller[smaller.length - 1] ?? size;
}
