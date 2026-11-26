import { format, getHours } from "date-fns";

import { formatTime12h } from "../format/formatTime";

/**
 * "9–10:30 AM". The en-dash is unspaced so the label fits in narrow cascaded blocks, where a
 * spaced dash would push the trailing period past the truncation edge. A range with no length is
 * a single time.
 */
export function formatTimeRange(start: Date, end: Date): string {
  if (end.getTime() === start.getTime()) return formatTime12h(start);
  const samePeriod = getHours(start) < 12 === getHours(end) < 12;
  const startLabel = formatTime12h(start, { period: !samePeriod });
  const endLabel = formatTime12h(end);
  return `${startLabel}–${endLabel}`;
}

/** "9 AM Mon – 5 PM Thu": the day of week on each side lets the user read both ends without
 * counting columns. For the first segment of a multi-day event only. */
export function formatMultiDayTimeRange(start: Date, end: Date): string {
  const fmt = (d: Date) => `${formatTime12h(d)} ${format(d, "EEE")}`;
  return `${fmt(start)} – ${fmt(end)}`;
}
