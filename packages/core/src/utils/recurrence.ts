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
  format,
  getHours,
  getMinutes,
  getSeconds,
  set,
} from "date-fns";
import { RRule } from "rrule";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import { formatDateOnly, formatLocalISO, isAllDayIso, parseLocalISO } from "./dates";

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
  const isAllDay = isAllDayIso(rule.scheduledStart);

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
    const occDate = fromFakeUtc(occDateUtc);
    const dateStr = formatDateOnly(occDate);

    if (excludedDates.has(dateStr)) continue;

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
      isVirtual: true,
      originalDate: dateStr,
      ruleId: rule.id,
      scheduledEnd,
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
 * Realigns a single-BYDAY weekly rule's weekday to match a moved anchor.
 *
 * Moving a recurring head moves the whole series with it (the head IS the
 * series anchor). But a weekly rule pins its weekday in BYDAY, so after moving
 * the head from Monday to Wednesday the rule still reads `BYDAY=MO`; the next
 * occurrence on completion then snaps back to Monday — the head appears to
 * "revert to its original day". This rewrites BYDAY to the anchor's weekday so
 * the series actually follows the move (e.g. "every Monday" → "every
 * Wednesday").
 *
 * Only single-BYDAY weekly rules are realigned — multi-day rules (e.g. M/W/F)
 * are left untouched, since dragging one occurrence off the set is ambiguous
 * (and the series keeps advancing on its remaining days). Non-weekly rules and
 * already-aligned rules are returned unchanged.
 *
 * @param rruleStr - RRULE string without "RRULE:" prefix
 * @param anchorStart - The head's new scheduledStart (ISO date or datetime)
 */
export function alignWeeklyRuleToAnchor(rruleStr: string, anchorStart: string): string {
  const opts = parseRrule(rruleStr);
  if (!opts || opts.freq !== "WEEKLY") return rruleStr;
  if (!opts.byweekday || opts.byweekday.length !== 1) return rruleStr;

  // JS getDay() is 0=Sun…6=Sat; rrule weekday is 0=Mon…6=Sun.
  const jsDay = parseLocalISO(anchorStart).getDay();
  const anchorWeekday = ((jsDay + 6) % 7) as RecurrenceWeekday;
  if (opts.byweekday[0] === anchorWeekday) return rruleStr;

  return buildRrule({ ...opts, byweekday: [anchorWeekday] });
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
  afterDate: Date,
  /**
   * Dates (YYYY-MM-DD) excluded from the rule. Caller should pass
   * `rule.rruleExdates`; without it, the function may return an occurrence
   * that has already been skipped or materialised, which advances the head
   * onto a date the user has already taken out of the series.
   */
  exdates: readonly string[] = []
): { scheduledStart: string; scheduledEnd: string | null } | null {
  const baseStart = parseLocalISO(scheduledStart);
  const isAllDay = isAllDayIso(scheduledStart);

  const dtstartUtc = toFakeUtc(baseStart);
  const rrule = new RRule({
    ...RRule.parseString(rruleStr),
    dtstart: dtstartUtc,
  });

  const exdateSet = new Set(exdates);
  // Iterate forward through occurrences, skipping exdates. Cap at a few
  // hundred steps to bound pathological inputs (e.g. an exdate-list that
  // covers every future occurrence) — rrule's `after(strict=false)` returns
  // the next occurrence past the seed date.
  let cursor = toFakeUtc(endOfDay(afterDate));
  for (let i = 0; i < 500; i++) {
    const next = rrule.after(cursor, false);
    if (!next) return null;
    const nextLocal = fromFakeUtc(next);
    const dateStr = formatDateOnly(nextLocal);
    if (exdateSet.has(dateStr)) {
      cursor = next;
      continue;
    }
    if (isAllDay) {
      return { scheduledEnd: null, scheduledStart: dateStr };
    }
    // Preserve the wall-clock time from the base start on the new date.
    const adjusted = set(nextLocal, {
      hours: getHours(baseStart),
      milliseconds: 0,
      minutes: getMinutes(baseStart),
      seconds: getSeconds(baseStart),
    });
    return { scheduledEnd: null, scheduledStart: formatLocalISO(adjusted) };
  }
  return null;
}

/**
 * Snaps an anchor date to the first occurrence the rule actually permits, on or
 * after the anchor itself, preserving the anchor's wall-clock time.
 *
 * Applying a weekly BYDAY rule (e.g. M/W/F) to a page whose schedule lands on an
 * excluded weekday (e.g. a Sunday) must move the head onto the first allowed day
 * — otherwise the head lingers on a date the rule excludes and renders a stray
 * "first run" on the wrong day, detached from the virtual occurrences.
 *
 * Returns the anchor unchanged when it already satisfies the rule, when the
 * rule yields no occurrence (e.g. COUNT/UNTIL already exhausted), or when the
 * rrule can't be parsed.
 *
 * @param rruleStr - RRULE string without "RRULE:" prefix (e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR")
 * @param anchor - The page's current anchor (ISO date-only or datetime)
 */
export function snapAnchorToRule(rruleStr: string, anchor: string): string {
  const baseStart = parseLocalISO(anchor);
  const isAllDay = isAllDayIso(anchor);
  const dtstartUtc = toFakeUtc(baseStart);

  let rrule: RRule;
  try {
    rrule = new RRule({ ...RRule.parseString(rruleStr), dtstart: dtstartUtc });
  } catch {
    return anchor;
  }

  // dtstart is the anchor, so all occurrences are >= it; `inc: true` returns the
  // anchor itself when it satisfies the rule, else the next permitted date.
  const first = rrule.after(dtstartUtc, true);
  if (!first) return anchor;

  const firstLocal = fromFakeUtc(first);
  if (isAllDay) return formatDateOnly(firstLocal);

  // Preserve the anchor's wall-clock time on the snapped date.
  const adjusted = set(firstLocal, {
    hours: getHours(baseStart),
    milliseconds: 0,
    minutes: getMinutes(baseStart),
    seconds: getSeconds(baseStart),
  });
  return formatLocalISO(adjusted);
}

/**
 * Returns YYYY-MM-DD strings for every rrule occurrence strictly after `after`
 * and strictly before `before`, skipping any in `exdates`. Used to compute the
 * "gap" of missed days between a recurring page's previous anchor and today.
 *
 * The cap (500 iterations) bounds pathological inputs (e.g. a multi-year
 * gap on FREQ=DAILY with an exdate-heavy rule).
 */
export function missedOccurrencesBetween(
  rruleStr: string,
  scheduledStart: string,
  after: Date,
  before: Date,
  exdates: readonly string[] = []
): string[] {
  if (before <= after) return [];
  const baseStart = parseLocalISO(scheduledStart);
  const dtstartUtc = toFakeUtc(baseStart);
  const rrule = new RRule({
    ...RRule.parseString(rruleStr),
    dtstart: dtstartUtc,
  });
  const exdateSet = new Set(exdates);
  const beforeUtc = toFakeUtc(before);

  const results: string[] = [];
  let cursor = toFakeUtc(after); // strictly-after by passing inc=false to .after()
  for (let i = 0; i < 500; i++) {
    const next = rrule.after(cursor, false);
    if (!next) break;
    if (next >= beforeUtc) break;
    const dateStr = formatDateOnly(fromFakeUtc(next));
    if (!exdateSet.has(dateStr)) results.push(dateStr);
    cursor = next;
  }
  return results;
}

/**
 * Computes the next occurrence's scheduledEnd given a base rule with start+end times.
 * Preserves the original duration by applying the base end's time to the new date.
 */
export function computeNextEnd(baseEnd: string, nextStart: string): string | null {
  if (isAllDayIso(baseEnd) || isAllDayIso(nextStart)) return null;
  const baseEndDate = parseLocalISO(baseEnd);
  const nextStartDate = parseLocalISO(nextStart);
  let nextEndDate = set(nextStartDate, {
    hours: getHours(baseEndDate),
    milliseconds: 0,
    minutes: getMinutes(baseEndDate),
    seconds: getSeconds(baseEndDate),
  });
  // End wall-clock earlier than start = overnight event (e.g. 22:00–01:00);
  // the end belongs on the next calendar day.
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

const SHORT_FREQ_LABEL: Record<RecurrenceFreq, string> = {
  DAILY: "Daily",
  MONTHLY: "Monthly",
  WEEKLY: "Weekly",
  YEARLY: "Yearly",
};

const SHORT_INTERVAL_UNIT: Record<RecurrenceFreq, string> = {
  DAILY: "days",
  MONTHLY: "months",
  WEEKLY: "weeks",
  YEARLY: "years",
};

/**
 * Compact label for space-constrained bylines (e.g. QuickAddDialog).
 *   FREQ=WEEKLY;BYDAY=MO            → "Weekly"
 *   FREQ=WEEKLY;INTERVAL=2          → "Every 2 weeks"
 *   FREQ=WEEKLY;BYDAY=MO;COUNT=10   → "Weekly × 10"
 *   FREQ=WEEKLY;BYDAY=MO;UNTIL=...  → "Weekly thru Jun 28"
 * BYDAY is intentionally dropped — the date chip next to it already conveys
 * the anchor weekday.
 */
export function rruleToShortLabel(rruleStr: string): string {
  const opts = parseRrule(rruleStr);
  if (!opts) return rruleStr;

  const base =
    opts.interval > 1
      ? `Every ${opts.interval} ${SHORT_INTERVAL_UNIT[opts.freq]}`
      : SHORT_FREQ_LABEL[opts.freq];

  if (opts.count != null) return `${base} × ${opts.count}`;
  if (opts.until) return `${base} thru ${format(parseLocalISO(opts.until), "MMM d")}`;
  return base;
}

// ─── RRULE editor helpers ─────────────────────────────────────────────────────
// Used by the recurrence picker UI to parse/rebuild RRULE strings from a
// simplified, typed options object. The data model stores RRULE without
// DTSTART — the anchor lives on the page separately.

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/**
 * Weekday index using rrule.js convention: 0 = Monday … 6 = Sunday.
 * Used by `byweekday` on weekly rules.
 */
export type RecurrenceWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface RecurrenceOptions {
  freq: RecurrenceFreq;
  /** Positive integer ≥ 1. Default 1. */
  interval: number;
  /** Weekdays for FREQ=WEEKLY (rrule.js: 0=Monday … 6=Sunday). */
  byweekday?: RecurrenceWeekday[];
  /** End condition — exactly one of `count` or `until` may be set. */
  count?: number;
  /** End condition as YYYY-MM-DD (date-only). */
  until?: string;
}

const FREQ_BY_CONST: Record<number, RecurrenceFreq> = {
  [RRule.DAILY]: "DAILY",
  [RRule.MONTHLY]: "MONTHLY",
  [RRule.WEEKLY]: "WEEKLY",
  [RRule.YEARLY]: "YEARLY",
};

const CONST_BY_FREQ: Record<RecurrenceFreq, number> = {
  DAILY: RRule.DAILY,
  MONTHLY: RRule.MONTHLY,
  WEEKLY: RRule.WEEKLY,
  YEARLY: RRule.YEARLY,
};

/**
 * Parse an RRULE string (without "RRULE:" prefix) into typed options.
 * Returns null if the string is unparseable or has an unsupported FREQ.
 */
export function parseRrule(rruleStr: string): RecurrenceOptions | null {
  try {
    const parsed = RRule.parseString(rruleStr);
    const freq = parsed.freq !== undefined ? FREQ_BY_CONST[parsed.freq] : undefined;
    if (!freq) return null;

    const options: RecurrenceOptions = {
      freq,
      interval: parsed.interval ?? 1,
    };

    if (parsed.byweekday) {
      const days = Array.isArray(parsed.byweekday) ? parsed.byweekday : [parsed.byweekday];
      const numeric = days
        .map((d): number =>
          typeof d === "number" ? d : typeof d === "object" && "weekday" in d ? d.weekday : -1
        )
        .filter((n): n is RecurrenceWeekday => n >= 0 && n <= 6);
      if (numeric.length > 0) options.byweekday = numeric;
    }

    if (parsed.count != null) options.count = parsed.count;
    if (parsed.until) {
      // rrule UNTIL is a Date in UTC — reduce to YYYY-MM-DD.
      const d = parsed.until;
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      options.until = `${y}-${m}-${day}`;
    }

    return options;
  } catch {
    return null;
  }
}

/**
 * Build an RRULE string from typed options. Never emits DTSTART — the anchor
 * is stored on the page separately. Strips the "RRULE:" prefix so the result
 * matches the data-model convention.
 */
export function buildRrule(options: RecurrenceOptions): string {
  const rruleOpts: ConstructorParameters<typeof RRule>[0] = {
    freq: CONST_BY_FREQ[options.freq],
    interval: Math.max(1, Math.floor(options.interval)),
  };

  if (options.byweekday && options.byweekday.length > 0) {
    rruleOpts.byweekday = [...options.byweekday];
  }

  if (options.count != null) {
    rruleOpts.count = options.count;
  } else if (options.until) {
    // UNTIL is interpreted as end-of-day UTC so the final occurrence on that
    // local date is included.
    const [y, m, d] = options.until.split("-").map(Number);
    if (y && m && d) rruleOpts.until = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  }

  const rrule = new RRule(rruleOpts);
  return rrule.toString().replace(/^RRULE:/, "");
}
