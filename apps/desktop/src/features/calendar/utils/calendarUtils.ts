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

/** Combined metrics + collapse geometry — passed to renderers so they don't
 * have to recompute pixel offsets on every block. */
export interface CalendarLayout {
  metrics: CalendarMetrics;
  geometry: CollapseGeometry;
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

// ─── Collapsed time bands ─────────────────────────────────────────────────────
// The calendar can hide the early-morning ([0, topHour)) and late-evening
// ([bottomHour, 24)) ranges behind small fixed-height bands so the readable
// "waking hours" middle dominates the viewport. Each band is independently
// toggleable; bounds X = topHour and Y = bottomHour are user-adjustable when
// the band is expanded (drag handle in the gutter). Pages that fall fully
// inside a collapsed band collapse into a clickable "+N more" pill at the
// band's edge — same component used for cluster-overflow elsewhere.

export interface CalendarCollapseConfig {
  /** Upper bound of the top collapsible band (exclusive). 0..23. */
  topHour: number;
  /** Lower bound of the bottom collapsible band (inclusive). 1..24. */
  bottomHour: number;
  /** When true, hours [0, topHour) render as a fixed-height band. */
  topCollapsed: boolean;
  /** When true, hours [bottomHour, 24) render as a fixed-height band. */
  bottomCollapsed: boolean;
}

/** Pixel height of each collapsed band. Matches the screenshot: ~40px so two
 * stacked labels (e.g. "12 AM"/"6 AM") plus a chevron remain comfortably legible. */
export const COLLAPSED_BAND_HEIGHT = 40;

/** Hard limits the user can drag the bounds to. Top must stay below bottom by
 * at least 1 hour so the middle "waking hours" region never disappears. */
export const MIN_TOP_HOUR = 0;
export const MAX_TOP_HOUR = 12;
export const MIN_BOTTOM_HOUR = 12;
export const MAX_BOTTOM_HOUR = 24;
export const MIN_VISIBLE_HOURS = 1;

export const DEFAULT_COLLAPSE_CONFIG: CalendarCollapseConfig = {
  bottomCollapsed: true,
  bottomHour: 22,
  topCollapsed: true,
  topHour: 6,
};

/**
 * Pre-computed pixel offsets for the three regions of the calendar grid under
 * a given collapse config. All coordinates are pixels from the grid top.
 *
 *   [0, topBandHeight)              → collapsed top band (or expanded [0, topHour))
 *   [middleStart, middleEnd)        → middle "waking hours" — always 1:1 with hour height
 *   [middleEnd, totalHeight)        → collapsed bottom band (or expanded [bottomHour, 24))
 */
export interface CollapseGeometry {
  config: CalendarCollapseConfig;
  hourHeight: number;
  topBandHeight: number;
  middleStart: number;
  middleEnd: number;
  middleHeight: number;
  bottomBandHeight: number;
  totalHeight: number;
}

export function buildCollapseGeometry(
  config: CalendarCollapseConfig,
  hourHeight: number
): CollapseGeometry {
  const topBandHeight = config.topCollapsed ? COLLAPSED_BAND_HEIGHT : config.topHour * hourHeight;
  const middleHeight = (config.bottomHour - config.topHour) * hourHeight;
  const bottomBandHeight = config.bottomCollapsed
    ? COLLAPSED_BAND_HEIGHT
    : (24 - config.bottomHour) * hourHeight;
  const middleStart = topBandHeight;
  const middleEnd = middleStart + middleHeight;
  return {
    bottomBandHeight,
    config,
    hourHeight,
    middleEnd,
    middleHeight,
    middleStart,
    topBandHeight,
    totalHeight: middleEnd + bottomBandHeight,
  };
}

/** Maps a calendar hour (0..24, fractional ok) to a pixel Y offset. Inside the
 * middle region the mapping is 1:1 with hourHeight; inside a collapsed band
 * it linearly compresses the band's hour range into COLLAPSED_BAND_HEIGHT. */
export function mapHourToY(hour: number, geometry: CollapseGeometry): number {
  const { bottomBandHeight, config, hourHeight, middleEnd, middleStart, topBandHeight } = geometry;
  const { bottomCollapsed, bottomHour, topCollapsed, topHour } = config;
  if (hour <= topHour) {
    if (topCollapsed) {
      const denom = topHour > 0 ? topHour : 1;
      return (hour / denom) * topBandHeight;
    }
    return hour * hourHeight;
  }
  if (hour >= bottomHour) {
    if (bottomCollapsed) {
      const denom = bottomHour < 24 ? 24 - bottomHour : 1;
      return middleEnd + ((hour - bottomHour) / denom) * bottomBandHeight;
    }
    return middleEnd + (hour - bottomHour) * hourHeight;
  }
  return middleStart + (hour - topHour) * hourHeight;
}

/** Inverse of mapHourToY — pixel Y to calendar hour (0..24). Used when
 * translating drag/resize/create gestures back into times. */
export function mapYToHour(y: number, geometry: CollapseGeometry): number {
  const { bottomBandHeight, config, hourHeight, middleEnd, middleStart, topBandHeight } = geometry;
  const { bottomCollapsed, bottomHour, topCollapsed, topHour } = config;
  if (y <= middleStart) {
    if (topCollapsed) {
      const denom = topBandHeight > 0 ? topBandHeight : 1;
      return (y / denom) * topHour;
    }
    return y / hourHeight;
  }
  if (y >= middleEnd) {
    if (bottomCollapsed) {
      const denom = bottomBandHeight > 0 ? bottomBandHeight : 1;
      return bottomHour + ((y - middleEnd) / denom) * (24 - bottomHour);
    }
    return bottomHour + (y - middleEnd) / hourHeight;
  }
  return topHour + (y - middleStart) / hourHeight;
}

/** Pixel offset of a Date's time on the collapse-aware grid. */
export function mapDateToY(date: Date, geometry: CollapseGeometry): number {
  const totalHours = getHours(date) + getMinutes(date) / 60;
  return mapHourToY(totalHours, geometry);
}

/**
 * Snaps a pixel Y to the nearest 15-minute mark on the collapse-aware grid
 * and returns the corresponding Date on `day`. Mirrors the contract of
 * `yToDate` but respects collapsed bands.
 *
 * Y values inside a collapsed band are clamped to the band's nearest visible
 * edge: drops in the top band snap to the bottomHour boundary's hour-equivalent
 * (== topHour), and drops in the bottom band snap to bottomHour. This means
 * users can't accidentally schedule events into invisible territory while a
 * band is collapsed; they expand first, then drop precisely.
 */
export function mapYToDate(y: number, day: Date, geometry: CollapseGeometry): Date {
  const { config, middleEnd, middleStart } = geometry;
  let clampedY = y;
  if (config.topCollapsed && clampedY < middleStart) clampedY = middleStart;
  if (config.bottomCollapsed && clampedY > middleEnd) clampedY = middleEnd;
  const hour = mapYToHour(clampedY, geometry);
  const rawMinutes = hour * 60;
  const snappedMinutes = Math.round(rawMinutes / 15) * 15;
  const clamped = Math.min(Math.max(snappedMinutes, 0), VISIBLE_HOURS * 60);
  return addMinutes(startOfDay(day), clamped);
}

/** Snaps a raw pixel Y to the nearest 15-minute grid line on the collapse-
 * aware grid. Returns a pixel Y in the same coord system as the input. */
export function snapYCollapse(y: number, geometry: CollapseGeometry): number {
  const hour = mapYToHour(y, geometry);
  const snappedHour = Math.round(hour * 4) / 4;
  return mapHourToY(snappedHour, geometry);
}

/** Clamps a hypothetical topHour value to the legal range given bottomHour. */
export function clampTopHour(value: number, bottomHour: number): number {
  const max = Math.min(MAX_TOP_HOUR, bottomHour - MIN_VISIBLE_HOURS);
  return Math.max(MIN_TOP_HOUR, Math.min(max, value));
}

/** Clamps a hypothetical bottomHour value to the legal range given topHour. */
export function clampBottomHour(value: number, topHour: number): number {
  const min = Math.max(MIN_BOTTOM_HOUR, topHour + MIN_VISIBLE_HOURS);
  return Math.min(MAX_BOTTOM_HOUR, Math.max(min, value));
}

// ─── Block remapping for collapsed bands ──────────────────────────────────────

/**
 * Result of remapping a day's CalendarBlocks against a collapse geometry.
 * Blocks fully inside a collapsed band drop out of `visible` and their page
 * ids accumulate into one of the *Pill arrays — the renderer emits a single
 * `+N more` chip in that band's pixel range. Blocks straddling a boundary
 * stay in `visible` with their `top` and `height` rewritten through the
 * geometry; visually they grow out of the compressed band into the middle.
 */
export interface RemappedBlocks {
  visible: CalendarBlock[];
  topCollapsedPageIds: string[];
  bottomCollapsedPageIds: string[];
}

export function remapBlocksForCollapse(
  blocks: CalendarBlock[],
  geometry: CollapseGeometry
): RemappedBlocks {
  const { config, hourHeight } = geometry;
  const visible: CalendarBlock[] = [];
  const topCollapsedPageIds: string[] = [];
  const bottomCollapsedPageIds: string[] = [];

  for (const b of blocks) {
    const startHour = b.top / hourHeight;
    const endHour = (b.top + b.height) / hourHeight;

    if (config.topCollapsed && endHour <= config.topHour) {
      topCollapsedPageIds.push(b.page.id);
      continue;
    }
    if (config.bottomCollapsed && startHour >= config.bottomHour) {
      bottomCollapsedPageIds.push(b.page.id);
      continue;
    }

    const newTop = mapHourToY(startHour, geometry);
    const newBottom = mapHourToY(endHour, geometry);
    const newHeight = Math.max(newBottom - newTop, 4);
    visible.push({ ...b, height: newHeight, top: newTop });
  }

  return { bottomCollapsedPageIds, topCollapsedPageIds, visible };
}

/** Slot size (minutes) used to round up short event durations for visual height. */
export const MIN_TIMED_MINUTES = 15;

/**
 * Shared Tailwind classes for event chips — used by both compact timed blocks and all-day items
 * so they stay visually identical. Import these instead of duplicating the string.
 */
export const CHIP_BASE_CLASSES =
  "type-body-sm h-[19px] overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" as const;

/** Default chip colors when no folder color is set. */
export const CHIP_DEFAULT_COLOR_CLASSES =
  "border-blue-500 bg-blue-500/20 dark:bg-blue-500/25" as const;

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
 * Inline color style for chips when a folder color is present. Sets
 * --event-color so CSS can derive mode-aware background, soft surround
 * border, and full-saturation left-edge accent — see app.css `--event-color`
 * rules. We don't set `borderColor` inline because CSS needs to vary it
 * between sides (left = full, others = softened).
 *
 * Returns CSSProperties so React's `style` prop accepts the result. The cast
 * is required because custom CSS properties aren't part of CSSProperties.
 */
export function chipFolderStyle(folderColor: string): CSSProperties {
  return { "--event-color": folderColor } as CSSProperties;
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
  /** Horizontal position as percent of the day column's width (0..100). */
  leftPct: number;
  /** Horizontal extent as percent of the day column's width (0..100). */
  widthPct: number;
  /** True when this block is a continuation from the previous day (event started before this day). */
  isContinuationBefore?: boolean;
  /** True when this event extends past the end of this day's grid. */
  isContinuationAfter?: boolean;
}

/**
 * Below this rendered width (px) a block switches to single-line "ultra
 * compact" rendering: title only, time hidden, checkbox hidden until hover.
 * Tuned for 7-day-week columns where standard cascade depth-2 events land
 * around 100–120 px and start losing their time row.
 */
export const COMPACT_MODE_WIDTH_PX = 100;

/**
 * If any block would render below this rendered width (px), the layout
 * collapses the smallest blocks into a `+N more` pill at the cluster's
 * right edge instead of letting their titles truncate to a single letter.
 */
export const OVERFLOW_MIN_WIDTH_PX = 60;

/**
 * Data the overflow pill needs — separate from CalendarBlock so the pill
 * isn't a synthetic page. The pill replaces the slot of the rightmost
 * cascaded under-width event, with a min-width floor so "+N more" stays
 * legible on narrow columns. Renders as a single chip at the slot's top.
 */
export interface OverflowPill {
  /** y-position (px from grid top) — top of the topmost collapsed event. */
  top: number;
  /** Pixel height (matches a compact chip). */
  height: number;
  /** Horizontal position as percent of the day column's width. */
  leftPct: number;
  /** Horizontal extent as percent of the day column's width. */
  widthPct: number;
  /** Page ids that were collapsed into this pill. */
  pageIds: string[];
}

/**
 * Collapses any blocks that would render narrower than OVERFLOW_MIN_WIDTH_PX
 * into a right-edge "+N more" pill. Returns the surviving blocks plus an
 * optional pill describing the collapsed ones. When `columnWidth <= 0` (no
 * measurement yet) returns the input unchanged so first paint isn't lossy.
 *
 * The pill anchors at the topmost collapsed block's `top` so it sits inside
 * the dense cluster rather than floating in empty space.
 */
export function collapseUnderWidth(
  blocks: CalendarBlock[],
  columnWidth: number
): { visible: CalendarBlock[]; pill: OverflowPill | null } {
  if (columnWidth <= 0) return { pill: null, visible: blocks };
  const underWidth: CalendarBlock[] = [];
  const visible: CalendarBlock[] = [];
  for (const b of blocks) {
    const renderedWidth = (b.widthPct / 100) * columnWidth;
    if (renderedWidth < OVERFLOW_MIN_WIDTH_PX) {
      underWidth.push(b);
    } else {
      visible.push(b);
    }
  }
  if (underWidth.length === 0) return { pill: null, visible };

  // Horizontal position: take the slot of the rightmost-cascaded under-width
  // event. If that slot is too narrow to render "+N more" legibly, expand
  // the pill leftward to a minimum readable width.
  const slotHost = underWidth.reduce(
    (best, b) => (b.leftPct > best.leftPct ? b : best),
    underWidth[0]!
  );
  const minPillPct = Math.min(50, (PILL_MIN_WIDTH_PX / columnWidth) * 100);
  const widthPct = Math.max(slotHost.widthPct, minPillPct);
  const leftPct = Math.min(slotHost.leftPct, 100 - widthPct);

  const pill: OverflowPill = {
    height: COMPACT_BLOCK_HEIGHT,
    leftPct,
    pageIds: underWidth.map((b) => b.page.id),
    top: slotHost.top,
    widthPct,
  };
  return { pill, visible };
}

/** Minimum pixel width for the pill — ensures "+N more" stays legible even
 * when the rightmost-cascaded slot is very narrow. */
const PILL_MIN_WIDTH_PX = 64;

/**
 * Horizontal indent (% of day-column width) per cascade depth step. Each
 * time-overlapping event gets pushed right by this amount so its host's
 * title/time row stays visible at the top-left. Tuned for 7-day-week columns
 * (~150–180 px wide): smaller and depth-3 events lose readability; larger and
 * the host's title gets squeezed at depth 1.
 */
export const CASCADE_OFFSET_PCT = 12;

/**
 * Maximum leftPct a cascading event can reach. Once cascaded past this, deeper
 * events all land at the same indent — they keep stacking in DOM order so each
 * still gets a visible left edge from the host underneath.
 */
const CASCADE_MAX_LEFT_PCT = 60;

/**
 * Minimum vertical separation (px) between two overlapping events' tops for
 * cascade to remain readable. Pairs with tops closer than this are split into
 * equal sub-columns instead — cascading them would put both titles in the
 * same horizontal band. Roughly the height of a 2-line title + time row.
 */
const CASCADE_MIN_TOP_GAP_PX = 40;

/**
 * Tighter threshold used for chip-vs-chip pairs. Chips are short (~19px) and
 * their single-line text doesn't reach into a host's title/time row, so 30
 * min apart already separates them visually — no need to split them into
 * sub-columns when they're not actually stacking on top of each other.
 */
const CHIP_COLLISION_GAP_PX = 20;

/**
 * Given all pages, returns positioned CalendarBlock[] for `day`.
 * All-day events are excluded (use buildAllDayItems instead).
 *
 * Overlap handling: a **nested cascade** matching Google Calendar's "Russian-
 * doll" look. Each subsequent overlap depth indents right by CASCADE_OFFSET_PCT
 * and renders on top of its host, so the host's title stays visible at the
 * top-left while the guest peeks out on the right.
 *
 * Events whose tops are within CASCADE_MIN_TOP_GAP_PX (e.g. same start time, or
 * very close starts) cannot cascade legibly — both titles would land in the
 * same band — so they're collected into a "text-collision component" and split
 * into equal sub-columns side-by-side instead.
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

  // Filter: must have a timed scheduledStart that overlaps with this day.
  // Multi-day timed events are NOT promoted to the all-day row — they render
  // here as one segment per day they touch (continuation flags on each
  // segment drive the radius + label rules in PageBlock).
  const overlapping = pages.filter((page) => {
    if (!page.scheduledStart) return false;
    if (isAllDayPage(page.scheduledStart)) return false;
    try {
      const start = parseISO(page.scheduledStart);
      const end = page.scheduledEnd ? parseISO(page.scheduledEnd) : start;
      return start < dayEnd && end > dayStart;
    } catch {
      return false;
    }
  });

  if (overlapping.length === 0) return [];

  const raws: RawBlock[] = overlapping.map((page) =>
    buildRawBlock(page, dayStart, dayEnd, metrics)
  );

  // Sort by visual top, then start time, then id — gives identical time ranges
  // a deterministic depth ordering across re-renders.
  raws.sort(
    (a, b) =>
      a.top - b.top ||
      a.startDate.getTime() - b.startDate.getTime() ||
      a.page.id.localeCompare(b.page.id)
  );

  const clusters = groupIntoClusters(raws);
  const blocks: CalendarBlock[] = [];

  for (const cluster of clusters) {
    const assignments = assignColumns(cluster);
    const components = findTextCollisionComponents(cluster);

    for (let i = 0; i < cluster.length; i++) {
      const raw = cluster[i]!;
      const component = components[i]!;
      let leftPct: number;
      let widthPct: number;

      if (component.length > 1) {
        // Close-top events (titles would clash if cascaded shoulder-to-shoulder).
        // Host takes the left half; the rest cascade inside the right half so
        // each subsequent guest still gets readable width — beats an N-way
        // equal split that crushes every chip down to a single letter when
        // N >= 3 in a narrow column.
        const subCol = component.indexOf(i);
        if (subCol === 0) {
          leftPct = 0;
          widthPct = 50;
        } else {
          // The (subCol-1)-th cascade step inside the right 50% — half-scaled
          // offset so the visible indent matches a normal cascade in a full
          // column. Capped at CASCADE_MAX_LEFT_PCT before scaling.
          const cascadeDepth = subCol - 1;
          const relativeOffset = Math.min(cascadeDepth * CASCADE_OFFSET_PCT, CASCADE_MAX_LEFT_PCT);
          leftPct = 50 + relativeOffset / 2;
          widthPct = 100 - leftPct;
        }
      } else {
        // Cascade at the event's sweep-line column. leftPct grows with depth;
        // widthPct fills the remaining column width so the deepest guest still
        // stretches to the right edge.
        const column = assignments[i]!;
        leftPct = Math.min(column * CASCADE_OFFSET_PCT, CASCADE_MAX_LEFT_PCT);
        widthPct = 100 - leftPct;
      }

      // Clipping invariant: no block may render past the right edge of its
      // day column. The cluster math should already respect this, but cap
      // defensively so any future edit can't bleed across the column line.
      if (leftPct < 0) leftPct = 0;
      if (leftPct > 100) leftPct = 100;
      if (widthPct < 0) widthPct = 0;
      if (leftPct + widthPct > 100) widthPct = 100 - leftPct;

      blocks.push({
        endDate: raw.endDate,
        height: raw.height,
        isCompact: raw.isCompact,
        leftPct,
        page: raw.page,
        startDate: raw.startDate,
        top: raw.top,
        widthPct,
        ...(raw.isContinuationAfter ? { isContinuationAfter: true as const } : {}),
        ...(raw.isContinuationBefore ? { isContinuationBefore: true as const } : {}),
      });
    }
  }

  // Emit in leftPct order so deeper-cascade events appear later in the DOM and
  // paint on top of their hosts.
  blocks.sort((a, b) => a.leftPct - b.leftPct || a.top - b.top);

  return blocks;
}

/**
 * Connected components of "events whose tops are within CASCADE_MIN_TOP_GAP_PX
 * of each other AND both render with stacked title+time layout." Each event
 * maps to the cluster-indices of its component (including itself), sorted by
 * visual position. Components of size 1 mean "cascade is safe"; size >= 2
 * means "split into host 50% + right-half cascade."
 *
 * Compact (chip) events are excluded from collision detection: their single
 * line of text doesn't clash with a host's title/time row, so they should
 * just cascade like any other nested event. This keeps a 2h block with three
 * point reminders inside it from collapsing every chip into a tiny sub-column
 * — the chips render almost-full-width within their host instead.
 */
function findTextCollisionComponents(cluster: RawBlock[]): number[][] {
  const adj: number[][] = cluster.map(() => []);
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const a = cluster[i]!;
      const b = cluster[j]!;
      const gap = Math.abs(a.top - b.top);
      // Two non-compact events conflict if either's header would land in the
      // other's title/time row. A chip vs anything else conflicts only when
      // the chip lands in the other's header area. Two chips conflict only at
      // near-identical times — they're short enough that 30 min apart already
      // gives them their own visual row.
      const threshold = a.isCompact && b.isCompact ? CHIP_COLLISION_GAP_PX : CASCADE_MIN_TOP_GAP_PX;
      if (gap < threshold) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }

