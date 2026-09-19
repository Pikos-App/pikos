import { getHours, getMinutes } from "date-fns";

/**
 * Formats a Date as a 12-hour wall-clock time with AM/PM.
 *
 * - Always omits leading zeros on the hour (`9 AM`, not `09:00 AM`).
 * - Omits the `:mm` segment when minutes are zero (`9 AM`, not `9:00 AM`).
 * - Pass `{ period: false }` to drop the AM/PM suffix when the caller is
 *   rendering a range and the period is implied by an adjacent label.
 */
export function formatTime12h(date: Date, opts: { period?: boolean } = {}): string {
  const includePeriod = opts.period !== false;
  return formatTime12hParts(getHours(date), getMinutes(date), includePeriod);
}

/**
 * Like `formatTime12h` but takes raw hour/minute integers. Useful for
 * settings UIs that work with `{ hour, minute }` shapes instead of Dates.
 */
export function formatTime12hParts(hour: number, minute: number, includePeriod = true): string {
  const h = hour % 12 || 12;
  const minStr = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  if (!includePeriod) return `${h}${minStr}`;
  const period = hour < 12 ? "AM" : "PM";
  return `${h}${minStr} ${period}`;
}
