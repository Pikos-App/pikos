// ─── Recurrence expansion ─────────────────────────────────────────────────
//
// Expands a PageRecurrenceRule into virtual calendar occurrences for a given
// date range. Virtual occurrences are PageSummary-shaped objects that the
// calendar can render alongside real page_schedules rows.
//
// Key design points:
// - Expansion happens client-side via rrule.js (no backend round-trip)
// - Excluded dates (rruleExdates) and overridden dates (materialised
//   page_schedules rows with ruleId set) are filtered out
// - Each virtual occurrence carries the source page's metadata + computed
//   scheduledStart/scheduledEnd for that specific occurrence

import {
  addDays,
  addMinutes,
  differenceInMinutes,
  endOfDay,
  getHours,
  getMinutes,
  getSeconds,
  set,
} from "date-fns";
import { RRule } from "rrule";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import { formatDateOnly, formatLocalISO, parseLocalISO } from "./dates";

export interface VirtualOccurrence extends PageSummary {
  /** True for virtual rrule-expanded occurrences (not materialised in page_schedules). */
  isVirtual: true;
  /** The recurrence rule ID this occurrence was expanded from. */
  ruleId: string;
  /** The original rrule occurrence date (YYYY-MM-DD) — used for skip/override. */
  originalDate: string;
}

/**
 * Expands a recurrence rule into virtual occurrences within [rangeStart, rangeEnd].
 *
 * @param rule - The recurrence rule to expand
 * @param page - The template page (provides title, folder, status, etc.)
 * @param rangeStart - Start of the visible date range (inclusive)
 * @param rangeEnd - End of the visible date range (exclusive)
 * @param existingSchedules - Materialised overrides for this page (ruleId set);
 *   their originalDate values are excluded from virtual expansion.
 */
export function expandRecurrenceForRange(
  rule: PageRecurrenceRule,
  page: PageSummary,
  rangeStart: Date,
  rangeEnd: Date,
  existingSchedules: PageSchedule[] = []
): VirtualOccurrence[] {
  // Build the set of dates that have been materialised as overrides or skipped.
  const excludedDates = new Set<string>([
    ...rule.rruleExdates,
    ...existingSchedules
      .filter((s) => s.ruleId === rule.id && s.originalDate)
      .map((s) => s.originalDate!),
  ]);

  // Parse the base occurrence times to compute duration offset.
  const baseStart = parseLocalISO(rule.scheduledStart);
  const baseEnd = rule.scheduledEnd ? parseLocalISO(rule.scheduledEnd) : null;
  const durationMinutes = baseEnd ? differenceInMinutes(baseEnd, baseStart) : null;
  const isAllDay = !rule.scheduledStart.includes("T");

  // rrule.js treats all dates as UTC internally. To get correct results we
  // must feed it UTC datetimes whose year/month/day/hour/minute match the
  // local wall-clock values. For timed events this means shifting the local
  // DTSTART into a fake UTC date; for all-day events we use midnight UTC on
  // the same calendar date.
  const dtstartUtc = toFakeUtc(baseStart);
  const rrule = new RRule({
    ...RRule.parseString(rule.rrule),
    dtstart: dtstartUtc,
  });

  // Expand within range [rangeStart, rangeEnd).
  // Shift range bounds into the same fake-UTC space so between() matches.
  const afterUtc = toFakeUtc(rangeStart);
  const beforeUtc = toFakeUtc(new Date(rangeEnd.getTime() - 1));
  const occurrences = rrule.between(afterUtc, beforeUtc, true);

  const results: VirtualOccurrence[] = [];

  for (const occDateUtc of occurrences) {
    // Convert fake-UTC back to a local Date with the same wall-clock values.
    const occDate = fromFakeUtc(occDateUtc);
    const dateStr = formatDateOnly(occDate);

    // Skip excluded/overridden dates.
    if (excludedDates.has(dateStr)) continue;

    // Compute this occurrence's scheduled start/end.
    let scheduledStart: string;
    let scheduledEnd: string | null = null;

    if (isAllDay) {
      scheduledStart = dateStr;
    } else {
      // Preserve the wall-clock time from the base occurrence on this date.
      const occStart = set(occDate, {
        hours: getHours(baseStart),
        milliseconds: 0,
        minutes: getMinutes(baseStart),
        seconds: getSeconds(baseStart),
      });
      scheduledStart = formatLocalISO(occStart);
      if (durationMinutes !== null) {
        scheduledEnd = formatLocalISO(addMinutes(occStart, durationMinutes));
      }
    }

    results.push({
      ...page,
      // Virtual occurrence markers.
      isVirtual: true,
      originalDate: dateStr,
      ruleId: rule.id,
      scheduledEnd,
      // Override schedule fields for this occurrence.
      scheduledStart,
    });
  }

  return results;
}

