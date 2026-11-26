// How long ago a page was trashed, in whole days: the unit of the trash's promise ("kept for 30
// days"), so a finer measure would disagree with the sweep that acts on it.

const MS_PER_DAY = 86_400_000;

/** Whole days between `deletedAt` (UTC ISO, as the writer stamps it) and now.
 *  Negative differences (a clock that moved backwards) clamp to 0 rather than
 *  reading as a deletion from the future. */
export function daysSince(deletedAt: string, now: Date = new Date()): number {
  const then = new Date(deletedAt).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

export function deletedAgoLabel(deletedAt: string, now: Date = new Date()): string {
  const days = daysSince(deletedAt, now);
  if (days === 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}
