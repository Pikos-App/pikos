// ─── Recurrence expansion ─────────────────────────────────────────────────
//
// Expands a PageRecurrenceRule into virtual calendar occurrences for a given
// date range. Virtual occurrences are PageSummary-shaped objects that the
// calendar can render alongside real page_schedules rows.
//
// Key design points:
// - All recurrence math lives in the Rust engine (crates/pikos-recurrence),
//   consumed here through its WebAssembly build (@pikos/recurrence-wasm).
//   The Rust backend/CLI link the same crate natively, so every platform
//   shares one implementation.
// - The engine speaks naive local wall-clock ISO strings end to end — the
//   same convention as the data model (see utils/dates.ts) — so no timezone
//   gymnastics happen on either side of the boundary.
// - Excluded dates (rruleExdates) and overridden dates (materialised
//   page_schedules rows with ruleId set) are filtered out
// - Each virtual occurrence carries the source page's metadata + computed
//   scheduledStart/scheduledEnd for that specific occurrence

import * as engine from "@pikos/recurrence-wasm";
import { format } from "date-fns";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import { formatLocalISO, parseLocalISO } from "./dates";

export interface VirtualOccurrence extends PageSummary {
  /** True for virtual rrule-expanded occurrences (not materialised in page_schedules). */
  isVirtual: true;
  /** The recurrence rule ID this occurrence was expanded from. */
  ruleId: string;
  /** The original rrule occurrence date (YYYY-MM-DD) — used for skip/override. */
  originalDate: string;
}

/** Engine wire shape for one expanded occurrence. */
interface EngineOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

/**
 * Expands a recurrence rule into virtual occurrences within [rangeStart, rangeEnd).
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
  const excludedDates = [
    ...rule.rruleExdates,
    ...existingSchedules
      .filter((s) => s.ruleId === rule.id && s.originalDate)
      .map((s) => s.originalDate!),
  ];

  const occurrences = JSON.parse(
    engine.expandRange(
      rule.rrule,
      rule.scheduledStart,
      rule.scheduledEnd ?? undefined,
      formatLocalISO(rangeStart),
      formatLocalISO(rangeEnd),
      JSON.stringify(excludedDates)
    )
  ) as EngineOccurrence[];

  return occurrences.map((occ) => ({
    ...page,
    isVirtual: true,
    originalDate: occ.originalDate,
    ruleId: rule.id,
    scheduledEnd: occ.scheduledEnd,
    scheduledStart: occ.scheduledStart,
  }));
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
  return engine.alignWeeklyRuleToAnchor(rruleStr, anchorStart);
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
  const next = engine.nextOccurrenceAfter(
    rruleStr,
    scheduledStart,
    formatLocalISO(afterDate),
    JSON.stringify(exdates)
  );
  return next === undefined ? null : { scheduledEnd: null, scheduledStart: next };
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
  return engine.snapAnchorToRule(rruleStr, anchor);
}

/**
 * Returns YYYY-MM-DD strings for every rrule occurrence strictly after `after`
 * and strictly before `before`, skipping any in `exdates`. Used to compute the
 * "gap" of missed days between a recurring page's previous anchor and today.
 *
 * The engine caps the scan (500 occurrences) to bound pathological inputs
 * (e.g. a multi-year gap on FREQ=DAILY with an exdate-heavy rule).
 */
export function missedOccurrencesBetween(
  rruleStr: string,
  scheduledStart: string,
  after: Date,
  before: Date,
  exdates: readonly string[] = []
): string[] {
  return JSON.parse(
    engine.missedOccurrencesBetween(
      rruleStr,
      scheduledStart,
      formatLocalISO(after),
      formatLocalISO(before),
      JSON.stringify(exdates)
    )
  ) as string[];
}

/**
 * Computes the next occurrence's scheduledEnd given a base rule with start+end times.
 * Preserves the original duration by applying the base end's time to the new date.
 */
export function computeNextEnd(baseEnd: string, nextStart: string): string | null {
  return engine.computeNextEnd(baseEnd, nextStart) ?? null;
}

/**
 * Lists the first `limit` occurrences of a rule anchored at `dtstart`
 * (Pikos ISO string), as local ISO datetimes. Used for finite-recurrence
 * expansion in the NL parser and by test helpers.
 */
export function listOccurrences(rruleStr: string, dtstart: string, limit: number): string[] {
  return JSON.parse(engine.listOccurrences(rruleStr, dtstart, limit)) as string[];
}

/**
 * Converts an RRULE string (e.g. "FREQ=WEEKLY;BYDAY=MO") to a human-readable
 * label (e.g. "every week on Monday"). Falls back to the raw string on error.
 */
export function rruleToLabel(rruleStr: string): string {
  return engine.rruleToLabel(rruleStr) ?? rruleStr;
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
 * Weekday index using the rrule convention: 0 = Monday … 6 = Sunday.
 * Used by `byweekday` on weekly rules.
 */
export type RecurrenceWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface RecurrenceOptions {
  freq: RecurrenceFreq;
  /** Positive integer ≥ 1. Default 1. */
  interval: number;
  /** Weekdays for FREQ=WEEKLY (0=Monday … 6=Sunday). */
  byweekday?: RecurrenceWeekday[];
  /** End condition — exactly one of `count` or `until` may be set. */
  count?: number;
  /** End condition as YYYY-MM-DD (date-only). */
  until?: string;
}

/**
 * Parse an RRULE string (without "RRULE:" prefix) into typed options.
 * Returns null if the string is unparseable or has an unsupported FREQ.
 */
export function parseRrule(rruleStr: string): RecurrenceOptions | null {
  const parsed = engine.parseRruleOptions(rruleStr);
  if (parsed === undefined) return null;
  return JSON.parse(parsed) as RecurrenceOptions;
}

/**
 * Build an RRULE string from typed options. Never emits DTSTART — the anchor
 * is stored on the page separately. UNTIL is interpreted as end-of-day so the
 * final occurrence on that local date is included.
 */
export function buildRrule(options: RecurrenceOptions): string {
  const normalized: RecurrenceOptions = {
    ...options,
    interval: Math.max(1, Math.floor(options.interval)),
    ...(options.count != null && { count: Math.max(1, Math.floor(options.count)) }),
  };
  // The engine only rejects malformed JSON, which a typed options object
  // can't produce — the fallback exists to satisfy the type system.
  return engine.buildRrule(JSON.stringify(normalized)) ?? "";
}
