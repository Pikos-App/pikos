// The in-process recurrence path (test mode, write-path helpers, labels). All recurrence math
// lives in the Rust engine (crates/pikos-recurrence), consumed through its WebAssembly build;
// the backend and CLI link the same crate natively. The engine speaks naive local wall-clock ISO
// strings, as the data model does (`dates.ts`). The calendar's production expansion batches over
// IPC instead.

import * as engine from "@pikos/recurrence-wasm";
import { addDays, differenceInCalendarDays } from "date-fns";

import type { PageRecurrenceRule, PageSchedule, PageSummary, RawOccurrence } from "../types";
import { dateKey, formatDateOnly, formatLocalISO, isTimedIso, parseLocalISO } from "./dates";

export interface VirtualOccurrence extends PageSummary {
  /** Not materialised in page_schedules. */
  isVirtual: true;
  /** The rule it was expanded from. */
  ruleId: string;
  /** The rrule's own date, used for skip and override. */
  originalDate: string;
}

interface EngineOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

/** Virtual occurrences within [rangeStart, rangeEnd). `existingSchedules` are this page's
 * materialised overrides; their originalDates are excluded. */
export function expandRecurrenceForRange(
  rule: PageRecurrenceRule,
  page: PageSummary,
  rangeStart: Date,
  rangeEnd: Date,
  existingSchedules: PageSchedule[] = []
): VirtualOccurrence[] {
  // Removed from expansion for native and synced series alike: EXDATEs, overridden dates, and the
  // completed and skipped sets. The head is suppressed separately in `useRecurrenceExpansion`.
  // Day-keyed because synced entries are full wall clock.
  const excludedDates = [
    ...rule.rruleExdates,
    ...existingSchedules
      .filter((s) => s.ruleId === rule.id && s.originalDate)
      .map((s) => s.originalDate!),
    ...(page.completedOccurrences ? Object.keys(page.completedOccurrences) : []),
    ...(page.skippedOccurrences ?? []),
  ].map(dateKey);

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
 * Mirrors the Rust `expand_range` command: every rule date in range minus rule-level EXDATEs,
 * without the completed and skip exclusions, which callers apply. The page only satisfies
 * `expandRecurrenceForRange`'s signature, so its exclusion sets are stripped. Answers
 * MockStorageAdapter's batched call as the Tauri backend does.
 */
export function rawExpandRule(
  rule: PageRecurrenceRule,
  page: PageSummary,
  rangeStart: Date,
  rangeEnd: Date
): RawOccurrence[] {
  const rawPage: PageSummary = { ...page, completedOccurrences: null, skippedOccurrences: null };
  const out: RawOccurrence[] = [];
  for (const o of expandRecurrenceForRange(rule, rawPage, rangeStart, rangeEnd, [])) {
    if (o.scheduledStart == null) continue;
    out.push({
      originalDate: o.originalDate,
      scheduledEnd: o.scheduledEnd ?? null,
      scheduledStart: o.scheduledStart,
    });
  }
  return out;
}

/**
 * The date a rendered occurrence stands for, or null for a plain page. A series head carries its
 * date in `scheduledStart` alone. A completion writes against this date, so it stays the original
 * date, not the day a moved instance landed on.
 */
export function occurrenceDateOf(page: PageSummary): string | null {
  return "originalDate" in page ? (page as VirtualOccurrence).originalDate : null;
}

/**
 * Realigns a single-BYDAY weekly rule's weekday to a moved anchor. A weekly rule pins its weekday
 * in BYDAY, so without this a head moved Monday to Wednesday keeps `BYDAY=MO` and completion snaps
 * it back. Multi-day rules are left alone, since dragging one occurrence off the set is
 * ambiguous; non-weekly and already-aligned rules come back unchanged. `rruleStr` has no
 * "RRULE:" prefix.
 */
export function alignWeeklyRuleToAnchor(rruleStr: string, anchorStart: string): string {
  return engine.alignWeeklyRuleToAnchor(rruleStr, anchorStart);
}

/** The next occurrence strictly after `afterDate`, anchored at the rule's scheduledStart; null
 * when none remain (UNTIL passed). `rruleStr` has no "RRULE:" prefix. */
export function nextOccurrenceAfter(
  rruleStr: string,
  scheduledStart: string,
  afterDate: Date,
  /** Pass `rule.rruleExdates`; without it the head can advance onto a date the user already took
   *  out of the series. */
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
 * The occurrence a recurring head sits on: the oldest one the rule yields that isn't excluded
 * and isn't before `floor` (a synced series' connect day; null for native). Null when the series
 * is exhausted or out of envelope. `exclusions` is completed, skipped, EXDATEs and overrides,
 * matched on the day alone.
 *
 * The same engine function as `recompute_recurring_schedule` (recurrence_derive.rs), so a head
 * derived in test mode carries the start and end the writer derives.
 */
export function oldestOpenOccurrence(
  rruleStr: string,
  scheduledStart: string,
  scheduledEnd: string | null,
  exclusions: readonly string[],
  floor: string | null
): RawOccurrence | null {
  const occ = engine.oldestOpenOccurrence(
    rruleStr,
    scheduledStart,
    scheduledEnd ?? undefined,
    JSON.stringify(exclusions),
    floor ?? undefined
  );
  return occ === undefined ? null : (JSON.parse(occ) as RawOccurrence);
}

/**
 * Snaps an anchor to the first occurrence the rule permits, on or after it, keeping its
 * wall-clock time. A head left on a date the rule excludes would render a stray first run
 * detached from the virtual occurrences. The anchor comes back unchanged when it already
 * satisfies the rule, the rule is exhausted, or the rrule can't be parsed.
 */
export function snapAnchorToRule(rruleStr: string, anchor: string): string {
  return engine.snapAnchorToRule(rruleStr, anchor);
}

/**
 * Snaps `start` onto the rule and carries `end` the same whole-day distance, so the user's span
 * survives. {@link computeNextEnd} puts the end's time on the start's date, which would collapse
 * "Mon to Wed" to a single day here; with no shift the end can precede the snapped start.
 *
 * Twin of `pikos_recurrence::snap_schedule_to_rule`; both answer to
 * `tests/fixtures/schedule-snap.json`.
 */
export function snapScheduleToRule(
  rruleStr: string,
  start: string,
  end?: string
): { start: string; end: string | undefined } {
  const snapped = snapAnchorToRule(rruleStr, start);
  if (end === undefined || snapped === start) return { end, start: snapped };
  const days = differenceInCalendarDays(parseLocalISO(snapped), parseLocalISO(start));
  const shifted = addDays(parseLocalISO(end), days);
  return {
    end: isTimedIso(end) ? formatLocalISO(shifted) : formatDateOnly(shifted),
    start: snapped,
  };
}

/** YYYY-MM-DD for every occurrence strictly between `after` and `before`, skipping `exdates`: the
 * missed days since a recurring page's previous anchor. The engine caps the scan at 500
 * occurrences to bound pathological inputs. */
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

/** The base end's time of day on `nextStart`'s date, rolling to the next day when that would land
 * at or before the start; null for an all-day base. A head's end is derived by
 * {@link oldestOpenOccurrence}, which carries the span's length instead. */
export function computeNextEnd(baseEnd: string, nextStart: string): string | null {
  return engine.computeNextEnd(baseEnd, nextStart) ?? null;
}

/** The first `limit` occurrences of a rule anchored at `dtstart`, as local ISO datetimes. */
export function listOccurrences(rruleStr: string, dtstart: string, limit: number): string[] {
  return JSON.parse(engine.listOccurrences(rruleStr, dtstart, limit)) as string[];
}

/** An RRULE as a human label ("every week on Monday"), or the raw string when it can't be
 * phrased. Phrasing decisions live on the engine's `rrule_to_label`. */
export function rruleToLabel(rruleStr: string): string {
  return engine.rruleToLabel(rruleStr) ?? rruleStr;
}

/**
 * Compact label for tight bylines: "Weekly", "Every 2 weeks", "Weekly × 10", "Weekly thru Jun 28".
 * BYDAY is dropped because the date chip beside it already shows the anchor weekday.
 */
export function rruleToShortLabel(rruleStr: string): string {
  return engine.rruleToShortLabel(rruleStr);
}

// The data model stores RRULE without DTSTART; the anchor lives on the page.

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** rrule.js convention: 0 = Monday ... 6 = Sunday. */
export type RecurrenceWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The editor's typed view of an RRULE, and a lossless carrier for every pattern term the engine
 * enumerates, including ones the editor never authors: a term parsed but not rebuilt can only be
 * degraded, which `rruleEditWouldDegrade` locks the whole rule out for.
 */
export interface RecurrenceOptions {
  freq: RecurrenceFreq;
  /** Positive integer, default 1. */
  interval: number;
  /** For FREQ=WEEKLY. */
  byweekday?: RecurrenceWeekday[];
  /** BYDAY ordinals ("first Monday" = 1, "last Friday" = -1) aligned with `byweekday`, null per
   *  bare weekday. Present only when the rule carried one, so anything rewriting `byweekday`
   *  must drop it. */
  byweekdayOrdinals?: (number | null)[];
  /** BYSETPOS, e.g. -1 for "last". */
  bysetpos?: number[];
  /** BYMONTHDAY: 1-31, or negative from month end. */
  bymonthday?: number[];
  /** BYMONTH: 1-12. */
  bymonth?: number[];
  /** Changes weekly grouping. */
  wkst?: RecurrenceWeekday;
  /** Exactly one of `count` or `until` may be set. */
  count?: number;
  /** YYYY-MM-DD. */
  until?: string;
}

/** Null when the string is unparseable or its FREQ is unsupported. `rruleStr` has no "RRULE:" prefix. */
export function parseRrule(rruleStr: string): RecurrenceOptions | null {
  const parsed = engine.parseRruleOptions(rruleStr);
  if (parsed === undefined) return null;
  return JSON.parse(parsed) as RecurrenceOptions;
}

/** Never emits DTSTART. UNTIL means end of day, so the final occurrence on that date is included. */
export function buildRrule(options: RecurrenceOptions): string {
  const normalized: RecurrenceOptions = {
    ...options,
    interval: Math.max(1, Math.floor(options.interval)),
    ...(options.count != null && { count: Math.max(1, Math.floor(options.count)) }),
  };
  // The engine rejects only malformed JSON, which typed options can't produce; the fallback satisfies the types.
  return engine.buildRrule(JSON.stringify(normalized)) ?? "";
}

// Defaults are seeded so an explicit `INTERVAL=1` or `WKST=MO` equals a rebuilt string that omits them.
function ruleTerms(rruleStr: string): Map<string, string> {
  const terms = new Map([
    ["INTERVAL", "1"],
    ["WKST", "MO"],
  ]);
  for (const part of rruleStr.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) continue;
    const term = key.trim().toUpperCase();
    terms.set(term, term === "UNTIL" ? normalizedUntil(value) : normalizedList(value));
  }
  return terms;
}

