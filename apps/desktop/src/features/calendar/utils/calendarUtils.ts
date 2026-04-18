// Calendar layout utilities — pure functions + a couple of DOM gesture
// helpers that both timed and all-day blocks share. No React imports here
// apart from the `CSSProperties` type used by `barPositionStyle`.

import type { PageSummary } from "@pikos/core";
import { formatLocalISO, parseLocalISO } from "@pikos/core";
import {
  addDays,
  addMinutes,
  differenceInCalendarDays,
  endOfWeek,
  format,
  getHours,
  getMinutes,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";
import type { CSSProperties } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
export const CLICK_DELAY = 150;

/**
 * The calendar grid renders the full 24-hour day. GRID_START_HOUR / GRID_END_HOUR
 * used to clip to "working hours" but are now fixed — scrolling reveals the rest.
 */
export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const VISIBLE_HOURS = 24;

/** Default "normal" density metrics. Tests and legacy callers read these directly. */
export const HOUR_HEIGHT = 64;
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;
export const MIN_RESIZE_HEIGHT = (15 / 60) * HOUR_HEIGHT;

/**
 * Visual height for a 15-minute ("quarter hour") block. Every timed event renders
 * at a multiple of this — durations are rounded up to the next 15-minute slot so
 * short events remain readable.
 */
export const COMPACT_BLOCK_HEIGHT = HOUR_HEIGHT / 4;

/**
 * Layout threshold (px): below this a block renders as a single-line chip, above
 * this as a stacked title+time block. Density-independent.
 */
export const CHIP_STACKED_THRESHOLD = 28;

/** User-selectable density. */
export type CalendarDensity = "compact" | "normal" | "spacious";

/**
 * User-selectable day count for the calendar grid. Numbers are literal column
 * counts; `"mf"` means "work week" — 5 columns anchored to Monday, Sat/Sun hidden.
 */
export type CalendarDayCount = 1 | 3 | 5 | "mf" | 7;

/** Number of columns rendered for a given day-count value. */
export function dayCountColumns(dc: CalendarDayCount): number {
  return dc === "mf" ? 5 : dc;
}

/**
 * How many days prev/next navigation should advance. M-F steps by a full week
 * so the next page lands on the following Monday, not on a Saturday.
 */
export function dayCountNavStep(dc: CalendarDayCount): number {
  return dc === "mf" ? 7 : dc;
}

/**
 * Cap a user-preferred day count by what the current breakpoint can render.
 * If "mf" doesn't fit, demote to the largest numeric value that does.
 */
export function clampDayCount(preferred: CalendarDayCount, maxColumns: number): CalendarDayCount {
  if (dayCountColumns(preferred) <= maxColumns) return preferred;
  if (maxColumns >= 7) return 7;
  if (maxColumns >= 5) return 5;
  if (maxColumns >= 3) return 3;
  return 1;
}

/** Snapshot of the layout constants that scale with density. */
export interface CalendarMetrics {
  hourHeight: number;
  /** Height of a 15-minute slot — the minimum block height for timed events. */
  compactBlockHeight: number;
  gridHeight: number;
  minResizeHeight: number;
}

const DENSITY_HOUR_HEIGHT: Record<CalendarDensity, number> = {
  compact: 40,
  normal: 64,
  spacious: 88,
};

/** Derive a full CalendarMetrics snapshot from a density choice. */
export function computeCalendarMetrics(density: CalendarDensity): CalendarMetrics {
  const hourHeight = DENSITY_HOUR_HEIGHT[density];
  return {
    compactBlockHeight: hourHeight / 4,
    gridHeight: hourHeight * VISIBLE_HOURS,
    hourHeight,
    minResizeHeight: (15 / 60) * hourHeight,
  };
}

/** Baseline metrics for tests + callers that don't have settings context. */
export const DEFAULT_METRICS: CalendarMetrics = computeCalendarMetrics("normal");

/** Slot size (minutes) used to round up short event durations for visual height. */
export const MIN_TIMED_MINUTES = 15;

/**
 * Shared Tailwind classes for event chips — used by both compact timed blocks and all-day items
 * so they stay visually identical. Import these instead of duplicating the string.
 */
export const CHIP_BASE_CLASSES =
  "type-body-sm h-[19px] overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" as const;

/** Default chip colors when no folder color is set. */
export const CHIP_DEFAULT_COLOR_CLASSES = "border-blue-500 bg-blue-500/20" as const;

// ─── All-day layout constants ────────────────────────────────────────────────
// Bars in the all-day section are absolutely positioned. Row N sits at
// `ALL_DAY_TOP_PADDING + N * ALL_DAY_ROW_HEIGHT`; the container reserves
// `2 * ALL_DAY_TOP_PADDING + rowCount * ALL_DAY_ROW_HEIGHT` so the bottom edge
// gets matching breathing room.

/** Height of a single all-day bar (matches CHIP_BASE_CLASSES h-[19px]). */
export const ALL_DAY_BAR_HEIGHT = 19;
/** Vertical gap between bars on consecutive rows. */
export const ALL_DAY_ROW_GAP = 2;
/** Row pitch — how much `top` advances for each row index. */
export const ALL_DAY_ROW_HEIGHT = ALL_DAY_BAR_HEIGHT + ALL_DAY_ROW_GAP;
/** Top/bottom padding on the bar container. */
export const ALL_DAY_TOP_PADDING = 4;

/**
 * Inline color style for chips when a folder color is present.
 * Sets --event-color so CSS can apply mode-aware background opacity
 * (12% in light mode, 15% in dark mode — see app.css event-color rules).
 */
export function chipFolderStyle(folderColor: string): {
  "--event-color": string;
  borderColor: string;
} {
  return { "--event-color": folderColor, borderColor: folderColor };
}

// ─── Week helpers ─────────────────────────────────────────────────────────────

/** Returns the first day of the week containing `date`. */
export function weekStart(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  return startOfWeek(date, { weekStartsOn });
}

/** Returns array of 7 Date objects for the week containing `date`. */
export function weekDays(date: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const first = weekStart(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * Returns the Date[] the calendar should render for a given reference date and
 * day count. When `dayCount === 7` the array is anchored at the week start (so
 * stepping by weeks keeps Mon–Sun alignment). When `dayCount === "mf"` it
 * returns Mon–Fri of the week containing `date` (always Monday-anchored
 * regardless of `weekStartsOn`, since "M-F" implies Monday-first by name).
 * When `dayCount < 7` the array starts at `date` itself, so prev/next steps
 * show adjacent days without week-boundary jumps.
 */
export function buildCalendarDays(
  date: Date,
  dayCount: CalendarDayCount,
  weekStartsOn: 0 | 1 = 1
): Date[] {
  if (dayCount === "mf") {
    const monday = weekStart(date, 1);
    return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  }
  const first = dayCount === 7 ? weekStart(date, weekStartsOn) : startOfDay(date);
  return Array.from({ length: dayCount }, (_, i) => addDays(first, i));
}

/** Returns the last day of the week containing `date`. */
export function weekEnd(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  return endOfWeek(date, { weekStartsOn });
}

// ─── All-day detection ────────────────────────────────────────────────────────

/**
 * Returns true when scheduledStart is a date-only string ('YYYY-MM-DD').
 * Timed events include 'T' in the ISO string; all-day events are 10 chars with no 'T'.
 */
export function isAllDayPage(scheduledStart: string): boolean {
  return !scheduledStart.includes("T");
}

export interface AllDayItem {
  page: PageSummary;
  /** True on days after the event's first day (multi-day events). */
  isContinuationBefore: boolean;
  /** True on days before the event's last day — used for right-edge rounding. */
  isContinuationAfter: boolean;
}

/**
 * Returns pages scheduled as all-day events that overlap `day`.
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
      while (end < dayCount && slotsByDay[end]?.[row]?.page.id === pageId) {
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

// ─── All-day edge resize ──────────────────────────────────────────────────────

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
 * Computes the (start, end) a page should be rescheduled to when the user picks
 * a new start ISO in the date picker. Handles four transitions:
 *   - all-day → timed: collapse to single day (end undefined)
 *   - timed → all-day: preserve date extent (drop time from end)
 *   - timed → timed: preserve duration
 *   - all-day → all-day: preserve end, drop if it's now before the new start
 * Returns start = iso and either an end ISO or undefined (single occurrence).
 * `iso` must be non-null — callers should treat null as "clear schedule" first.
 */
export function computeScheduleTransition(
  current: { start: string | null | undefined; end: string | null | undefined },
  iso: string
): { start: string; end: string | undefined } {
  const currStart = current.start;
  const currEnd = current.end;
  const wasAllDay = currStart != null && !currStart.includes("T");
  const nowAllDay = !iso.includes("T");

  // all-day → timed: collapse to single day.
  if (wasAllDay && !nowAllDay) return { end: undefined, start: iso };

  // timed → all-day: strip time from end; preserve date extent.
  if (currStart != null && !wasAllDay && nowAllDay) {
    if (currEnd?.includes("T")) {
      const endDateOnly = currEnd.slice(0, 10);
      return { end: endDateOnly > iso ? endDateOnly : undefined, start: iso };
    }
    return { end: currEnd && currEnd > iso ? currEnd : undefined, start: iso };
  }

  // timed → timed: preserve duration.
  if (!nowAllDay && currStart?.includes("T") && currEnd?.includes("T")) {
    const durationMs = parseLocalISO(currEnd).getTime() - parseLocalISO(currStart).getTime();
    if (durationMs > 0) {
      const endIso = formatLocalISO(new Date(parseLocalISO(iso).getTime() + durationMs));
      return { end: endIso, start: iso };
    }
    return { end: currEnd, start: iso };
  }

  // all-day → all-day: preserve end, drop if now before new start.
  return { end: currEnd && currEnd >= iso ? currEnd : undefined, start: iso };
}

/**
 * Normalises the value returned from the end-date picker into the `end` arg
 * for `scheduleOnce`. Returns `undefined` when the picker cleared the end or
 * when the resulting end would be <= start (single-day semantics). For all-day
 * starts, any datetime end is stripped back to date-only.
 */
export function normalizeEndInput(currentStart: string, endIso: string | null): string | undefined {
  if (endIso === null) return undefined;
  const startIsAllDay = !currentStart.includes("T");
  let next = endIso;
  if (startIsAllDay && next.includes("T")) next = next.slice(0, 10);
  if (next <= currentStart) return undefined;
  return next;
}

// ─── Time → pixel ─────────────────────────────────────────────────────────────

/**
 * Converts a Date's time to a pixel offset from the top of the 24-hour grid.
 * Clamps to [0, 24 * hourHeight].
 */
export function timeToY(date: Date, hourHeight: number = HOUR_HEIGHT): number {
  const hours = getHours(date);
  const minutes = getMinutes(date);
  const totalMinutes = hours * 60 + minutes;
  const gridHeight = hourHeight * VISIBLE_HOURS;
  return Math.min(Math.max(totalMinutes * (hourHeight / 60), 0), gridHeight);
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

/**
 * Converts a hex colour string (#RRGGBB or RRGGBB) to rgba(r,g,b,alpha).
 * Returns a fallback muted indigo if the hex cannot be parsed.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(cleaned);
  if (!result) return `rgba(99,102,241,${alpha})`;
  const r = parseInt(result[1]!, 16);
  const g = parseInt(result[2]!, 16);
  const b = parseInt(result[3]!, 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Block layout ─────────────────────────────────────────────────────────────

export interface CalendarBlock {
  page: PageSummary;
  startDate: Date;
  endDate: Date;
  /** Pixel distance from grid top */
  top: number;
  /** Pixel height */
  height: number;
  /** True when duration < MIN_TIMED_MINUTES or there is no scheduledEnd. */
  isCompact: boolean;
  /** 0-based column index within overlap group */
  column: number;
  /** Total number of columns in this overlap group */
  totalColumns: number;
  /** True when this block is a continuation from the previous day (event started before this day). */
  isContinuationBefore?: boolean;
  /** True when this event extends past the end of this day's grid. */
  isContinuationAfter?: boolean;
}

/**
 * Given all pages, returns positioned CalendarBlock[] for `day`.
 * All-day events are excluded (use buildAllDayItems instead).
 * Handles overlap by assigning equal-width column slots.
 *
 * Events that span across midnight are shown on each day they touch:
 * - On the start day: renders from event start to bottom of grid (isContinuationAfter)
 * - On middle days: renders full grid height (isContinuationBefore + isContinuationAfter)
 * - On the end day: renders from top of grid to event end (isContinuationBefore)
 */
export function buildDayBlocks(
  pages: PageSummary[],
  day: Date,
  metrics: CalendarMetrics = DEFAULT_METRICS
): CalendarBlock[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  // Filter: must have a timed scheduledStart that overlaps with this day
  const overlapping = pages.filter((page) => {
    if (!page.scheduledStart) return false;
    if (isAllDayPage(page.scheduledStart)) return false;
    try {
      const start = parseISO(page.scheduledStart);
      const end = page.scheduledEnd ? parseISO(page.scheduledEnd) : start;
      // Event overlaps with day if it starts before day ends AND ends after day starts
      return start < dayEnd && end > dayStart;
    } catch {
      return false;
    }
  });

  if (overlapping.length === 0) return [];

  // Build raw blocks
  interface RawBlock {
    endDate: Date;
    height: number;
    isContinuationAfter: boolean;
    isContinuationBefore: boolean;
    isCompact: boolean;
    /** End used only for overlap layout — may differ from endDate for compact blocks */
    overlapEnd: Date;
    page: PageSummary;
    startDate: Date;
    top: number;
  }

  const raws: RawBlock[] = overlapping.map((page) => {
    const realStart = parseISO(page.scheduledStart!);
    const hasExplicitEnd = !!page.scheduledEnd;
    const realEnd = hasExplicitEnd ? parseISO(page.scheduledEnd!) : realStart;

    const durationMinutes = hasExplicitEnd ? (realEnd.getTime() - realStart.getTime()) / 60_000 : 0;

    // Clamp start/end to this day's grid boundaries for cross-day events.
    // A zero- or sub-minute event (no end, or ≤ 0 min) is never a "continuation" —
    // it's a point-in-time and gets the 15-min minimum visual block.
    const isContinuationBefore = realStart < dayStart;
    const isContinuationAfter = hasExplicitEnd && durationMinutes > 0 && realEnd >= dayEnd;

    // For visual positioning, clamp to the day's grid boundaries (midnight ↔ midnight)
    const visualStart = isContinuationBefore ? dayStart : realStart;
    const visualEnd = isContinuationAfter ? dayEnd : realEnd;

    const top = timeToY(visualStart, metrics.hourHeight);
    // Visual duration rounds up to the nearest 15-min slot, minimum 15 min.
    // Short events stay readable; no-end events behave like 15-min events.
    // Only used for blocks that fit entirely within one day — continuation
    // segments derive their end from the day boundary instead.
    const visualDurationMin = Math.max(
      MIN_TIMED_MINUTES,
      Math.ceil(Math.max(durationMinutes, 0) / MIN_TIMED_MINUTES) * MIN_TIMED_MINUTES
    );
    const heightFromDuration = (visualDurationMin / 60) * metrics.hourHeight;
    let endY: number;
    if (isContinuationAfter) {
      // Event continues into the next day — extend to the bottom of this day's grid.
      endY = metrics.gridHeight;
    } else if (isContinuationBefore) {
      // Event started before this day — render from day-top to the real event end,
      // NOT top + full-event duration (which would over-extend past the real end).
      endY = timeToY(visualEnd, metrics.hourHeight);
    } else {
      // Event fits within this day — use the round-up proportional height.
      endY = Math.min(metrics.gridHeight, top + heightFromDuration);
    }
    const height = Math.max(endY - top, 4);

    // Chip (single-line) rendering when the block isn't tall enough to stack
    // title + time. Height-based — density-independent.
    const isCompact = !isContinuationAfter && height < CHIP_STACKED_THRESHOLD;

    // For overlap calculation, use the visual duration so snapped-up short events
    // claim their rounded slot (two 10-min events at 4:00 and 4:05 both claim a
    // 15-min slot → they correctly column-partition).
    const overlapEnd = isContinuationAfter
      ? visualEnd
      : new Date(visualStart.getTime() + visualDurationMin * 60_000);

    return {
      endDate: realEnd,
      height,
      isCompact,
      isContinuationAfter,
      isContinuationBefore,
      overlapEnd,
      page,
      startDate: realStart,
      top,
    };
  });

  // Sort by visual top position (continuation blocks sort to top of grid)
  raws.sort((a, b) => a.top - b.top || a.startDate.getTime() - b.startDate.getTime());

  // Assign overlap columns (greedy sweep-line)
  const columnOverlapEnds: Date[] = [];
  const assignments: number[] = [];

  for (const raw of raws) {
    // Use visual start for column assignment
    const visualStart = raw.isContinuationBefore ? dayStart : raw.startDate;

    let assigned = -1;
    for (let col = 0; col < columnOverlapEnds.length; col++) {
      const colEnd = columnOverlapEnds[col];
      if (colEnd !== undefined && colEnd <= visualStart) {
        assigned = col;
        break;
      }
    }
    if (assigned === -1) {
      assigned = columnOverlapEnds.length;
      columnOverlapEnds.push(raw.overlapEnd);
    } else {
      columnOverlapEnds[assigned] = raw.overlapEnd;
    }
    assignments.push(assigned);
  }

  // Determine totalColumns per block (max col index among overlapping blocks + 1)
  const blocks: CalendarBlock[] = raws.map((raw, i) => {
    const column = assignments[i]!;
    let maxColumn = column;
    for (let j = 0; j < raws.length; j++) {
      if (i === j) continue;
      const other = raws[j]!;
      const visualStartI = raw.isContinuationBefore ? dayStart : raw.startDate;
      const visualStartJ = other.isContinuationBefore ? dayStart : other.startDate;
      const overlaps = visualStartI < other.overlapEnd && raw.overlapEnd > visualStartJ;
      if (overlaps) {
        maxColumn = Math.max(maxColumn, assignments[j]!);
      }
    }
    return {
      column,
      endDate: raw.endDate,
      height: raw.height,
      isCompact: raw.isCompact,
      ...(raw.isContinuationAfter ? { isContinuationAfter: true as const } : {}),
      ...(raw.isContinuationBefore ? { isContinuationBefore: true as const } : {}),
      page: raw.page,
      startDate: raw.startDate,
      top: raw.top,
      totalColumns: maxColumn + 1,
    };
  });

  return blocks;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

/** Pixel movement threshold before a mousedown is treated as a drag gesture. */
export const DRAG_THRESHOLD = 4;

/**
 * Snaps a raw pixel Y offset to the nearest 15-minute grid line.
 * Does not clamp — use Math.max/min around the call site as needed.
 */
export function snapY(y: number, hourHeight: number = HOUR_HEIGHT): number {
  const rawMinutes = (y / hourHeight) * 60;
  const snapped = Math.round(rawMinutes / 15) * 15;
  return (snapped / 60) * hourHeight;
}

/**
 * Converts a raw pixel Y offset (from the grid container top) to a Date snapped to
 * the nearest 15-minute boundary on `day`. Clamps to [00:00, 24:00] on `day`.
 */
export function yToDate(y: number, day: Date, hourHeight: number = HOUR_HEIGHT): Date {
  const rawMinutes = (y / hourHeight) * 60;
  const snappedMinutes = Math.round(rawMinutes / 15) * 15;
  const clampedMinutes = Math.min(Math.max(snappedMinutes, 0), VISIBLE_HOURS * 60);
  return addMinutes(startOfDay(day), clampedMinutes);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Formats a time range for display in a PageBlock.
 * e.g. "9:00 – 10:30 AM" (shares AM/PM when both are the same period)
 */
export function formatTimeRange(start: Date, end: Date): string {
  const startHour = getHours(start);
  const endHour = getHours(end);
  const startPeriod = startHour < 12 ? "AM" : "PM";
  const endPeriod = endHour < 12 ? "AM" : "PM";

  const fmt = (d: Date, includePeriod: boolean) => {
    const h = getHours(d) % 12 || 12;
    const m = getMinutes(d);
    const minStr = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
    return includePeriod ? `${h}${minStr} ${getHours(d) < 12 ? "AM" : "PM"}` : `${h}${minStr}`;
  };

  if (startPeriod === endPeriod) {
    return `${fmt(start, false)} – ${fmt(end, true)}`;
  }
  return `${fmt(start, true)} – ${fmt(end, true)}`;
}

// ─── Gesture helpers ─────────────────────────────────────────────────────────

/**
 * Wires up a mousedown→mousemove drag-threshold detector. Fires `onCrossed`
 * the first time the cursor moves more than `DRAG_THRESHOLD` px from its
 * starting coordinates and then disconnects — downstream drag state is the
 * caller's responsibility. Fires `onEnd` only when the user releases without
 * ever crossing the threshold (a "click", not a drag).
 *
 * `bodyCursor` is optional: when set, the class is added to <html> on
 * mousedown for instant feedback and removed on a click-release. After the
 * threshold is crossed, the caller (usually the drag handler on the parent
 * grid) owns class management — the helper leaves it set.
 */
export function beginDragThreshold(
  startX: number,
  startY: number,
  opts: {
    onCrossed: () => void;
    bodyCursor?: "dragging-grab" | "dragging-resize";
  }
): void {
  if (opts.bodyCursor) {
    document.documentElement.classList.add(opts.bodyCursor);
  }
  let crossed = false;

  function onMove(ev: MouseEvent) {
    if (
      Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
    ) {
      crossed = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      opts.onCrossed();
    }
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!crossed && opts.bodyCursor) {
      document.documentElement.classList.remove(opts.bodyCursor);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ─── All-day bar styling ─────────────────────────────────────────────────────

/**
 * Translates bar coordinates into the inline style a renderer can spread onto
 * an absolutely-positioned element. Keeps the `AllDayBar` component ignorant
 * of column-count math — only the section that owns layout needs to know.
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
