import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";

import type { PageSummary } from "../types";
import { isAllDayIso } from "../utils/dates";
import { ALL_DAY_ROW_HEIGHT, ALL_DAY_TOP_PADDING } from "./calendarConstants";

/** Whether `scheduledStart` is date-only ('YYYY-MM-DD'). */
export function isAllDayPage(scheduledStart: string): boolean {
  return isAllDayIso(scheduledStart);
}

/** Midnights strictly between start and end: an event ending exactly at midnight touches but
 * doesn't cross, so it returns 0. Walks calendar days, so it is DST-safe. */
export function crossingMidnightsCount(start: Date, end: Date): number {
  if (end <= start) return 0;
  let count = 0;
  let cursor = addDays(startOfDay(start), 1);
  while (cursor < end) {
    count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

export interface AllDayItem {
  page: PageSummary;
  /** True on days after the event's first day. */
  isContinuationBefore: boolean;
  /** True on days before the event's last day. */
  isContinuationAfter: boolean;
}

/** A multi-day all-day event appears on every day in [scheduledStart, scheduledEnd]. Compares
 * date strings directly to avoid UTC/local midnight ambiguity. */
export function buildAllDayItems(pages: PageSummary[], day: Date): AllDayItem[] {
  const dayStr = format(day, "yyyy-MM-dd");
  const results: AllDayItem[] = [];
  for (const page of pages) {
    if (page.scheduledStart == null || !isAllDayPage(page.scheduledStart)) continue;
    const start = page.scheduledStart;
    const end = page.scheduledEnd && isAllDayPage(page.scheduledEnd) ? page.scheduledEnd : start;
    if (dayStr < start || dayStr > end) continue;
    results.push({
      isContinuationAfter: dayStr < end,
      isContinuationBefore: dayStr > start,
      page,
    });
  }
  return results;
}

/**
 * Assigns each page one row across the visible days, so a multi-day event sits on the same row
 * in every column it touches. Each slot is an AllDayItem or null (empty row), and every day has
 * the same slot count.
 *
 * Row claims track the specific day indices a page has items on, not a start..end range.
 * Recurring virtual occurrences share the head page's id, so an MWF series is non-contiguous;
 * claiming min..max would push unrelated single-day events on Tu/Th to row 1 under a phantom
 * empty row 0.
 */
export function assignAllDayRows(pages: PageSummary[], days: Date[]): (AllDayItem | null)[][] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  // Found once so each day scans only these, not every page held.
  const from = format(first, "yyyy-MM-dd");
  const to = format(last, "yyyy-MM-dd");
  const touching = pages.filter((page) => {
    const start = page.scheduledStart;
    if (start == null || !isAllDayPage(start)) return false;
    const end = page.scheduledEnd && isAllDayPage(page.scheduledEnd) ? page.scheduledEnd : start;
    return start <= to && end >= from;
  });
  const itemsByDay = days.map((d) => buildAllDayItems(touching, d));

  interface Span {
    pageId: string;
    /** May be non-contiguous for shared-id virtuals. */
    dayIndices: number[];
    /** A stable tiebreaker that means something to the user, unlike the UUID. */
    createdAt: string;
  }
  const spans: Span[] = [];
  const byPage = new Map<string, Span>();
  itemsByDay.forEach((dayItems, dayIdx) => {
    for (const item of dayItems) {
      const existing = byPage.get(item.page.id);
      if (existing) {
        existing.dayIndices.push(dayIdx);
      } else {
        const span: Span = {
          createdAt: item.page.createdAt,
          dayIndices: [dayIdx],
          pageId: item.page.id,
        };
        byPage.set(item.page.id, span);
        spans.push(span);
      }
    }
  });
  // Multi-day spans first, so long bars anchor the top rows and the single-day stack stays
  // contiguous below. Ties: earliest start, then createdAt, then pageId for determinism.
  spans.sort(
    (a, b) =>
      b.dayIndices.length - a.dayIndices.length ||
      a.dayIndices[0]! - b.dayIndices[0]! ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.pageId.localeCompare(b.pageId)
  );

  const usedByDay: Set<number>[] = days.map(() => new Set());
  const rowByPage = new Map<string, number>();
  for (const span of spans) {
    let row = 0;
    for (;;) {
      let free = true;
      for (const dayIdx of span.dayIndices) {
        if (usedByDay[dayIdx]!.has(row)) {
          free = false;
          break;
        }
      }
      if (free) break;
      row++;
    }
    rowByPage.set(span.pageId, row);
    for (const dayIdx of span.dayIndices) usedByDay[dayIdx]!.add(row);
  }

  let totalRows = 0;
  for (const s of usedByDay) {
    for (const r of s) totalRows = Math.max(totalRows, r + 1);
  }

  return itemsByDay.map((dayItems) => {
    const row: (AllDayItem | null)[] = new Array<AllDayItem | null>(totalRows).fill(null);
    for (const item of dayItems) {
      const r = rowByPage.get(item.page.id);
      if (r !== undefined) row[r] = item;
    }
    return row;
  });
}

/**
 * `assignAllDayRows` over the full span of every all-day page overlapping `visibleDays`, so a
 * multi-week event lands on the same row in every week. Returns slots for `visibleDays` only,
 * with trailing rows that are empty across them trimmed (an event anchoring row 3 in a prior
 * week would otherwise leave empty space).
 */
export function assignStableAllDayRows(
  pages: PageSummary[],
  visibleDays: Date[]
): (AllDayItem | null)[][] {
  if (visibleDays.length === 0) return [];
  const visibleStart = format(visibleDays[0]!, "yyyy-MM-dd");
  const visibleEnd = format(visibleDays[visibleDays.length - 1]!, "yyyy-MM-dd");

  let minStart = visibleStart;
  let maxEnd = visibleEnd;
  for (const page of pages) {
    const s = page.scheduledStart;
    if (s == null || !isAllDayPage(s)) continue;
    const e = page.scheduledEnd && isAllDayPage(page.scheduledEnd) ? page.scheduledEnd : s;
    if (e < visibleStart || s > visibleEnd) continue;
    if (s < minStart) minStart = s;
    if (e > maxEnd) maxEnd = e;
  }

  // Fast path: nothing extends past the visible range, so the local result is identical.
  if (minStart === visibleStart && maxEnd === visibleEnd) {
    return assignAllDayRows(pages, visibleDays);
  }

  const expandedDays: Date[] = [];
  const expansionEnd = parseISO(maxEnd);
  let cursor = parseISO(minStart);
  while (cursor <= expansionEnd) {
    expandedDays.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const expandedSlots = assignAllDayRows(pages, expandedDays);

  const firstVisibleIdx = expandedDays.findIndex((d) => format(d, "yyyy-MM-dd") === visibleStart);
  const visibleSlots = expandedSlots.slice(firstVisibleIdx, firstVisibleIdx + visibleDays.length);

  // Interior empty rows stay: they hold a multi-week event's anchor row in place.
  let maxUsedRow = -1;
  for (const row of visibleSlots) {
    for (let i = row.length - 1; i > maxUsedRow; i--) {
      if (row[i] !== null) {
        maxUsedRow = i;
        break;
      }
    }
  }
  return visibleSlots.map((row) => row.slice(0, maxUsedRow + 1));
}

/** Lowest row empty across columns [lo..hi]. Follows the first-free-row rule of
 * `assignAllDayRows`, so a drag-to-create ghost sits where the new chip lands. */
export function firstFreeRowInSpan(
  slotsByDay: (AllDayItem | null)[][],
  lo: number,
  hi: number
): number {
  let row = 0;
  while (true) {
    let free = true;
    for (let d = lo; d <= hi; d++) {
      if (slotsByDay[d]?.[row]) {
        free = false;
        break;
      }
    }
    if (free) return row;
    row++;
  }
}

/** One renderable bar per visible event segment. A non-contiguous recurring series (MWF sharing
 * a page id) is several bars, since the row has nulls at the gap columns. */
export interface AllDayBar {
  page: PageSummary;
  /** 0-indexed. */
  startCol: number;
  /** Consecutive visible columns covered (>= 1). */
  span: number;
  row: number;
  /** The event starts before the visible range. */
  continuesLeft: boolean;
  /** The event ends after the visible range. */
  continuesRight: boolean;
  /** Unique within a visible range. */
  key: string;
}

/** Collapses a row-assigned slot grid into one bar per visible event segment. */
export function buildAllDayBars(slotsByDay: (AllDayItem | null)[][]): AllDayBar[] {
  const dayCount = slotsByDay.length;
  if (dayCount === 0) return [];
  const rowCount = slotsByDay[0]?.length ?? 0;
  const bars: AllDayBar[] = [];
  for (let row = 0; row < rowCount; row++) {
    let col = 0;
    while (col < dayCount) {
      const slot = slotsByDay[col]?.[row] ?? null;
      if (slot === null) {
        col++;
        continue;
      }
      const startCol = col;
      const pageId = slot.page.id;
      let end = col + 1;
      // Extend only across a genuine multi-day segment: this day flags continuation-after and the
      // next is the same page's continuation-before. Recurring occurrences share the head's page
      // id but are single-day, so a gap-free daily series stays per-day bars instead of one
      // bar spanning the row.
      while (
        end < dayCount &&
        slotsByDay[end - 1]?.[row]?.isContinuationAfter === true &&
        slotsByDay[end]?.[row]?.page.id === pageId &&
        slotsByDay[end]?.[row]?.isContinuationBefore === true
      ) {
        end++;
      }
      const lastSlot = slotsByDay[end - 1]?.[row];
      bars.push({
        continuesLeft: slot.isContinuationBefore,
        continuesRight: lastSlot?.isContinuationAfter ?? false,
        key: `${pageId}:${row}:${startCol}`,
        page: slot.page,
        row,
        span: end - startCol,
        startCol,
      });
      col = end;
    }
  }
  return bars;
}

/** The end date that keeps a multi-day event's duration after a drag to `newStart`; `undefined`
 * when it has no all-day end or spans one day, so the chip stays single-day. */
export function shiftAllDayEnd(
  originalStart: string | null | undefined,
  originalEnd: string | null | undefined,
  newStart: Date
): string | undefined {
  if (!originalStart || !originalEnd) return undefined;
  if (!isAllDayPage(originalStart) || !isAllDayPage(originalEnd)) return undefined;
  const span = differenceInCalendarDays(parseISO(originalEnd), parseISO(originalStart));
  if (span <= 0) return undefined;
  return format(addDays(newStart, span), "yyyy-MM-dd");
}

/** The span between the fixed edge and the dragged edge; the roles flip when the dragged edge
 * crosses the anchor, so the range stays valid. */
export function computeAllDayEdgeResize(
  anchorDate: string,
  grabbedDate: string
): { start: string; end: string } {
  return grabbedDate < anchorDate
    ? { end: anchorDate, start: grabbedDate }
    : { end: grabbedDate, start: anchorDate };
}

/** A subset of React's `CSSProperties`, spelled out because core may not name a React type,
 * so a caller can spread it onto a `style` prop. */
export interface AllDayBarPosition {
  left: string;
  top: number;
  width: string;
}

/** Row geometry is a parameter because the strip zooms with the calendar; the constants are the
 * unzoomed defaults. */
export function barPositionStyle(
  bar: AllDayBar,
  columnCount: number,
  rows: { rowHeight?: number; topPadding?: number } = {}
): AllDayBarPosition {
  const rowHeight = rows.rowHeight ?? ALL_DAY_ROW_HEIGHT;
  const topPadding = rows.topPadding ?? ALL_DAY_TOP_PADDING;
  const widthPct = (bar.span / columnCount) * 100;
  const leftPct = (bar.startCol / columnCount) * 100;
  return {
    left: `${leftPct}%`,
    top: topPadding + bar.row * rowHeight,
    // Bars that continue off-view stay flush; the rest leave a gap at the day boundary.
    width: bar.continuesRight ? `${widthPct}%` : `calc(${widthPct}% - 2px)`,
  };
}
