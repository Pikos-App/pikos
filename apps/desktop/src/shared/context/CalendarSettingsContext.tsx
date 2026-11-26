import type {
  CalendarCollapseConfig,
  CalendarDayCount,
  CalendarDensity,
  CalendarMetrics,
  CalendarViewMode,
  CollapseGeometry,
} from "@pikos/core";
import {
  buildCollapseGeometry,
  clampBottomHour,
  clampTopHour,
  computeCalendarMetrics,
  DEFAULT_CALENDAR_DENSITY,
  DEFAULT_COLLAPSE_CONFIG,
  stepCalendarDensity,
  toCalendarDensity,
} from "@pikos/core";
import { useState } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { stepTextSize, TEXT_SIZES, type TextSize } from "@/shared/context/textSizes";
/** Event-title sizes in px, ascending. The calendar names a px like the editor, not a word like the
 *  interface: both have one body size everything else is relative to and the interface has none.
 *  13 is `type-body-sm`, the default event-title size. */
export const CALENDAR_TEXT_SIZES = TEXT_SIZES;

export type CalendarTextSize = TextSize;

export const DEFAULT_CALENDAR_TEXT_SIZE: CalendarTextSize = 14;

/** The default event-title size (`type-body-sm`), which a chosen px is measured against. Not on
 *  the ladder: the editor's rungs are. */
const CALENDAR_TEXT_BASE = 13;

/** The multiplier the CSS wants, against the default title size. Derived rather than stored, so
 *  the stored value stays the number the setting shows. */
export function calendarTextScale(size: CalendarTextSize): number {
  return size / CALENDAR_TEXT_BASE;
}

/** How much larger the calendar is than the default, which the hour height is multiplied by.
 *  Measured against the default size, not the type baseline, so only a changed setting moves the
 *  default calendar. Text grows by the same factor so nothing inside a block can outgrow it. */
export function calendarZoom(size: CalendarTextSize): number {
  return size / DEFAULT_CALENDAR_TEXT_SIZE;
}

export const stepCalendarTextSize = stepTextSize;
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type { CalendarDayCount, CalendarViewMode };

export interface CalendarSettingsValue {
  dayCount: CalendarDayCount;
  setDayCount: (v: CalendarDayCount) => void;
  /** Which shape the calendar renders. Persisted beside `dayCount`, not inside it, so switching to
   * month view and back restores the user's day count untouched. */
  viewMode: CalendarViewMode;
  setViewMode: (v: CalendarViewMode) => void;
  density: CalendarDensity;
  setDensity: (v: CalendarDensity) => void;
  stepDensity: (direction: 1 | -1) => void;
  /** Event-title size in px, independent of the interface text size. Raising it raises
   *  `metrics.hourHeight` when the text would otherwise be taller than its block. */
  textSize: CalendarTextSize;
  setTextSize: (v: CalendarTextSize) => void;
  stepTextSize: (direction: 1 | -1) => void;
  metrics: CalendarMetrics;
  geometry: CollapseGeometry;
  collapse: CalendarCollapseConfig;
  setTopCollapsed: (v: boolean) => void;
  setBottomCollapsed: (v: boolean) => void;
  setTopHour: (v: number) => void;
  setBottomHour: (v: number) => void;
  /** Which collapsed band the cursor is hovering, synced across the gutter chevron and every
   * day-column band overlay so hovering one lights up the whole band as a single click target. */
  hoveredBand: "top" | "bottom" | null;
  setHoveredBand: (v: "top" | "bottom" | null) => void;
}

function useCalendarSettingsValue(): CalendarSettingsValue {
  const [dayCount, setDayCount] = useLocalStorage<CalendarDayCount>(
    STORAGE_KEYS.calendarDayCount,
    7
  );
  const [viewMode, setViewMode] = useLocalStorage<CalendarViewMode>(
    STORAGE_KEYS.calendarViewMode,
    "time"
  );
  const [storedDensity, setStoredDensity] = useLocalStorage<unknown>(
    STORAGE_KEYS.calendarDensity,
    DEFAULT_CALENDAR_DENSITY
  );
  const density = toCalendarDensity(storedDensity);
  const [textSize, setTextSize] = useLocalStorage<CalendarTextSize>(
    STORAGE_KEYS.calendarTextSize,
    DEFAULT_CALENDAR_TEXT_SIZE
  );
  const [topCollapsed, setTopCollapsedRaw] = useLocalStorage<boolean>(
    STORAGE_KEYS.calendarTopCollapsed,
    DEFAULT_COLLAPSE_CONFIG.topCollapsed
  );
  const [bottomCollapsed, setBottomCollapsedRaw] = useLocalStorage<boolean>(
    STORAGE_KEYS.calendarBottomCollapsed,
    DEFAULT_COLLAPSE_CONFIG.bottomCollapsed
  );
  const [topHour, setTopHourRaw] = useLocalStorage<number>(
    STORAGE_KEYS.calendarTopHour,
    DEFAULT_COLLAPSE_CONFIG.topHour
  );
  const [bottomHour, setBottomHourRaw] = useLocalStorage<number>(
    STORAGE_KEYS.calendarBottomHour,
    DEFAULT_COLLAPSE_CONFIG.bottomHour
  );

  const metrics = computeCalendarMetrics(density, calendarZoom(textSize));
  const collapse: CalendarCollapseConfig = {
    bottomCollapsed,
    bottomHour,
    topCollapsed,
    topHour,
  };
  const geometry = buildCollapseGeometry(collapse, metrics.hourHeight);

  const setTopHour = (v: number) => setTopHourRaw(clampTopHour(v, bottomHour));
  const setBottomHour = (v: number) => setBottomHourRaw(clampBottomHour(v, topHour));

  const [hoveredBand, setHoveredBand] = useState<"top" | "bottom" | null>(null);

  return {
    collapse,
    dayCount,
    density,
    geometry,
    hoveredBand,
    metrics,
    setBottomCollapsed: setBottomCollapsedRaw,
    setBottomHour,
    setDayCount,
    setDensity: setStoredDensity,
    setHoveredBand,
    setTextSize,
    setTopCollapsed: setTopCollapsedRaw,
    setTopHour,
    setViewMode,
    stepDensity: (direction) =>
      setStoredDensity((prev: unknown) => stepCalendarDensity(toCalendarDensity(prev), direction)),
    stepTextSize: (direction) => setTextSize((prev) => stepCalendarTextSize(prev, direction)),
    textSize,
    viewMode,
  };
}

const calendarSettings = createSettingsContext("CalendarSettings", useCalendarSettingsValue);

export const CalendarSettingsContext = calendarSettings.Context;
export const CalendarSettingsProvider = calendarSettings.Provider;
export const useCalendarSettings = calendarSettings.useSettings;
