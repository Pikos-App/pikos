// CalendarSettingsContext — day count, density, and collapsed-time-band
// preferences for the calendar panel. All persisted to localStorage.
// Consumed by CalendarView + WeekGrid + children.

import { createContext, type ReactNode, useCallback, useContext } from "react";

import {
  buildCollapseGeometry,
  type CalendarCollapseConfig,
  type CalendarDayCount,
  type CalendarDensity,
  type CalendarMetrics,
  clampBottomHour,
  clampTopHour,
  type CollapseGeometry,
  computeCalendarMetrics,
  DEFAULT_COLLAPSE_CONFIG,
} from "@/features/calendar/utils/calendarUtils";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { CalendarDayCount };

export interface CalendarSettingsValue {
  dayCount: CalendarDayCount;
  setDayCount: (v: CalendarDayCount) => void;
  density: CalendarDensity;
  setDensity: (v: CalendarDensity) => void;
  /** Derived from density — convenient so callers don't recompute. */
  metrics: CalendarMetrics;
  /** Pixel layout of the collapsible bands at the current hourHeight. */
  geometry: CollapseGeometry;
  /** Collapsed-time-band state. See CalendarCollapseConfig. */
  collapse: CalendarCollapseConfig;
  setTopCollapsed: (v: boolean) => void;
  setBottomCollapsed: (v: boolean) => void;
  setTopHour: (v: number) => void;
  setBottomHour: (v: number) => void;
}

export const CalendarSettingsContext = createContext<CalendarSettingsValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CalendarSettingsProvider({ children }: { children: ReactNode }) {
  const [dayCount, setDayCount] = useLocalStorage<CalendarDayCount>("pikos:calendarDayCount", 7);
  const [density, setDensity] = useLocalStorage<CalendarDensity>("pikos:calendarDensity", "normal");
  const [topCollapsed, setTopCollapsedRaw] = useLocalStorage<boolean>(
    "pikos:calendarTopCollapsed",
    DEFAULT_COLLAPSE_CONFIG.topCollapsed
  );
  const [bottomCollapsed, setBottomCollapsedRaw] = useLocalStorage<boolean>(
    "pikos:calendarBottomCollapsed",
    DEFAULT_COLLAPSE_CONFIG.bottomCollapsed
  );
  const [topHour, setTopHourRaw] = useLocalStorage<number>(
    "pikos:calendarTopHour",
    DEFAULT_COLLAPSE_CONFIG.topHour
  );
  const [bottomHour, setBottomHourRaw] = useLocalStorage<number>(
    "pikos:calendarBottomHour",
    DEFAULT_COLLAPSE_CONFIG.bottomHour
  );

  const metrics = computeCalendarMetrics(density);
  const collapse: CalendarCollapseConfig = {
    bottomCollapsed,
    bottomHour,
    topCollapsed,
    topHour,
  };
  const geometry = buildCollapseGeometry(collapse, metrics.hourHeight);

  const setTopHour = useCallback(
    (v: number) => setTopHourRaw(clampTopHour(v, bottomHour)),
    [bottomHour, setTopHourRaw]
  );
  const setBottomHour = useCallback(
    (v: number) => setBottomHourRaw(clampBottomHour(v, topHour)),
    [topHour, setBottomHourRaw]
  );

  const value: CalendarSettingsValue = {
    collapse,
    dayCount,
    density,
    geometry,
    metrics,
    setBottomCollapsed: setBottomCollapsedRaw,
    setBottomHour,
    setDayCount,
    setDensity,
    setTopCollapsed: setTopCollapsedRaw,
    setTopHour,
  };

  return (
    <CalendarSettingsContext.Provider value={value}>{children}</CalendarSettingsContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useCalendarSettings(): CalendarSettingsValue {
  const ctx = useContext(CalendarSettingsContext);
  if (!ctx) throw new Error("useCalendarSettings must be used within <CalendarSettingsProvider>");
  return ctx;
}
