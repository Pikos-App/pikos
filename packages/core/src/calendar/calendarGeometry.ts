import {
  addDays,
  differenceInCalendarDays,
  endOfWeek,
  getHours,
  getMinutes,
  getSeconds,
  set,
  startOfDay,
  startOfWeek,
} from "date-fns";

import {
  ALL_DAY_BAR_HEIGHT,
  ALL_DAY_ROW_HEIGHT,
  ALL_DAY_TOP_PADDING,
  type CalendarCollapseConfig,
  CHIP_STACKED_THRESHOLD,
  COLLAPSED_BAND_HEIGHT,
  HOUR_HEIGHT,
  MAX_BOTTOM_HOUR,
  MAX_TOP_HOUR,
  MIN_BOTTOM_HOUR,
  MIN_TOP_HOUR,
  MIN_VISIBLE_HOURS,
  VISIBLE_HOURS,
} from "./calendarConstants";
import { type CalendarDayCount, type CalendarDensity, DEFAULT_CALENDAR_DENSITY } from "./dayCount";

export interface CalendarMetrics {
  hourHeight: number;
  /**
   * The shortest a timed block renders: a 15-minute slot, however few pixels that is. A pixel
   * floor would draw a block taller than its time, so short items would cascade beside
   * neighbours they don't overlap. A short block drops its time line and then cuts its title
   * instead.
   */
  compactBlockHeight: number;
  gridHeight: number;
  minResizeHeight: number;
  /** The shortest block that can carry a time row under the title, and the shortest that can
   *  give the title a second line. Both scale with the calendar text size: as fixed pixel
   *  counts, a larger text size left content taller than the block and spilled it past the
   *  bottom edge. */
  timeRowMinHeight: number;
  twoLineTitleMinHeight: number;
  /** The shortest block that stacks its title over a time row rather than rendering as a
   *  one-line chip. Scaled for the same reason as the tiers above. */
  stackedBlockMinHeight: number;
  /** The all-day strip's row geometry. Here and not read as constants so it zooms with the
   *  text; fixed, its bars would stay 19px tall while the text inside grew. */
  allDayBarHeight: number;
  allDayRowHeight: number;
  allDayTopPadding: number;
  /** What the calendar is multiplied by, so a pixel threshold can scale with it. */
  zoom: number;
}

// Tuned at the default zoom.
const TIME_ROW_MIN_HEIGHT = 40;
const TWO_LINE_TITLE_MIN_HEIGHT = 52;

// Far below a visible pixel or a millisecond, far above the rounding a zoomed position carries.
const ROUNDING_TOLERANCE = 1e-6;

/**
 * Whether a value derived from block pixels falls short of a threshold, where landing exactly
 * on it is reaching it.
 *
 * Several thresholds sit exactly on a whole quarter-hour (an hour at compact is the time-row
 * bar; an event ending at 10 PM ends on the collapsed band's edge). Zoomed, a height or hour
 * arrives through a subtraction or division and lands a rounding error either side, so a plain
 * `<` treated the same block differently on alternate text sizes.
 */
export function fallsShortOf(value: number, threshold: number): boolean {
  return value < threshold - ROUNDING_TOLERANCE;
}

/**
 * Density picks the hour height; zoom multiplies everything by the same number the text is
 * multiplied by (1 at the default text size).
 *
 * A block's height comes from its duration, so scaling the text alone would grow the contents
 * inside a box that doesn't grow with them. Scaling the hour by the same factor keeps every
 * proportion fixed, so a zoomed calendar is the default one drawn larger. A floor on the hour
 * height can't substitute: it would guarantee a half-hour block, while the shortest is a
 * quarter.
 */
export function computeCalendarMetrics(density: CalendarDensity, zoom = 1): CalendarMetrics {
  const hourHeight = density * zoom;
  return {
    allDayBarHeight: ALL_DAY_BAR_HEIGHT * zoom,
    allDayRowHeight: ALL_DAY_ROW_HEIGHT * zoom,
    allDayTopPadding: ALL_DAY_TOP_PADDING * zoom,
    compactBlockHeight: hourHeight / 4,
    gridHeight: hourHeight * VISIBLE_HOURS,
    hourHeight,
    minResizeHeight: (15 / 60) * hourHeight,
    stackedBlockMinHeight: CHIP_STACKED_THRESHOLD * zoom,
    timeRowMinHeight: TIME_ROW_MIN_HEIGHT * zoom,
    twoLineTitleMinHeight: TWO_LINE_TITLE_MIN_HEIGHT * zoom,
    zoom,
  };
}

/** The shortest block in minutes of the grid: the one metric column assignment reads, handed to
 *  the Rust port in place of pixels. */
export function shortestBlockMinutes(metrics: CalendarMetrics): number {
  return (metrics.compactBlockHeight / metrics.hourHeight) * 60;
}

