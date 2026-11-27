// Pure date-string transforms shared by calendar blocks and the editor's date-picker chip.

import { getHours, getMinutes } from "date-fns";

import { toISODateOnly, toISODateTime } from "../format/dateTimePicker";
import { formatLocalISO, isAllDayIso, isTimedIso, parseLocalISO } from "../utils/dates";

/**
 * The end for an event whose start the user picks as `iso`, which must be non-null (a null
 * pick means "clear schedule"). All-day to timed collapses to a single day; timed to all-day
 * keeps the date extent; timed to timed keeps the duration; all-day to all-day keeps the end
 * unless it now precedes the start. The end is undefined for a single occurrence.
 */
export function computeScheduleTransition(
  current: { start: string | null | undefined; end: string | null | undefined },
  iso: string
): { start: string; end: string | undefined } {
  const currStart = current.start;
  const currEnd = current.end;
  const wasAllDay = currStart != null && isAllDayIso(currStart);
  const nowAllDay = isAllDayIso(iso);

  if (wasAllDay && !nowAllDay) return { end: undefined, start: iso };

  if (currStart != null && !wasAllDay && nowAllDay) {
    if (currEnd && isTimedIso(currEnd)) {
      const endDateOnly = currEnd.slice(0, 10);
      return { end: endDateOnly > iso ? endDateOnly : undefined, start: iso };
    }
    return { end: currEnd && currEnd > iso ? currEnd : undefined, start: iso };
  }

  if (
    !nowAllDay &&
    currStart != null &&
    isTimedIso(currStart) &&
    currEnd != null &&
    isTimedIso(currEnd)
  ) {
    const durationMs = parseLocalISO(currEnd).getTime() - parseLocalISO(currStart).getTime();
    if (durationMs > 0) {
      const endIso = formatLocalISO(new Date(parseLocalISO(iso).getTime() + durationMs));
      return { end: endIso, start: iso };
    }
    return { end: currEnd, start: iso };
  }

  return { end: currEnd && currEnd >= iso ? currEnd : undefined, start: iso };
}

/** Moves a page onto `day`, keeping its time and length; an undated page lands all-day. */
export function scheduleOnDay(
  current: { start: string | null | undefined; end: string | null | undefined },
  day: Date
): { start: string; end: string | undefined } {
  const start = current.start ?? null;
  const iso =
    start !== null && isTimedIso(start)
      ? toISODateTime(day, getHours(parseLocalISO(start)), getMinutes(parseLocalISO(start)))
      : toISODateOnly(day);

  return computeScheduleTransition(current, iso);
}

/**
 * Normalises the end-date picker's value into the `end` arg for `scheduleOnce`. Returns
 * `undefined` when the picker cleared the end or the end would be <= start. For all-day
 * starts, a datetime end is stripped to date-only.
 */
export function normalizeEndInput(currentStart: string, endIso: string | null): string | undefined {
  if (endIso === null) return undefined;
  const startIsAllDay = isAllDayIso(currentStart);
  let next = endIso;
  if (startIsAllDay && isTimedIso(next)) next = next.slice(0, 10);
  if (next <= currentStart) return undefined;
  return next;
}
