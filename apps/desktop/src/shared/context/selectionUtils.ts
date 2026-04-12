/** Compute range-selected IDs between two anchors in a visible list. */
export function computeRangeSelection(
  visibleIds: string[],
  anchorId: string,
  targetId: string
): Set<string> {
  const anchorIdx = visibleIds.indexOf(anchorId);
  const targetIdx = visibleIds.indexOf(targetId);

  if (anchorIdx === -1 || targetIdx === -1) return new Set<string>();

  const startIdx = Math.min(anchorIdx, targetIdx);
  const endIdx = Math.max(anchorIdx, targetIdx);

  return new Set(visibleIds.slice(startIdx, endIdx + 1));
}
