// Calendar layout utilities — pure functions, no React deps.

import type { PageSummary } from "@pikos/core";
import {
  addDays,
  addMinutes,
  endOfWeek,
  format,
  getHours,
  getMinutes,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
export const CLICK_DELAY = 200;

/**
 * The calendar grid renders the full 24-hour day. GRID_START_HOUR / GRID_END_HOUR
 * used to clip to "working hours" but are now fixed — scrolling reveals the rest.
 */
export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const VISIBLE_HOURS = 24;

/** Default "normal" density metrics. Tests and legacy callers read these directly. */
export const HOUR_HEIGHT = 64;
export const COMPACT_BLOCK_HEIGHT = 19;
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;
export const MIN_RESIZE_HEIGHT = (15 / 60) * HOUR_HEIGHT;

/** User-selectable density. */
export type CalendarDensity = "compact" | "normal" | "spacious";

/** Snapshot of the layout constants that scale with density. */
export interface CalendarMetrics {
  hourHeight: number;
  compactBlockHeight: number;
  gridHeight: number;
  minResizeHeight: number;
}

const DENSITY_HOUR_HEIGHT: Record<CalendarDensity, number> = {
  compact: 40,
  normal: 64,
  spacious: 88,
};

const DENSITY_COMPACT_HEIGHT: Record<CalendarDensity, number> = {
  compact: 16,
  normal: 19,
  spacious: 24,
};

/** Derive a full CalendarMetrics snapshot from a density choice. */
export function computeCalendarMetrics(density: CalendarDensity): CalendarMetrics {
  const hourHeight = DENSITY_HOUR_HEIGHT[density];
  return {
    compactBlockHeight: DENSITY_COMPACT_HEIGHT[density],
    gridHeight: hourHeight * VISIBLE_HOURS,
    hourHeight,
    minResizeHeight: (15 / 60) * hourHeight,
  };
}

/** Baseline metrics for tests + callers that don't have settings context. */
export const DEFAULT_METRICS: CalendarMetrics = computeCalendarMetrics("normal");

/**
 * Minimum duration in minutes for a block to render proportionally.
 * Below this threshold (or when there is no scheduledEnd) the block renders as a compact chip.
 */
export const MIN_TIMED_MINUTES = 15;

/**
 * Shared Tailwind classes for event chips — used by both compact timed blocks and all-day items
 * so they stay visually identical. Import these instead of duplicating the string.
 */
export const CHIP_BASE_CLASSES =
  "type-body-sm h-[19px] overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" as const;

/** Default chip colors when no folder color is set. */
export const CHIP_DEFAULT_COLOR_CLASSES = "border-blue-500 bg-blue-500/20" as const;

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
 * stepping by weeks keeps Mon–Sun alignment). When `dayCount < 7` the array
 * starts at `date` itself, so prev/next steps show adjacent days without
 * week-boundary jumps.
 */
export function buildCalendarDays(date: Date, dayCount: number, weekStartsOn: 0 | 1 = 1): Date[] {
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
}

/**
 * Returns pages scheduled as all-day events that overlap `day`.
 * Compares date strings directly to avoid UTC/local midnight ambiguity.
 * Multi-day all-day events appear on every day in [scheduledStart, scheduledEnd];
 * isContinuationBefore distinguishes the first day from continuation days.
 */
export function buildAllDayItems(pages: PageSummary[], day: Date): AllDayItem[] {
  const dayStr = format(day, "yyyy-MM-dd");
  const results: AllDayItem[] = [];
  for (const page of pages) {
    if (page.scheduledStart == null || !isAllDayPage(page.scheduledStart)) continue;
    const start = page.scheduledStart;
    const end = page.scheduledEnd && isAllDayPage(page.scheduledEnd) ? page.scheduledEnd : start;
    if (dayStr < start || dayStr > end) continue;
    results.push({ isContinuationBefore: dayStr > start, page });
  }
  return results;
}

/**
 * Assigns each page a stable row index across visible days so that multi-day
 * all-day events render on the same row in every column they touch. Each slot
 * in the returned array is either an AllDayItem (chip) or null (empty row).
 * All days share the same slot count.
 */
export function assignAllDayRows(pages: PageSummary[], days: Date[]): (AllDayItem | null)[][] {
  const itemsByDay = days.map((d) => buildAllDayItems(pages, d));

  interface Span {
    end: number;
    items: AllDayItem[];
    pageId: string;
    start: number;
  }
  const spans: Span[] = [];
  const byPage = new Map<string, Span>();
  itemsByDay.forEach((dayItems, dayIdx) => {
    for (const item of dayItems) {
      const existing = byPage.get(item.page.id);
      if (existing) {
        existing.end = dayIdx;
        existing.items.push(item);
      } else {
        const span: Span = { end: dayIdx, items: [item], pageId: item.page.id, start: dayIdx };
        byPage.set(item.page.id, span);
        spans.push(span);
      }
    }
  });
  spans.sort((a, b) => a.start - b.start || a.pageId.localeCompare(b.pageId));

  const usedByDay: Set<number>[] = days.map(() => new Set());
  const rowByPage = new Map<string, number>();
  for (const span of spans) {
    let row = 0;
    for (;;) {
      let free = true;
      for (let i = span.start; i <= span.end; i++) {
        if (usedByDay[i]!.has(row)) {
          free = false;
          break;
        }
      }
      if (free) break;
      row++;
    }
    rowByPage.set(span.pageId, row);
    for (let i = span.start; i <= span.end; i++) usedByDay[i]!.add(row);
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

    // Determine if the event is compact (only when fully within one day)
    const durationMinutes = hasExplicitEnd ? (realEnd.getTime() - realStart.getTime()) / 60_000 : 0;
    const isCompact = !hasExplicitEnd || durationMinutes < MIN_TIMED_MINUTES;

    // Clamp start/end to this day's grid boundaries for cross-day events
    const isContinuationBefore = realStart < dayStart;
    const isContinuationAfter = !isCompact && realEnd >= dayEnd;

    // For visual positioning, clamp to the day's grid boundaries (midnight ↔ midnight)
    const visualStart = isContinuationBefore ? dayStart : realStart;
    const visualEnd = isContinuationAfter ? dayEnd : realEnd;

    const top = timeToY(visualStart, metrics.hourHeight);
    // isContinuationAfter's visualEnd is next-day midnight, which timeToY reads as 0;
    // substitute gridHeight directly so the block extends to the bottom of the grid.
    const endY = isContinuationAfter ? metrics.gridHeight : timeToY(visualEnd, metrics.hourHeight);
    const height = isCompact ? metrics.compactBlockHeight : Math.max(endY - top, 4);

    // For overlap calculation, compact blocks claim a 15-min footprint
    const overlapEnd = isCompact
      ? new Date(visualStart.getTime() + MIN_TIMED_MINUTES * 60_000)
      : visualEnd;

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
