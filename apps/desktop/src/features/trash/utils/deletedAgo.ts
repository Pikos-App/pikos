// Whole days, because the trash's promise is made in days ("kept for 30 days"); a finer unit
// would disagree with the sweep that acts on it.

const MS_PER_DAY = 86_400_000;

/** Whole days since `deletedAt`; a clock that moved backwards clamps to 0. */
export function daysSince(deletedAt: string, now: Date): number {
  const then = new Date(deletedAt).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

export function deletedAgoLabel(deletedAt: string, now: Date): string {
  const days = daysSince(deletedAt, now);
  if (days === 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}
