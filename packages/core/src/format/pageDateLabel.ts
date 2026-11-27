// Date chip labels for the page list. Locale is left to the system so these read the way the
// rest of the app does.

import { addDays, endOfDay, startOfDay } from "date-fns";

import { isAllDayIso, parseLocalISO } from "../utils/dates";
import { formatClockTime } from "./formatTime";

export interface PageDateLabel {
  label: string;
  isPast: boolean;
  tooltip: string;
}

/** Always-minutes format: 2:00p, 2:30p, 10:00a, 12:15p. */
export function formatCompactTime(date: Date): string {
  return formatClockTime(date.getHours(), date.getMinutes());
}

/** Full-word date for a tooltip: "Monday, March 23, 2026". */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
    year: "numeric",
  });
}

function tooltipFor(iso: string): string {
  const date = parseLocalISO(iso);
  return isAllDayIso(iso)
    ? formatLongDate(date)
    : date.toLocaleString(undefined, {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "long",
        weekday: "long",
        year: "numeric",
      });
}

/** An all-day date is due for the whole of its day, so it counts from that day's start, not from now. */
export function isDueSoon(iso: string, now: Date = new Date()): boolean {
  const date = parseLocalISO(iso);
  const windowStart = isAllDayIso(iso) ? startOfDay(now) : now;
  const windowEnd = endOfDay(addDays(now, 3));

  return date >= windowStart && date <= windowEnd;
}

export function formatPageDate(iso: string, now: Date = new Date()): PageDateLabel {
  const isAllDay = isAllDayIso(iso);
  const date = parseLocalISO(iso);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 86400000);
  const isPast = isAllDay ? date < todayMidnight : date < now;
  const isToday = date >= todayMidnight && date < tomorrowMidnight;

  const tooltip = tooltipFor(iso);

  // A timed event today shows its time, which keeps it distinct from an all-day event that day.
  if (!isAllDay && isToday) {
    return { isPast, label: formatCompactTime(date), tooltip };
  }

  if (isToday) {
    return { isPast, label: "Today", tooltip };
  }

  const dateLabel = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });

  const label = dateLabel;
  return { isPast, label, tooltip };
}
