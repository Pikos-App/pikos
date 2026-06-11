// Hour ↔ pixel mapping for the calendar grid. The "collapse geometry" pre-
// computes pixel bounds for the three vertical regions (top band / middle /
// bottom band) so callers don't recompute on every block.

import {
  addDays,
  addMinutes,
  endOfWeek,
  getHours,
  getMinutes,
  startOfDay,
  startOfWeek,
} from "date-fns";

import type { CalendarDayCount, CalendarDensity } from "@/shared/constants/calendar";

import {
  type CalendarCollapseConfig,
  COLLAPSED_BAND_HEIGHT,
  HOUR_HEIGHT,
  MAX_BOTTOM_HOUR,
  MAX_TOP_HOUR,
  MIN_BOTTOM_HOUR,
  MIN_TOP_HOUR,
  MIN_VISIBLE_HOURS,
  VISIBLE_HOURS,
} from "./calendarConstants";

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

// ─── Collapse geometry helpers ───────────────────────────────────────────────
// The calendar can hide the early-morning ([0, topHour)) and late-evening
// ([bottomHour, 24)) ranges behind small fixed-height bands so the readable
// "waking hours" middle dominates the viewport. Each band is independently
// toggleable; bounds X = topHour and Y = bottomHour are user-adjustable when
// the band is expanded (drag handle in the gutter).

/** Pixel height of the `+N more` pill rendered inside a collapsed band. Floor
 * keeps the chip readable on narrow bands; ceiling stops it from dominating
 * tall ones. The pill is centered, so the gap above and below is
 * `(bandHeight - pillHeight) / 2` — straddling blocks anchor to that gap so
 * they emerge just past the pill edge. */
export function collapsedBandPillHeight(bandHeight: number): number {
  return Math.min(20, Math.max(14, bandHeight - 8));
}

/** Vertical padding between a collapsed band's edge and its `+N more` pill —
 * also the offset that straddling blocks slip into the band by, so they read
 * as "partially in the collapsed time" without overlapping the pill. */
export function collapsedBandInnerOffset(bandHeight: number): number {
  return (bandHeight - collapsedBandPillHeight(bandHeight)) / 2;
}

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

export function clampTopHour(value: number, bottomHour: number): number {
  const max = Math.min(MAX_TOP_HOUR, bottomHour - MIN_VISIBLE_HOURS);
  return Math.max(MIN_TOP_HOUR, Math.min(max, value));
}

export function clampBottomHour(value: number, topHour: number): number {
  const min = Math.max(MIN_BOTTOM_HOUR, topHour + MIN_VISIBLE_HOURS);
  return Math.min(MAX_BOTTOM_HOUR, Math.max(min, value));
}

// ─── Linear time → pixel (no collapse) ───────────────────────────────────────

/** Clamps to [0, 24 * hourHeight]. */
export function timeToY(date: Date, hourHeight: number = HOUR_HEIGHT): number {
  const hours = getHours(date);
  const minutes = getMinutes(date);
  const totalMinutes = hours * 60 + minutes;
  const gridHeight = hourHeight * VISIBLE_HOURS;
  return Math.min(Math.max(totalMinutes * (hourHeight / 60), 0), gridHeight);
}

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

export function weekStart(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  return startOfWeek(date, { weekStartsOn });
}

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

export function weekEnd(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  return endOfWeek(date, { weekStartsOn });
}
