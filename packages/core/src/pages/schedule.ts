// Scheduling helpers used by both calendar blocks and the editor's
// date-picker chip. Pure date-string transforms — no calendar layout deps —
// so they belong in shared/ rather than features/calendar/utils.

import { addMinutes, getHours, getMinutes } from "date-fns";

import { toISODateOnly, toISODateTime } from "../format/dateTimePicker";
import type { TypedTime } from "../nlp/typedTime";
import { formatLocalISO, isAllDayIso, isTimedIso, parseLocalISO } from "../utils/dates";

/**
 * Decides what to do with an event's end when the user picks a new start ISO
 * in the date picker. Handles four transitions:
 *   - all-day → timed: collapse to single day (end undefined)
 *   - timed → all-day: preserve date extent (drop time from end)
 *   - timed → timed: preserve duration
 *   - all-day → all-day: preserve end, drop if it's now before the new start
 * Returns start = iso and either an end ISO or undefined (single occurrence).
 * `iso` must be non-null — callers should treat null as "clear schedule" first.
 */
export function computeScheduleTransition(
  current: { start: string | null | undefined; end: string | null | undefined },
  iso: string
): { start: string; end: string | undefined } {
  const currStart = current.start;
  const currEnd = current.end;
  const wasAllDay = currStart != null && isAllDayIso(currStart);
  const nowAllDay = isAllDayIso(iso);

  // all-day → timed: collapse to single day.
  if (wasAllDay && !nowAllDay) return { end: undefined, start: iso };

  // timed → all-day: strip time from end; preserve date extent.
  if (currStart != null && !wasAllDay && nowAllDay) {
    if (currEnd && isTimedIso(currEnd)) {
      const endDateOnly = currEnd.slice(0, 10);
      return { end: endDateOnly > iso ? endDateOnly : undefined, start: iso };
    }
    return { end: currEnd && currEnd > iso ? currEnd : undefined, start: iso };
  }

  // timed → timed: preserve duration.
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

  // all-day → all-day: preserve end, drop if now before new start.
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
 * Places a typed time on the page's own day, or on `today` when it has none. A typed length
 * sets the end; without one the page keeps its length, as any other move of a timed page does.
 */
export function scheduleAtTypedTime(
  current: { start: string | null | undefined; end: string | null | undefined },
  time: TypedTime,
  today: Date
): { start: string; end: string | undefined } {
  const day = current.start ? parseLocalISO(current.start) : today;
  const start = toISODateTime(day, time.hour24, time.minute);
  const length = time.durationMinutes ?? 0;
  if (length <= 0) return computeScheduleTransition(current, start);

  return { end: formatLocalISO(addMinutes(parseLocalISO(start), length)), start };
}

/**
 * Normalises the value returned from the end-date picker into the `end` arg
 * for `scheduleOnce`. Returns `undefined` when the picker cleared the end or
 * when the resulting end would be <= start (single-day semantics). For all-day
 * starts, any datetime end is stripped back to date-only.
 */
export function normalizeEndInput(currentStart: string, endIso: string | null): string | undefined {
  if (endIso === null) return undefined;
  const startIsAllDay = isAllDayIso(currentStart);
  let next = endIso;
  if (startIsAllDay && isTimedIso(next)) next = next.slice(0, 10);
  if (next <= currentStart) return undefined;
  return next;
}
