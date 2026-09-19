// How long ago a page was trashed.
//
// Counted in whole days rather than hours because that is the unit the trash's
// promise is made in ("kept for 30 days") — a row the user reads as "deleted 29
// days ago" is one they have a day to save, and an elapsed time measured any
// finer would disagree with the sweep that acts on it.

const MS_PER_DAY = 86_400_000;

/** Whole days between `deletedAt` (UTC ISO, as the writer stamps it) and now.
 *  Negative differences (a clock that moved backwards) clamp to 0 rather than
 *  reading as a deletion from the future. */
export function daysSince(deletedAt: string, now: Date = new Date()): number {
  const then = new Date(deletedAt).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

/** "Deleted today" / "Deleted yesterday" / "Deleted N days ago". */
export function deletedAgoLabel(deletedAt: string, now: Date = new Date()): string {
  const days = daysSince(deletedAt, now);
  if (days === 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}