/**
 * Converts a local Date into a fake-UTC Date where the UTC fields match the
 * local wall-clock values. rrule.js operates entirely in UTC, so this trick
 * makes it produce occurrences on the correct local calendar dates.
 */
function toFakeUtc(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds()
    )
  );
}

/** Inverse of toFakeUtc — reads UTC fields and creates a local Date. */
function fromFakeUtc(d: Date): Date {
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds()
  );
}

/**
 * Returns the next occurrence of a recurrence rule strictly after `afterDate`.
 * Uses the rule's scheduledStart as DTSTART anchor. Returns null if the rule
 * has no more future occurrences (e.g. UNTIL has passed).
 *
 * @param rruleStr - RRULE string without "RRULE:" prefix (e.g. "FREQ=WEEKLY;BYDAY=MO")
 * @param scheduledStart - The rule's base scheduledStart (ISO date or datetime)
 * @param afterDate - Find the next occurrence strictly after this date
 */
export function nextOccurrenceAfter(
  rruleStr: string,
  scheduledStart: string,
  afterDate: Date
): { scheduledStart: string; scheduledEnd: string | null } | null {
  const baseStart = parseLocalISO(scheduledStart);
  const isAllDay = !scheduledStart.includes("T");

  const dtstartUtc = toFakeUtc(baseStart);
  const rrule = new RRule({
    ...RRule.parseString(rruleStr),
    dtstart: dtstartUtc,
  });

  // Find the first occurrence strictly after afterDate's entire day.
  const afterUtc = toFakeUtc(endOfDay(afterDate));
  const next = rrule.after(afterUtc, false);

  if (!next) return null;

  const nextLocal = fromFakeUtc(next);

  if (isAllDay) {
    return { scheduledEnd: null, scheduledStart: formatDateOnly(nextLocal) };
  }

  // Preserve the wall-clock time from the base start on the new date
  const adjusted = set(nextLocal, {
    hours: getHours(baseStart),
    milliseconds: 0,
    minutes: getMinutes(baseStart),
    seconds: getSeconds(baseStart),
  });
  return { scheduledEnd: null, scheduledStart: formatLocalISO(adjusted) };
}

/**
 * Computes the next occurrence's scheduledEnd given a base rule with start+end times.
 * Preserves the original duration by applying the base end's time to the new date.
 */
export function computeNextEnd(baseEnd: string, nextStart: string): string | null {
  if (!baseEnd.includes("T") || !nextStart.includes("T")) return null;
  const baseEndDate = parseLocalISO(baseEnd);
  const nextStartDate = parseLocalISO(nextStart);
  let nextEndDate = set(nextStartDate, {
    hours: getHours(baseEndDate),
    milliseconds: 0,
    minutes: getMinutes(baseEndDate),
    seconds: getSeconds(baseEndDate),
  });
  // If end is before start (shouldn't happen but guard), push to next day
  if (nextEndDate <= nextStartDate) {
    nextEndDate = addDays(nextEndDate, 1);
  }
  return formatLocalISO(nextEndDate);
}

/**
 * Converts an RRULE string (e.g. "FREQ=WEEKLY;BYDAY=MO") to a human-readable
 * label (e.g. "every week on Monday"). Falls back to the raw string on error.
 */
export function rruleToLabel(rruleStr: string): string {
  try {
    const rule = RRule.fromString(`RRULE:${rruleStr}`);
    return rule.toText();
  } catch {
    return rruleStr;
  }
}
