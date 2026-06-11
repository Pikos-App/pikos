import { isAllDayIso, parseLocalISO } from "@pikos/core";
import { addHours, format, getHours, getMinutes, isToday, isTomorrow, startOfDay } from "date-fns";

import { formatDateRange } from "@/shared/utils/formatDateRange";

export function toISODateOnly(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function toISODateTime(date: Date, hour24: number, minute: number): string {
  const base = format(date, "yyyy-MM-dd");
  const hourStr = String(hour24).padStart(2, "0");
  const minuteStr = String(minute).padStart(2, "0");
  return `${base}T${hourStr}:${minuteStr}:00`;
}

export function formatTimeOfDay(hour24: number, minute: number): string {
  const displayHour = hour24 % 12 || 12;
  const minuteStr = String(minute).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  return `${displayHour}:${minuteStr} ${period}`;
}

function formatTimeCompact(hour24: number, minute: number): string {
  const displayHour = hour24 % 12 || 12;
  const minuteStr = String(minute).padStart(2, "0");
  const period = hour24 >= 12 ? "pm" : "am";
  return `${displayHour}:${minuteStr}${period}`;
}

export function formatDurationLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function computeEndTimeLabel(
  hour24: number,
  minute: number,
  durationMinutes: number
): string {
  const totalMinutes = hour24 * 60 + minute + durationMinutes;
  return formatTimeOfDay(Math.floor(totalMinutes / 60) % 24, totalMinutes % 60);
}

export function formatTriggerLabel(
  iso: string,
  endIso: string | null | undefined,
  isDone: boolean
): { label: string; isPast: boolean; isDueSoon: boolean } {
  const date = parseLocalISO(iso);
  const now = new Date();
  const isAllDay = isAllDayIso(iso);
  const durationMinutes =
    !isAllDay && endIso && !isAllDayIso(endIso)
      ? Math.round((parseLocalISO(endIso).getTime() - parseLocalISO(iso).getTime()) / 60000)
      : null;
  const isAllDaySpan = isAllDay && endIso && isAllDayIso(endIso) && endIso > iso;
  const durationSuffix =
    durationMinutes && durationMinutes > 0 ? ` · ${formatDurationLabel(durationMinutes)}` : "";

  const isPast = isAllDay ? date < startOfDay(now) : date < now;
  const dueSoon = !isPast && !isDone && date < addHours(now, 48);

  // Multi-day all-day: show the explicit range ("May 2 – 10"). Skipping the
  // Today/Tomorrow relative labels — a span isn't "today", and the end date is
  // the more informative signal.
  if (isAllDaySpan) {
    return { isDueSoon: dueSoon, isPast: isPast && !isDone, label: formatDateRange(iso, endIso) };
  }

  if (isToday(date)) {
    if (isAllDay) return { isDueSoon: dueSoon, isPast: false, label: "Today" };
    return {
      isDueSoon: dueSoon,
      isPast: isPast && !isDone,
      label: `Today ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  if (isTomorrow(date)) {
    if (isAllDay) return { isDueSoon: dueSoon, isPast: false, label: "Tomorrow" };
    return {
      isDueSoon: dueSoon,
      isPast: false,
      label: `Tomorrow ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  const dateStr = format(date, "MMM d");
  if (!isAllDay) {
    return {
      isDueSoon: dueSoon,
      isPast: isPast && !isDone,
      label: `${dateStr} ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  return { isDueSoon: dueSoon, isPast: isPast && !isDone, label: dateStr };
}

export interface TimeSlot {
  idx: number;
  hour24: number;
  minute: number;
  label: string;
}

export const TIME_SLOTS: TimeSlot[] = Array.from({ length: 96 }, (_, idx) => {
  const hour24 = Math.floor(idx / 4);
  const minute = (idx % 4) * 15;
  return { hour24, idx, label: formatTimeOfDay(hour24, minute), minute };
});

export const DURATION_PRESETS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1.5h", minutes: 90 },
  { label: "2h", minutes: 120 },
] as const;

// Span length presets for all-day events. "2d" = start + 1 day (2-day span).
export const DAYS_PRESETS = [
  { days: 2, label: "2d" },
  { days: 3, label: "3d" },
  { days: 5, label: "5d" },
  { days: 7, label: "1w" },
  { days: 14, label: "2w" },
] as const;

export function parseCustomTimeStr(input: string): { hour24: number; minute: number } | null {
  const normalized = input.trim().replace(/\s+/g, "");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1] ?? "0");
  const minutes = match[2] !== undefined ? parseInt(match[2]) : 0;
  const period = match[3]?.toLowerCase();

  if (minutes < 0 || minutes > 59) return null;

  if (period === undefined) {
    if (hours < 0 || hours > 23) return null;
    return { hour24: hours, minute: minutes };
  }
  if (hours < 1 || hours > 12) return null;
  if (period === "pm" && hours !== 12) hours += 12;
  if (period === "am" && hours === 12) hours = 0;
  return { hour24: hours, minute: minutes };
}

// Custom duration parser: accepts plain numbers as minutes ("90") and
// hour/minute units in any combination, with or without spaces: "90m",
// "90 min", "1h", "1.5h", "1hr", "1 hour 30 mins", "1h30m", "1hr 20min".
// Hours: h/hr/hrs/hour/hours. Minutes: m/min/mins/minute/minutes.

const DURATION_HOUR_UNIT = "(?:hours|hour|hrs|hr|h)";
const DURATION_MIN_UNIT = "(?:minutes|minute|mins|min|m)";
const DURATION_RE = new RegExp(
  `^(?:(\\d+(?:\\.\\d+)?)\\s*${DURATION_HOUR_UNIT})?\\s*(?:(\\d+)\\s*${DURATION_MIN_UNIT})?$`
);

export function parseCustomDurationStr(input: string): number | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const n = parseFloat(normalized);
    return n > 0 ? Math.round(n) : null;
  }

  const match = normalized.match(DURATION_RE);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;

  const hours = match[1] !== undefined ? parseFloat(match[1]) : 0;
  const minutes = match[2] !== undefined ? parseInt(match[2]) : 0;
  const total = Math.round(hours * 60 + minutes);
  return total > 0 ? total : null;
}