/** For callers with no settings context. */
export const DEFAULT_METRICS: CalendarMetrics = computeCalendarMetrics(DEFAULT_CALENDAR_DENSITY);

// The grid is drawn in clock hours: the 4 PM row is 16 hour-heights down on every day. A
// clock-change day is 23 or 25 hours long, so a time read off the grid is clock minutes past
// midnight, never elapsed ones. Elapsed minutes from `startOfDay` would put a drop on the 4 PM
// row at 3 PM on a 25-hour day.

/** The instant `minutes` clock minutes past midnight on `day`. 1440 is the next midnight. */
export function atClockMinutes(day: Date, minutes: number): Date {
  const seconds = Math.round(minutes * 60);
  return set(startOfDay(day), {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
  });
}

function clockMinutesOf(date: Date): number {
  return getHours(date) * 60 + getMinutes(date) + getSeconds(date) / 60;
}

/** How far apart two instants are on the clock, which is the span the grid draws. */
export function clockMinutesBetween(start: Date, end: Date): number {
  return differenceInCalendarDays(end, start) * 1440 + clockMinutesOf(end) - clockMinutesOf(start);
}

/** `date` moved `minutes` along the clock. */
export function addClockMinutes(date: Date, minutes: number): Date {
  return atClockMinutes(date, clockMinutesOf(date) + minutes);
}

/** Height of the `+N more` pill inside a collapsed band. The floor keeps it readable on narrow
 * bands, the ceiling stops it dominating tall ones. */
export function collapsedBandPillHeight(bandHeight: number): number {
  return Math.min(20, Math.max(14, bandHeight - 8));
}

/** Padding between a collapsed band's edge and its pill. Blocks straddling the band slip in by
 * this much, so they read as partly in the collapsed time without overlapping the pill. */
export function collapsedBandInnerOffset(bandHeight: number): number {
  return (bandHeight - collapsedBandPillHeight(bandHeight)) / 2;
}

/**
 * Pixel offsets from the grid top for the three regions under a collapse config, computed once
 * so callers don't recompute per block.
 *
 *   [0, topBandHeight)         collapsed top band (or expanded [0, topHour))
 *   [middleStart, middleEnd)   middle region, always 1:1 with hour height
 *   [middleEnd, totalHeight)   collapsed bottom band (or expanded [bottomHour, 24))
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

/** Maps an hour (0..24, fractional ok) to a pixel Y. A collapsed band compresses its hour range
 * linearly into COLLAPSED_BAND_HEIGHT. */
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

/** Inverse of `mapHourToY`. */
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

export function mapDateToY(date: Date, geometry: CollapseGeometry): number {
  const totalHours = getHours(date) + getMinutes(date) / 60;
  return mapHourToY(totalHours, geometry);
}

/**
 * Like `yToDate` on the collapse-aware grid. A Y inside a collapsed band clamps to the band's
 * nearest visible edge, so a drop can't schedule an event into hours the user can't see.
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
  return atClockMinutes(day, clamped);
}

/** `snapY` on the collapse-aware grid. */
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

/** Clamps to [0, 24 * hourHeight]. */
export function timeToY(date: Date, hourHeight: number = HOUR_HEIGHT): number {
  const hours = getHours(date);
  const minutes = getMinutes(date);
  const totalMinutes = hours * 60 + minutes;
  const gridHeight = hourHeight * VISIBLE_HOURS;
  return Math.min(Math.max(totalMinutes * (hourHeight / 60), 0), gridHeight);
}

/** Snaps to the nearest 15-minute grid line. Does not clamp. */
export function snapY(y: number, hourHeight: number = HOUR_HEIGHT): number {
  const rawMinutes = (y / hourHeight) * 60;
  const snapped = Math.round(rawMinutes / 15) * 15;
  return (snapped / 60) * hourHeight;
}

/** The Date on `day` at the nearest 15-minute boundary to `y`, clamped to [00:00, 24:00]. */
export function yToDate(y: number, day: Date, hourHeight: number = HOUR_HEIGHT): Date {
  const rawMinutes = (y / hourHeight) * 60;
  const snappedMinutes = Math.round(rawMinutes / 15) * 15;
  const clampedMinutes = Math.min(Math.max(snappedMinutes, 0), VISIBLE_HOURS * 60);
  return atClockMinutes(day, clampedMinutes);
}

export function weekStart(date: Date, weekStartsOn: 0 | 1 = 1): Date {
  return startOfWeek(date, { weekStartsOn });
}

export function weekDays(date: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const first = weekStart(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The days to render. Seven anchors at the week start, so stepping by weeks keeps the week
 * aligned. "mf" is Monday to Friday of the week containing `date`, Monday-anchored whatever
 * `weekStartsOn`. Fewer than seven starts at `date`, so stepping shows adjacent days without
 * week-boundary jumps.
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
