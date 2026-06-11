import type { PageSummary } from "@pikos/core";
import { isAllDayIso } from "@pikos/core";
import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import type { CSSProperties } from "react";

import { ALL_DAY_ROW_HEIGHT, ALL_DAY_TOP_PADDING } from "./calendarConstants";

/**
 * Returns true when scheduledStart is a date-only string ('YYYY-MM-DD').
 * Timed events include 'T' in the ISO string; all-day events are 10 chars with no 'T'.
 */
export function isAllDayPage(scheduledStart: string): boolean {
  return isAllDayIso(scheduledStart);
}

/**
 * Counts midnight boundaries strictly between start and end. An event ending
 * exactly at midnight (e.g. 11pm → next day 00:00) returns 0 — it touches but
 * doesn't cross. DST-safe: walks one calendar day at a time.
 */
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
  /** True on days after the event's first day (multi-day events). */
  isContinuationBefore: boolean;
  /** True on days before the event's last day — used for right-edge rounding. */
  isContinuationAfter: boolean;
}

/**
 * Compares date strings directly to avoid UTC/local midnight ambiguity.
 * Multi-day all-day events appear on every day in [scheduledStart, scheduledEnd];
 * isContinuationBefore/After distinguish the first/last day from middle days.
 */
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
 * Assigns each page a stable row index across visible days so that multi-day
 * all-day events render on the same row in every column they touch. Each slot
 * in the returned array is either an AllDayItem (chip) or null (empty row).
 * All days share the same slot count.
 *
 * Row claims track the SPECIFIC day indices a page has items on, not a
 * `start..end` range. Recurring virtual occurrences share the head page's id
 * (see `expandRecurrenceForRange`), so merging by id produces a "span" whose
 * items are non-contiguous (e.g. MWF occurrences). If we claimed every day
 * from min..max, unrelated single-day events on the gap days (Tu/Th) would
 * get pushed to row 1 with a phantom empty row 0 above them.
 */
export function assignAllDayRows(pages: PageSummary[], days: Date[]): (AllDayItem | null)[][] {
  const itemsByDay = days.map((d) => buildAllDayItems(pages, d));

  interface Span {
    pageId: string;
    /** Day indices this page has items on — may be non-contiguous for shared-id virtuals. */
    dayIndices: number[];
    /** Page createdAt — stable, user-meaningful tiebreaker (pageId is a UUID). */
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
  // Multi-day spans first so long horizontal bars anchor the top rows and the
  // single-day stack stays contiguous below (Google/Apple Calendar convention).
  // Within equal-length groups: earliest start first, then createdAt, then
  // pageId as a final deterministic fallback (UUID → not user-meaningful).
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
 * Stable cross-week variant of assignAllDayRows. Expands the computation to
 * cover the full span of every all-day page that overlaps `visibleDays`, so
 * multi-week events land on the same row in every week they appear — the
 * neighboring week's slot layout becomes the same context as the visible one.
 * Returns slots for only `visibleDays`; trailing rows that are empty across
 * every visible day are trimmed to keep the section dense when the stable
 * layout implies otherwise-empty space (e.g. events anchoring row 3 in a
 * prior week disappear in the current week).
 */
export function assignStableAllDayRows(
  pages: PageSummary[],
  visibleDays: Date[]
): (AllDayItem | null)[][] {
  if (visibleDays.length === 0) return [];
  const visibleStart = format(visibleDays[0]!, "yyyy-MM-dd");
  const visibleEnd = format(visibleDays[visibleDays.length - 1]!, "yyyy-MM-dd");

  // Find the outer span covered by any all-day page that overlaps the visible
  // range. An event extending into an earlier week pulls minStart back; one
  // extending into a later week pushes maxEnd forward.
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

  // Fast path: no multi-week event touching the visible range → the result is
  // identical to the local computation, so skip the expansion work.
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

  // Trim trailing rows that are empty across every visible day. Preserves
  // interior empty rows (those hold a multi-week event's anchor row in place).
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

/**
 * Lowest row index that is empty across columns [lo..hi] (inclusive).
 * Used by the drag-to-create ghost so its row matches where the new chip will
 * actually land — assignAllDayRows uses the same first-free-row rule, so the
 * ghost → real chip transition has no visual jump.
 */
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

/**
 * A single renderable all-day bar — one DOM element per event segment that's
 * visible in the current range. A multi-day event becomes one bar spanning
 * multiple columns; a non-contiguous recurring series (e.g. MWF sharing a page
 * id) becomes three separate bars because the row has nulls at the gap columns.
 */
export interface AllDayBar {
  page: PageSummary;
  /** First visible column the bar covers (0-indexed). */
  startCol: number;
  /** Number of consecutive visible columns the bar covers (>= 1). */
  span: number;
  /** Stable row index produced by assignStableAllDayRows. */
  row: number;
  /** True when the event starts before the visible range (hide left edge-resize, cut left radius). */
  continuesLeft: boolean;
  /** True when the event ends after the visible range (hide right edge-resize, cut right radius). */
  continuesRight: boolean;
  /** Stable React key — unique within a visible range. */
  key: string;
}

/**
 * Collapses a row-assigned slot grid into one bar per visible event segment.
 * Walks each row left→right; starts a new bar whenever the previous cell was
 * empty or held a different page, extends the bar while the same page id
 * continues in the same row. `continuesLeft/Right` inherit from the edge
 * slots' `isContinuationBefore/After` so week-boundary events are marked.
 */
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
      // Extend across a day boundary only for a genuine multi-day event
      // segment: the current day must flag continuation-after AND the next day
      // must be the same page's continuation-before. Recurring virtual
      // occurrences share the head's page id but are single-day
      // (isContinuationAfter === false), so a gap-free series (e.g. a daily
      // rule) stays as separate per-day bars instead of collapsing into one
      // "eternal" bar spanning the whole row. MWF-style series were already
      // split by their gap columns; this also covers the no-gap case.
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

/**
 * When a multi-day all-day event is dragged to a new start day, return the new
 * end date string that preserves its original duration. Returns `undefined`
 * when the event has no end, the end isn't all-day, or the span is zero —
 * callers should pass `undefined` to onReschedule in those cases so the chip
 * remains a single-day event.
 */
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

/**
 * Given an anchor date (the edge not being dragged) and the grabbed edge's new
 * date, returns the (start, end) pair for the new span. When the grabbed edge
 * crosses the anchor, the roles flip via min/max so the range stays valid.
 */
export function computeAllDayEdgeResize(
  anchorDate: string,
  grabbedDate: string
): { start: string; end: string } {
  return grabbedDate < anchorDate
    ? { end: anchorDate, start: grabbedDate }
    : { end: grabbedDate, start: anchorDate };
}

/**
 * Keeps the `AllDayBar` component ignorant of column-count math — only the
 * section that owns layout needs to know.
 */
export function barPositionStyle(bar: AllDayBar, columnCount: number): CSSProperties {
  const widthPct = (bar.span / columnCount) * 100;
  const leftPct = (bar.startCol / columnCount) * 100;
  return {
    left: `${leftPct}%`,
    top: ALL_DAY_TOP_PADDING + bar.row * ALL_DAY_ROW_HEIGHT,
    // Terminating bars shrink 2px for a visual gap next to the day boundary.
    // Bars that continue off-view stay flush so they read as "runs off-screen".
    width: bar.continuesRight ? `${widthPct}%` : `calc(${widthPct}% - 2px)`,
  };
}
