/** The px ladder the editor and the calendar both offer: one list so the two rows render the same
 *  options. The top is 2× the editor default because that is the size the accessibility guidance
 *  asks text to reach; the bottom is for the calendar, where a narrow day column makes fitting
 *  another event title beat reading comfort. */
export const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24, 28] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

/** The next size up (`1`) or down (`-1`), or the same value at either end. Matches on the value, not
 *  a ladder position, so a size persisted by an older ladder still steps. */
export function stepTextSize(size: TextSize, direction: 1 | -1): TextSize {
  if (direction === 1) return TEXT_SIZES.find((s) => s > size) ?? size;
  const smaller = TEXT_SIZES.filter((s) => s < size);
  return smaller[smaller.length - 1] ?? size;
}
