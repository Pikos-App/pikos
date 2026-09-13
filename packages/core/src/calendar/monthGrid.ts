// Pure month-grid math: the padded weeks × 7 cell grid, and the per-cell
// event placement (ordering + "+K more" capping) the month view renders.
//
// MULTI-DAY REPRESENTATION (v1 decision): a multi-day event renders as a chip
// in EVERY cell it covers, flagged with `continuesBefore`/`continuesAfter` so
// the component can cut the corresponding corner radius. It is deliberately
// NOT a single bar spanning cells the way `assignStableAllDayRows` +
// `buildAllDayBars` lay out the week grid's all-day strip: those produce a
// shared ROW index across the whole visible range, which only pays off with
// absolute positioning inside one continuous strip. A month cell instead caps
// its own list at N and owns its own "+K more" count, so a shared row index
// would have to be reconciled against every cell's independent cap (a bar on
// row 4 is above the fold in one cell and below it in the next). Per-cell
// chips keep both the math and the DOM simple; spanning bars stay open as a
// follow-up once the cap rule is settled.

import { addDays, isSameDay, startOfDay, startOfWeek } from "date-fns";

import type { PageSummary } from "../types";
import { dateKey, formatDateOnly, isAllDayIso, parseLocalISO } from "../utils/dates";

/**
 * Which shape the calendar panel renders. Persisted separately from
 * `CalendarDayCount` so an existing stored day count keeps its meaning — the
 * time grid remembers "5 days" while the user is off in month view.
 */
export type CalendarViewMode = "time" | "month";

/** Default number of event chips a month cell shows before it collapses the rest. */
export const MONTH_CELL_MAX_EVENTS = 3;

/** One day cell of the month grid. */
export interface MonthCell {
  /** Local midnight of the cell's day. */
  date: Date;
  /** 'YYYY-MM-DD' — stable React key and the comparison key for placement. */
  key: string;
  /** False for the leading/trailing padding days borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
}

/**
 * Builds the visible month as full weeks: the month's first day is padded back
 * to the start of its week and the last day forward to the end of its week, so
 * every row has exactly 7 cells (5 or 6 rows, 42 cells at most).
 *
 * `weekStartsOn` comes from the app's week-start preference (AppSettings), the
 * same source `buildCalendarDays` and `MiniCalendar` take — month view must not
 * invent its own convention.
 *
 * Day stepping goes through date-fns `addDays`, which is calendar-day (not
 * 24h) arithmetic, so a DST-transition week still yields exactly 7 cells.
 */
export function buildMonthGrid(
  reference: Date,
  weekStartsOn: 0 | 1 = 1,
  today: Date = new Date()
): MonthCell[][] {
  const monthIndex = reference.getMonth();
  const year = reference.getFullYear();
  const firstOfMonth = new Date(year, monthIndex, 1);
  const lastOfMonth = new Date(year, monthIndex + 1, 0);
  const gridStart = startOfWeek(firstOfMonth, { weekStartsOn });

  const weeks: MonthCell[][] = [];
  let cursor = gridStart;
  // Keep emitting whole weeks until one covers the month's last day. The
  // condition is checked per WEEK (not per day) so the grid never ends mid-row.
  do {
    const week: MonthCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = startOfDay(addDays(cursor, i));
      week.push({
        date,
        inMonth: date.getMonth() === monthIndex && date.getFullYear() === year,
        isToday: isSameDay(date, today),
        key: formatDateOnly(date),
      });
    }
    weeks.push(week);
    cursor = addDays(cursor, 7);
  } while (cursor <= lastOfMonth);

  return weeks;
}

/**
 * Flattens the grid to the Date[] the recurrence expansion needs. The padded
 * grid spans up to 42 days, so expansion must cover the whole thing — a
 * month's worth of range would leave the padding rows empty of occurrences.
 */
export function monthGridDays(weeks: MonthCell[][]): Date[] {
  return weeks.flatMap((week) => week.map((cell) => cell.date));
}

/** One event chip inside a month cell. */
export interface MonthCellEvent {
  page: PageSummary;
  /** True for a date-only (all-day) schedule. Timed events carry a start time. */
  isAllDay: boolean;
  /** Number of calendar days the event covers (1 for a single-day event). */
  spanDays: number;
  /** True when the event started before this cell's day. */
  continuesBefore: boolean;
  /** True when the event continues past this cell's day. */
  continuesAfter: boolean;
  /** Local Date of the event's start (local midnight for an all-day schedule). */
  startDate: Date;
  /** Stable React key, unique within the cell (page id + this cell's day). */
  key: string;
}

