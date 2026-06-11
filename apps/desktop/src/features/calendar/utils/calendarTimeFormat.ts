import { format, getHours } from "date-fns";

import { formatTime12h } from "@/shared/utils/formatTime";

/**
 * Formats a time range for display in a PageBlock. Uses an unspaced en-dash
 * (e.g. "9–10:30 AM") so the label fits inside narrow cascaded blocks where
 * a spaced dash would push the trailing period past the truncation edge.
 */
export function formatTimeRange(start: Date, end: Date): string {
  const samePeriod = getHours(start) < 12 === getHours(end) < 12;
  const startLabel = formatTime12h(start, { period: !samePeriod });
  const endLabel = formatTime12h(end);
  return `${startLabel}–${endLabel}`;
}

/**
 * Formats the first-segment label for a multi-day timed event. Includes
 * day-of-week on each side so the user can read both bookends without
 * counting columns: `"9 AM Mon – 5 PM Thu"`. Only applied on the first
 * segment of a multi-day event; subsequent days show the title alone.
 */
export function formatMultiDayTimeRange(start: Date, end: Date): string {
  const fmt = (d: Date) => `${formatTime12h(d)} ${format(d, "EEE")}`;
  return `${fmt(start)} – ${fmt(end)}`;
}
