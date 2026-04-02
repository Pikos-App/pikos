/** Compute range-selected IDs between two anchors in a visible list. */
export function computeRangeSelection(
  visibleIds: string[],
  anchorId: string,
  targetId: string
): Set<string> {
  const a = visibleIds.indexOf(anchorId);
  const b = visibleIds.indexOf(targetId);
  if (a === -1 || b === -1) return new Set<string>();
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return new Set(visibleIds.slice(lo, hi + 1));
}
