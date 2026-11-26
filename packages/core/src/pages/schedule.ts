// Pure date-string transforms, shared by calendar blocks and the editor's date-picker chip.

import { formatLocalISO, isAllDayIso, isTimedIso, parseLocalISO } from "../utils/dates";

/**
 * What to do with an event's end when the picker gives a new start: all-day to timed collapses to
 * a single day; timed to all-day keeps the date extent; timed to timed keeps the duration;
 * all-day to all-day keeps the end, dropped if now before the start. Returns start = `iso` and an
 * end ISO or undefined. `iso` must be non-null: callers treat null as "clear schedule" first.
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

  // The end loses its time but keeps its date.
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

/** The `end` arg for `scheduleOnce` from the end-date picker's value: `undefined` when it cleared
 * the end or the end would be <= start (single-day), and a datetime end on an all-day start is
 * stripped to date-only. */
export function normalizeEndInput(currentStart: string, endIso: string | null): string | undefined {
  if (endIso === null) return undefined;
  const startIsAllDay = isAllDayIso(currentStart);
  let next = endIso;
  if (startIsAllDay && isTimedIso(next)) next = next.slice(0, 10);
  if (next <= currentStart) return undefined;
  return next;
}
