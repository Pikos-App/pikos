import { getHours, getMinutes } from "date-fns";

/**
 * The one way Pikos writes a clock time: `9:00am`, `3:30pm`, minutes always shown and the period
 * lowercase. Any new time surface routes through here. The calendar grid alone uses
 * `formatTime12h`, since an hour gridline and a narrow week-view block have no room for `:00`.
 */
export function formatClockTime(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const period = hour < 12 ? "am" : "pm";
  return `${h}:${String(minute).padStart(2, "0")}${period}`;
}

/**
 * A 12-hour time for the calendar grid only (`formatClockTime` for everything else): no leading
 * zero on the hour and no `:mm` on the hour (`9 AM`). `{ period: false }` drops AM/PM when an
 * adjacent label implies it in a range.
 */
export function formatTime12h(date: Date, opts: { period?: boolean } = {}): string {
  const includePeriod = opts.period !== false;
  return formatTime12hParts(getHours(date), getMinutes(date), includePeriod);
}

/** `formatTime12h` from `{ hour, minute }` integers. */
export function formatTime12hParts(hour: number, minute: number, includePeriod = true): string {
  const h = hour % 12 || 12;
  const minStr = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  if (!includePeriod) return `${h}${minStr}`;
  const period = hour < 12 ? "AM" : "PM";
  return `${h}${minStr} ${period}`;
}