/** A month cell's capped chip list plus what got collapsed. */
export interface MonthCellPlacement {
  /** Chips to render, already ordered. At most `maxVisible` entries. */
  visible: MonthCellEvent[];
  /** How many events the cap hid — 0 when everything fits. */
  overflowCount: number;
  /** The hidden events, in the same order, for a "+K more" listing. */
  overflow: MonthCellEvent[];
}

/** The day range an event covers, as inclusive 'YYYY-MM-DD' keys. */
function eventDayRange(
  scheduledStart: string,
  scheduledEnd: string | null | undefined
): { start: string; end: string } {
  const startKey = dateKey(scheduledStart);
  const rawEnd = scheduledEnd;
  if (rawEnd == null) return { end: startKey, start: startKey };
  const endKey = dateKey(rawEnd);
  // A timed event ending exactly at midnight touches the next day without
  // occupying it (the week grid's `crossingMidnightsCount` draws the same
  // line), so it stays on its start day.
  if (!isAllDayIso(rawEnd) && rawEnd.endsWith("T00:00:00") && endKey > startKey) {
    // endKey > startKey, so stepping back one day cannot land before the start.
    return { end: formatDateOnly(addDays(parseLocalISO(rawEnd), -1)), start: startKey };
  }
  return { end: endKey < startKey ? startKey : endKey, start: startKey };
}

/** Whole days between two 'YYYY-MM-DD' keys, inclusive of both ends. */
function inclusiveDaySpan(startKey: string, endKey: string): number {
  let span = 1;
  let cursor = parseLocalISO(startKey);
  while (formatDateOnly(cursor) < endKey) {
    cursor = addDays(cursor, 1);
    span++;
  }
  return span;
}

/**
 * Orders and caps the events on one day of the month grid.
 *
 * Ordering mirrors the week grid's all-day strip so the two views read the
 * same way: spanning/all-day events first (longest span first — they're the
 * "banner" events), then single-day timed events by start time. Ties break on
 * `createdAt` then page id so the order is deterministic across renders (page
 * ids are UUIDs, hence not a meaningful sort on their own).
 *
 * Everything past `maxVisible` is returned in `overflow` for the "+K more"
 * affordance rather than dropped.
 */
export function placeMonthCellEvents(
  pages: PageSummary[],
  day: Date,
  maxVisible: number = MONTH_CELL_MAX_EVENTS
): MonthCellPlacement {
  const dayStr = formatDateOnly(day);
  const events: MonthCellEvent[] = [];

  for (const page of pages) {
    const scheduledStart = page.scheduledStart;
    if (scheduledStart == null) continue;
    const range = eventDayRange(scheduledStart, page.scheduledEnd);
    if (dayStr < range.start || dayStr > range.end) continue;
    events.push({
      continuesAfter: dayStr < range.end,
      continuesBefore: dayStr > range.start,
      isAllDay: isAllDayIso(scheduledStart),
      // Recurring virtual occurrences and moved synced overrides share the head
      // page's id, so the start stamp is what makes the key unique in a cell.
      key: `${page.id}:${scheduledStart}:${dayStr}`,
      page,
      spanDays: inclusiveDaySpan(range.start, range.end),
      startDate: parseLocalISO(scheduledStart),
    });
  }

  // Banner group: all-day schedules and any event covering more than one day.
  const isBanner = (e: MonthCellEvent) => e.isAllDay || e.spanDays > 1;
  events.sort((a, b) => {
    const bannerDelta = Number(isBanner(b)) - Number(isBanner(a));
    if (bannerDelta !== 0) return bannerDelta;
    if (isBanner(a) && isBanner(b) && a.spanDays !== b.spanDays) return b.spanDays - a.spanDays;
    return (
      a.startDate.getTime() - b.startDate.getTime() ||
      a.page.createdAt.localeCompare(b.page.createdAt) ||
      a.page.id.localeCompare(b.page.id)
    );
  });

  const cap = Math.max(maxVisible, 0);
  return {
    overflow: events.slice(cap),
    overflowCount: Math.max(events.length - cap, 0),
    visible: events.slice(0, cap),
  };
}