// The carrier drops the RFC's optional `+` on an ordinal (`BYMONTHDAY=+15`), so a rule spelling it round-trips losslessly and must not read as lossy.
function normalizedList(value: string): string {
  return value
    .split(",")
    .map((token) => token.trim().toUpperCase().replace(/^\+/, ""))
    .sort()
    .join(",");
}

/**
 * A UNTIL token reduced to the only form the editor rebuilds: floating end of day. Two inputs
 * collapse to it losslessly: a `Z` is syntactic (the engine reads every instant as wall clock),
 * and a date-only UNTIL pairs with an all-day DTSTART whose final occurrence sits at midnight.
 * Any other time of day is the provider's own cut-off, and end of day would gain the occurrence
 * it excluded.
 */
function normalizedUntil(value: string): string {
  const stamp = value.trim().toUpperCase().replace(/Z$/, "");
  return stamp.includes("T") ? stamp : `${stamp}T235959`;
}

/**
 * True when saving the rule back through the editor would change its occurrence set. The tail
 * outside `RecurrenceOptions` (BYWEEKNO, BYYEARDAY, BYHOUR) and unparseable rules qualify. The
 * lock is derived from the round-trip, not a list of lossy terms, which is only as complete as
 * the last person to spot a gap and missed BYMONTH. The end condition is compared against
 * `normalizedUntil`, since an approved edit rewrites a timed UNTIL to end of day.
 */
