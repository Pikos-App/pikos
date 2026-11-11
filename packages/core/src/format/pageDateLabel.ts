// Date chip labels for the page list. Every label pairs a short display string
// with the full date as a hover tooltip, and reports whether the schedule has
// already passed so the caller can colour it.
//
// Locale is left to the system (no explicit locale argument) so these read the
// way the rest of the app does — see UsageStats and the settings surfaces.

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

  // Timed events today always show the time (past ones in red, upcoming as muted).
  // This keeps them visually distinct from any all-day event on the same date.
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

  // Timed non-today: show date only; time is available on hover via tooltip
  const label = dateLabel;
  return { isPast, label, tooltip };
}

export function formatPageRelativeTime(iso: string, now: Date = new Date()): PageDateLabel {
  const isAllDay = isAllDayIso(iso);
  const tooltip = tooltipFor(iso);

  if (isAllDay) {
    const date = parseLocalISO(iso);
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((date.getTime() - todayMidnight.getTime()) / 86400000);
    if (diffDays === 0) return { isPast: false, label: "today", tooltip };
    if (diffDays < 0) return { isPast: true, label: `${Math.abs(diffDays)}d`, tooltip };
    return { isPast: false, label: `${diffDays}d`, tooltip };
  }

  const date = parseLocalISO(iso);
  const diffMs = date.getTime() - now.getTime();
  const isPast = diffMs < 0;
  const abs = Math.abs(diffMs);
  const absMins = Math.round(abs / 60000);

  // Within the hour → relative only (already time-informative)
  if (absMins < 60)
    return { isPast: isPast && absMins > 0, label: absMins === 0 ? "now" : `${absMins}m`, tooltip };
  const absHours = Math.round(abs / 3600000);
  // Within the day → relative only
  if (absHours < 24) return { isPast, label: `${absHours}hr`, tooltip };
  const days = Math.round(abs / 86400000);
  return { isPast, label: `${days}d`, tooltip };
}
