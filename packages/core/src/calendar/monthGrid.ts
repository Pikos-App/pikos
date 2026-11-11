// Pure month-grid math: the padded weeks × 7 cell grid, and the event placement
// (ordering, lanes, "+K more" capping) the month view renders.

import { addDays, isSameDay, startOfDay, startOfWeek } from "date-fns";

import type { PageSummary } from "../types";
import { dateKey, formatDateOnly, isAllDayIso, parseLocalISO } from "../utils/dates";
import { viewerEnd, viewerStart } from "../utils/syncedTime";

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
    // Which cell a synced event belongs in is the viewer's question: its stored
    // wall-clock is the source calendar's, and a Tokyo morning falls on the day
    // before for a viewer in California. The week grid resolves the same way in
    // `calendarLayout`.
    const scheduledStart = viewerStart(page);
    if (scheduledStart == null) continue;
    const range = eventDayRange(scheduledStart, viewerEnd(page));
    if (dayStr < range.start || dayStr > range.end) continue;
    events.push({
      continuesAfter: dayStr < range.end,
      continuesBefore: dayStr > range.start,
      isAllDay: isAllDayIso(scheduledStart),
      // Recurring virtual occurrences and moved synced overrides share the head
      // page's id, so the start stamp is what makes the key unique in a cell. It
      // stays the stored one: the key is an identity, not a position.
      key: `${page.id}:${page.scheduledStart}:${dayStr}`,
      page,
      spanDays: inclusiveDaySpan(range.start, range.end),
      startDate: parseLocalISO(scheduledStart),
    });
  }

  events.sort(compareMonthEvents);

  const cap = Math.max(maxVisible, 0);
  return {
    overflow: events.slice(cap),
    overflowCount: Math.max(events.length - cap, 0),
    visible: events.slice(0, cap),
  };
}

/** Banner group first: all-day schedules and any event covering more than one day. */
function compareMonthEvents(a: MonthCellEvent, b: MonthCellEvent): number {
  const isBanner = (e: MonthCellEvent) => e.isAllDay || e.spanDays > 1;
  const bannerDelta = Number(isBanner(b)) - Number(isBanner(a));
  if (bannerDelta !== 0) return bannerDelta;

  if (isBanner(a) && isBanner(b) && a.spanDays !== b.spanDays) return b.spanDays - a.spanDays;

  return (
    a.startDate.getTime() - b.startDate.getTime() ||
    a.page.createdAt.localeCompare(b.page.createdAt) ||
    a.page.id.localeCompare(b.page.id)
  );
}

/** An event's run of days inside one week row, drawn as one bar from its first cell. */
export interface MonthWeekBar {
  /** The run's first cell's event, with `continuesAfter` taken from its last cell. */
  event: MonthCellEvent;
  /** Row inside the week, shared by every cell the bar covers. */
  lane: number;
  /** Cells the bar covers, counting its first. */
  spanCols: number;
}

/** One cell of a week row as `placeMonthWeek` lays it out. */
export interface MonthWeekCell {
  /** Lane by lane, down to the lowest visible lane anything covers in this cell: the bar
   * that starts here, or null for a lane left empty or crossed by an earlier cell's bar. */
  lanes: (MonthWeekBar | null)[];
  /** Events covering this cell on a lane past the cap. */
  overflowCount: number;
}

/**
 * Lays out one week row of the month grid so a multi-day event is one bar.
 *
 * Lanes are shared across the row, the way the week grid's all-day strip shares
 * rows, so the cap applies per lane rather than per cell: a bar is either shown in
 * every cell it covers or hidden and counted in each one's "+K more". A per-cell cap
 * would show a bar in one cell and hide it in the next.
 *
 * Events take the lowest lane free across their days, in `compareMonthEvents`
 * order, so banners settle first and single-day events fill the gaps they leave.
 */
export function placeMonthWeek(
  pages: PageSummary[],
  days: Date[],
  maxVisible: number = MONTH_CELL_MAX_EVENTS
): MonthWeekCell[] {
  const runs = new Map<string, { bar: MonthWeekBar; firstCol: number; lastCol: number }>();
  days.forEach((day, col) => {
    for (const event of placeMonthCellEvents(pages, day, Infinity).visible) {
      const identity = `${event.page.id}:${event.page.scheduledStart}`;
      const run = runs.get(identity);
      if (run) {
        run.lastCol = col;
        run.bar.spanCols++;
        run.bar.event = { ...run.bar.event, continuesAfter: event.continuesAfter };
      } else {
        runs.set(identity, { bar: { event, lane: 0, spanCols: 1 }, firstCol: col, lastCol: col });
      }
    }
  });

  const taken: boolean[][] = days.map(() => []);
  const ordered = [...runs.values()].sort((a, b) => compareMonthEvents(a.bar.event, b.bar.event));
  for (const run of ordered) {
    const cols = taken.slice(run.firstCol, run.lastCol + 1);
    let lane = 0;
    while (cols.some((lanes) => lanes[lane])) lane++;

    run.bar.lane = lane;
    for (const lanes of cols) lanes[lane] = true;
  }

  const cap = Math.max(maxVisible, 0);
  return days.map((_, col) => {
    const visibleDepth = Math.min(taken[col]!.length, cap);
    const lanes: (MonthWeekBar | null)[] = Array.from({ length: visibleDepth }, () => null);
    for (const run of ordered) {
      const startsHere = run.firstCol === col && run.bar.lane < cap;
      if (startsHere) lanes[run.bar.lane] = run.bar;
    }

    const overflowCount = taken[col]!.slice(cap).filter(Boolean).length;
    return { lanes, overflowCount };
  });
}
