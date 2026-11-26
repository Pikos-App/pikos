import { addDays, isSameDay, startOfDay, startOfWeek } from "date-fns";

import type { PageSummary } from "../types";
import { dateKey, formatDateOnly, isAllDayIso, parseLocalISO } from "../utils/dates";
import { viewerEnd, viewerStart } from "../utils/syncedTime";

/** Persisted separately from `CalendarDayCount`, so the time grid remembers "5 days" while the
 * user is in month view. */
export type CalendarViewMode = "time" | "month";

/** Chips a month cell shows before it collapses the rest. */
export const MONTH_CELL_MAX_EVENTS = 3;

export interface MonthCell {
  /** Local midnight of the cell's day. */
  date: Date;
  /** 'YYYY-MM-DD'. */
  key: string;
  /** False for padding days borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
}

/**
 * The visible month as full weeks, padded to the week edges, so every row has 7 cells (5 or 6
 * rows). Steps with `addDays`, which is calendar-day arithmetic, so a DST week still has 7 cells.
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
  // Checked per week, not per day, so the grid never ends mid-row.
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

/** The days recurrence expansion needs. The padded grid spans up to 42 days, so expanding only
 * the month would leave the padding rows empty of occurrences. */
export function monthGridDays(weeks: MonthCell[][]): Date[] {
  return weeks.flatMap((week) => week.map((cell) => cell.date));
}

export interface MonthCellEvent {
  page: PageSummary;
  /** A date-only schedule. */
  isAllDay: boolean;
  /** Calendar days the event covers. */
  spanDays: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Local midnight for an all-day schedule. */
  startDate: Date;
  /** Unique within the cell. */
  key: string;
}

export interface MonthCellPlacement {
  /** Ordered, at most `maxVisible`. */
  visible: MonthCellEvent[];
  overflowCount: number;
  /** The hidden events, for a "+K more" listing. */
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
  // A timed event ending exactly at midnight touches the next day without occupying it, as in
  // the week grid's `crossingMidnightsCount`.
  if (!isAllDayIso(rawEnd) && rawEnd.endsWith("T00:00:00") && endKey > startKey) {
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
 * Orders and caps the events on one day, in the week grid's all-day strip order: banners
 * (all-day or multi-day, longest first), then single-day timed events by start. Events past
 * `maxVisible` go to `overflow` for "+K more".
 */
export function placeMonthCellEvents(
  pages: PageSummary[],
  day: Date,
  maxVisible: number = MONTH_CELL_MAX_EVENTS
): MonthCellPlacement {
  const dayStr = formatDateOnly(day);
  const events: MonthCellEvent[] = [];

  for (const page of pages) {
    // The viewer's day decides the cell: a synced event's stored wall clock is the source
    // calendar's, and a Tokyo morning falls on the day before in California.
    const scheduledStart = viewerStart(page);
    if (scheduledStart == null) continue;
    const range = eventDayRange(scheduledStart, viewerEnd(page));
    if (dayStr < range.start || dayStr > range.end) continue;
    events.push({
      continuesAfter: dayStr < range.end,
      continuesBefore: dayStr > range.start,
      isAllDay: isAllDayIso(scheduledStart),
      // Recurring occurrences and moved synced overrides share the head's id, so the start stamp
      // makes the key unique. It stays the stored one: the key is an identity, not a position.
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

/** Banners (all-day or multi-day) first, ties on createdAt then id for a stable order across renders. */
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

/** An event's run of days inside one week row, drawn as one bar. */
export interface MonthWeekBar {
  /** The first cell's event, with `continuesAfter` taken from the last cell. */
  event: MonthCellEvent;
  /** Shared by every cell the bar covers. */
  lane: number;
  spanCols: number;
}

export interface MonthWeekCell {
  /** Lane by lane, down to the lowest visible lane anything covers in this cell: the bar
   * that starts here, or null for a lane left empty or crossed by an earlier cell's bar. */
  lanes: (MonthWeekBar | null)[];
  /** Events covering this cell on a lane past the cap. */
  overflowCount: number;
}

/**
 * Lays out one week row so a multi-day event is one bar. Lanes are shared across the row, so the
 * cap applies per lane: a bar is shown in every cell it covers or hidden and counted in each
 * one's "+K more", where a per-cell cap would show it in one cell and hide it in the next.
 * Events take the lowest lane free across their days, in `compareMonthEvents` order.
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
