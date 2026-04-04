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

import { addMinutes, differenceInMinutes } from "date-fns";
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

  // Build RRule instance. DTSTART = rangeStart (or rule base) to ensure
  // we get occurrences within the window. The RRULE string itself has no DTSTART.
  const rrule = RRule.fromString(`DTSTART:${formatRRuleDtstart(baseStart)}\nRRULE:${rule.rrule}`);

  // Expand within range [rangeStart, rangeEnd).
  // RRule.between(after, before, inc) — inc=true makes both ends inclusive.
  // Shift rangeEnd back 1ms to make it exclusive.
  const occurrences = rrule.between(rangeStart, new Date(rangeEnd.getTime() - 1), true);

  const results: VirtualOccurrence[] = [];

  for (const occDate of occurrences) {
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
      const occStart = new Date(occDate);
      occStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), 0);
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
 * Formats a Date as an RRule DTSTART value (local, no timezone — matching
 * Pikos's local wall-clock convention).
 */
function formatRRuleDtstart(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