export function rruleEditWouldDegrade(rruleStr: string): boolean {
  const options = parseRrule(rruleStr);
  if (!options) return true;
  const before = ruleTerms(rruleStr);
  const after = ruleTerms(buildRrule(options));
  if (before.size !== after.size) return true;
  return [...before].some(([term, value]) => after.get(term) !== value);
}

/**
 * Re-keys options to a new frequency, keeping interval and the end condition and only the BY*
 * terms that frequency can carry. The editor authors freq, interval and byweekday only, but
 * `parseRrule` surfaces a synced rule's full shape; without the whitelist a freq change would
 * leak `BYMONTHDAY=15` onto a WEEKLY rule, which the engine rejects, or an ordinal onto a
 * frequency where it means nothing.
 */
export function optionsForFreq(
  options: RecurrenceOptions,
  freq: RecurrenceFreq
): RecurrenceOptions {
  const next: RecurrenceOptions = { freq, interval: options.interval };
  if (options.count != null) next.count = options.count;
  else if (options.until) next.until = options.until;
  if (freq === "WEEKLY") {
    if (options.byweekday) next.byweekday = options.byweekday;
    if (options.wkst != null) next.wkst = options.wkst;
  } else if (freq === "MONTHLY") {
    if (options.bymonthday) next.bymonthday = options.bymonthday;
  }
  return next;
}

/** Replaces the end condition and leaves the cadence alone. Hand-rebuilding from
 * freq/interval/byweekday would drop the `bymonthday`, `bysetpos` and `wkst` a synced rule
 * carries. */
export function optionsWithEnd(
  options: RecurrenceOptions,
  end: { count: number } | { until: string } | null
): RecurrenceOptions {
  const next: RecurrenceOptions = { ...options };
  delete next.count;
  delete next.until;
  if (end && "count" in end) next.count = end.count;
  else if (end) next.until = end.until;
  return next;
}