  const compIdOf = new Array<number>(cluster.length).fill(-1);
  const componentMembers: number[][] = [];
  for (let i = 0; i < cluster.length; i++) {
    if (compIdOf[i] !== -1) continue;
    const id = componentMembers.length;
    const stack = [i];
    const members: number[] = [];
    compIdOf[i] = id;
    while (stack.length > 0) {
      const v = stack.pop()!;
      members.push(v);
      for (const u of adj[v]!) {
        if (compIdOf[u] === -1) {
          compIdOf[u] = id;
          stack.push(u);
        }
      }
    }
    members.sort(
      (a, b) =>
        cluster[a]!.top - cluster[b]!.top ||
        cluster[a]!.startDate.getTime() - cluster[b]!.startDate.getTime() ||
        cluster[a]!.page.id.localeCompare(cluster[b]!.page.id)
    );
    componentMembers.push(members);
  }

  return cluster.map((_, i) => componentMembers[compIdOf[i]!]!);
}

// ─── Cluster & column helpers ───────────────────────────────────────────────

/**
 * Group raws into transitively-connected overlap clusters. Requires the input
 * to be sorted by `top`. Two raws belong to the same cluster iff their visual
 * time ranges form a connected component under the overlap relation (so
 * A-overlaps-B and B-overlaps-C puts A, B, C in one cluster even if A and C
 * don't overlap each other).
 */
