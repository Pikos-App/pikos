// Calendar layout utilities — pure functions, no React deps.

import type { PageSummary } from "@pikos/core";
import {
  addDays,
  addMinutes,
  endOfWeek,
  format,
  getHours,
  getMinutes,
  isSameDay,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Height in pixels for one hour in the time grid. Tune here to adjust zoom. */
export const HOUR_HEIGHT = 64;

/** First visible hour (6 = 6:00 AM). */
export const GRID_START_HOUR = 6;

/** Last visible hour, exclusive (23 = 11:00 PM). Grid ends at 23:00. */
export const GRID_END_HOUR = 23;

/** Total number of visible hours in the grid. */
export const VISIBLE_HOURS = GRID_END_HOUR - GRID_START_HOUR;

/** Total scrollable height of the time grid in pixels. */
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;

/**
 * Fixed height for compact event chips (no scheduledEnd, or duration < 15 min).
 * Large enough for a single line of text; visually distinct from proportional blocks.
 */
export const COMPACT_BLOCK_HEIGHT = 19;

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
  "h-[19px] overflow-hidden truncate rounded-sm border-l-2 px-1.5 text-sm leading-none font-medium text-foreground transition-opacity hover:opacity-75 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none" as const;

/** Default chip colors when no folder color is set. */
export const CHIP_DEFAULT_COLOR_CLASSES = "border-blue-500 bg-blue-500/20" as const;

/** Inline color style for chips when a folder color is present. */
export function chipFolderStyle(folderColor: string): {
  backgroundColor: string;
  borderColor: string;
} {
  return { backgroundColor: hexToRgba(folderColor, 0.25), borderColor: folderColor };
}

// ─── Week helpers ─────────────────────────────────────────────────────────────

/** Returns the Monday of the week containing `date`. */
export function weekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

/** Returns array of 7 Date objects for the week containing `date` (Mon–Sun). */
export function weekDays(date: Date): Date[] {
  const monday = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Returns the last day (Sunday) of the week containing `date`. */
export function weekEnd(date: Date): Date {
  return endOfWeek(date, { weekStartsOn: 1 });
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
 * Returns pages that are scheduled as all-day events on `day`.
 * Compares date strings directly to avoid UTC/local midnight ambiguity.
 */
export function buildAllDayItems(pages: PageSummary[], day: Date): PageSummary[] {
  const dayStr = format(day, "yyyy-MM-dd");
  return pages.filter(
    (page) =>
      page.scheduledStart != null &&
      isAllDayPage(page.scheduledStart) &&
      page.scheduledStart === dayStr
  );
}

// ─── Time → pixel ─────────────────────────────────────────────────────────────

/**
 * Converts a Date's time to a pixel offset from the top of the visible grid.
 * Hours before GRID_START_HOUR clamp to 0. Hours after GRID_END_HOUR clamp to GRID_HEIGHT.
 */
export function timeToY(date: Date): number {
  const hours = getHours(date);
  const minutes = getMinutes(date);
  const totalMinutes = (hours - GRID_START_HOUR) * 60 + minutes;
  return Math.min(Math.max(totalMinutes * (HOUR_HEIGHT / 60), 0), GRID_HEIGHT);
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
}

/**
 * Given all pages, returns positioned CalendarBlock[] for `day`.
 * All-day events are excluded (use buildAllDayItems instead).
 * Handles overlap by assigning equal-width column slots.
 */
export function buildDayBlocks(pages: PageSummary[], day: Date): CalendarBlock[] {
  // Filter: must have a timed scheduledStart on this day
  const timed = pages.filter((page) => {
    if (!page.scheduledStart) return false;
    if (isAllDayPage(page.scheduledStart)) return false;
    try {
      const start = parseISO(page.scheduledStart);
      return isSameDay(start, day);
    } catch {
      return false;
    }
  });

  if (timed.length === 0) return [];

  // Build raw blocks
  interface RawBlock {
    endDate: Date;
    height: number;
    isCompact: boolean;
    /** End used only for overlap layout — may differ from endDate for compact blocks */
    overlapEnd: Date;
    page: PageSummary;
    startDate: Date;
    top: number;
  }

  const raws: RawBlock[] = timed.map((page) => {
    const startDate = parseISO(page.scheduledStart!);

    // Determine if compact before computing end
    const hasExplicitEnd = !!page.scheduledEnd;
    const explicitEnd = hasExplicitEnd ? parseISO(page.scheduledEnd!) : null;
    const durationMinutes = explicitEnd
      ? (explicitEnd.getTime() - startDate.getTime()) / 60_000
      : 0;
    const isCompact = !hasExplicitEnd || durationMinutes < MIN_TIMED_MINUTES;

    const endDate = explicitEnd ?? startDate; // endDate = startDate for no-end events
    const top = timeToY(startDate);
    const height = isCompact ? COMPACT_BLOCK_HEIGHT : Math.max(timeToY(endDate) - top, 4);

    // For overlap calculation, compact blocks claim a 15-min footprint
    const overlapEnd = isCompact
      ? new Date(startDate.getTime() + MIN_TIMED_MINUTES * 60_000)
      : endDate;

    return { endDate, height, isCompact, overlapEnd, page, startDate, top };
  });

  // Sort by start time
  raws.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  // Assign overlap columns (greedy sweep-line)
  const columnOverlapEnds: Date[] = [];
  const assignments: number[] = [];

  for (const raw of raws) {
    let assigned = -1;
    for (let col = 0; col < columnOverlapEnds.length; col++) {
      const colEnd = columnOverlapEnds[col];
      if (colEnd !== undefined && colEnd <= raw.startDate) {
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
      const overlaps = raw.startDate < other.overlapEnd && raw.overlapEnd > other.startDate;
      if (overlaps) {
        maxColumn = Math.max(maxColumn, assignments[j]!);
      }
    }
    return {
      column,
      endDate: raw.endDate,
      height: raw.height,
      isCompact: raw.isCompact,
      page: raw.page,
      startDate: raw.startDate,
      top: raw.top,
      totalColumns: maxColumn + 1,
    };
  });

  return blocks;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

/** Minimum block height in px for resize operations — enforces 15-minute minimum. */
export const MIN_RESIZE_HEIGHT = (15 / 60) * HOUR_HEIGHT;

/** Pixel movement threshold before a mousedown is treated as a drag gesture. */
export const DRAG_THRESHOLD = 4;

/**
 * Snaps a raw pixel Y offset to the nearest 15-minute grid line.
 * Does not clamp — use Math.max/min around the call site as needed.
 */
export function snapY(y: number): number {
  const rawMinutes = (y / HOUR_HEIGHT) * 60;
  const snapped = Math.round(rawMinutes / 15) * 15;
  return (snapped / 60) * HOUR_HEIGHT;
}

/**
 * Converts a raw pixel Y offset (from the grid container top) to a Date snapped to
 * the nearest 15-minute boundary on `day`. Clamps to [GRID_START_HOUR, GRID_END_HOUR].
 */
export function yToDate(y: number, day: Date): Date {
  const rawMinutes = (y / HOUR_HEIGHT) * 60 + GRID_START_HOUR * 60;
  const snappedMinutes = Math.round(rawMinutes / 15) * 15;
  const clampedMinutes = Math.min(
    Math.max(snappedMinutes, GRID_START_HOUR * 60),
    GRID_END_HOUR * 60
  );
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