function groupIntoClusters(raws: RawBlock[]): RawBlock[][] {
  const clusters: RawBlock[][] = [];
  let current: RawBlock[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;

  for (const raw of raws) {
    const start = raw.visualStart.getTime();
    const end = raw.overlapEnd.getTime();
    if (start >= currentEnd && current.length > 0) {
      clusters.push(current);
      current = [];
      currentEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(raw);
    if (end > currentEnd) currentEnd = end;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Greedy sweep-line column assignment within a single cluster. Returns an
 * array parallel to `cluster` holding the column index assigned to each raw.
 *
 * Cascade-aware fallback: when col N is freed but col N+1 is still alive,
 * we DON'T fall back to col N. Cascade renders col 0 at full width
 * (`widthPct = 100 - leftPct`), so reusing a low column under an alive
 * higher one would paint the new event behind the higher cascade and
 * render it as a thin sliver on the left. Always allocate a new column to
 * the right of every still-alive column so the new event paints on top.
 */
function assignColumns(cluster: RawBlock[]): number[] {
  const columnOverlapEnds: number[] = [];
  const assignments: number[] = new Array<number>(cluster.length);

  for (let i = 0; i < cluster.length; i++) {
    const raw = cluster[i]!;
    const startMs = raw.visualStart.getTime();
    // Walk from highest column down. Reuse a free col only if every column
    // above it is also free for this event — otherwise the new event would
    // be hidden by an alive cascade above.
    let assigned = -1;
    for (let col = columnOverlapEnds.length - 1; col >= 0; col--) {
      if (columnOverlapEnds[col]! > startMs) break; // alive — block fallback
      assigned = col;
    }
    if (assigned === -1) {
      assigned = columnOverlapEnds.length;
      columnOverlapEnds.push(raw.overlapEnd.getTime());
    } else {
      columnOverlapEnds[assigned] = raw.overlapEnd.getTime();
    }
    assignments[i] = assigned;
  }
  return assignments;
}

// ─── Raw block construction ──────────────────────────────────────────────────

/** Intermediate representation used by the layout pass — not exported. */
interface RawBlock {
  endDate: Date;
  height: number;
  isContinuationAfter: boolean;
  isContinuationBefore: boolean;
  isCompact: boolean;
  /** Visual end (may differ from endDate for compact blocks) — used for overlap math. */
  overlapEnd: Date;
  /** Visual start clamped to the day's grid boundary. */
  visualStart: Date;
  page: PageSummary;
  startDate: Date;
  top: number;
}

function buildRawBlock(
  page: PageSummary,
  dayStart: Date,
  dayEnd: Date,
  metrics: CalendarMetrics
): RawBlock {
  const realStart = parseISO(page.scheduledStart!);
  const hasExplicitEnd = !!page.scheduledEnd;
  const realEnd = hasExplicitEnd ? parseISO(page.scheduledEnd!) : realStart;

  const durationMinutes = hasExplicitEnd ? (realEnd.getTime() - realStart.getTime()) / 60_000 : 0;

  const isContinuationBefore = realStart < dayStart;
  const isContinuationAfter = hasExplicitEnd && durationMinutes > 0 && realEnd >= dayEnd;

  const visualStart = isContinuationBefore ? dayStart : realStart;
  const visualEnd = isContinuationAfter ? dayEnd : realEnd;

  const top = timeToY(visualStart, metrics.hourHeight);
  const visualDurationMin = Math.max(
    MIN_TIMED_MINUTES,
    Math.ceil(Math.max(durationMinutes, 0) / MIN_TIMED_MINUTES) * MIN_TIMED_MINUTES
  );
  const heightFromDuration = (visualDurationMin / 60) * metrics.hourHeight;
  let endY: number;
  if (isContinuationAfter) {
    endY = metrics.gridHeight;
  } else if (isContinuationBefore) {
    endY = timeToY(visualEnd, metrics.hourHeight);
  } else {
    endY = Math.min(metrics.gridHeight, top + heightFromDuration);
  }
  const height = Math.max(endY - top, 4);
  const isCompact = !isContinuationAfter && height < CHIP_STACKED_THRESHOLD;
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
    visualStart,
  };
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
 * Formats a time range for display in a PageBlock. Uses an unspaced en-dash
 * (e.g. "9–10:30 AM") so the label fits inside narrow cascaded blocks where
 * a spaced dash would push the trailing period past the truncation edge.
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
    return `${fmt(start, false)}–${fmt(end, true)}`;
  }
  return `${fmt(start, true)}–${fmt(end, true)}`;
}

/**
 * Formats the first-segment label for a multi-day timed event. Includes
 * day-of-week on each side so the user can read both bookends without
 * counting columns: `"9 AM Mon – 5 PM Thu"`. Only applied on the first
 * segment of a multi-day event; subsequent days show the title alone.
 */
export function formatMultiDayTimeRange(start: Date, end: Date): string {
  const fmt = (d: Date) => {
    const h = getHours(d) % 12 || 12;
    const m = getMinutes(d);
    const minStr = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
    const period = getHours(d) < 12 ? "AM" : "PM";
    const dow = format(d, "EEE");
    return `${h}${minStr} ${period} ${dow}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
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
