import { createContext, type ReactNode, useContext, useState } from "react";

import {
  type CalendarCollapseConfig,
  DEFAULT_COLLAPSE_CONFIG,
} from "@/features/calendar/utils/calendarConstants";
import {
  buildCollapseGeometry,
  type CalendarMetrics,
  clampBottomHour,
  clampTopHour,
  type CollapseGeometry,
  computeCalendarMetrics,
} from "@/features/calendar/utils/calendarGeometry";
import type { CalendarDayCount, CalendarDensity } from "@/shared/constants/calendar";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

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
  /** Which collapsed band the cursor is hovering, if any. Synced across the
   * gutter chevron button and every day-column band overlay so hovering one
   * lights up the entire band as a single click target. */
  hoveredBand: "top" | "bottom" | null;
  setHoveredBand: (v: "top" | "bottom" | null) => void;
}

export const CalendarSettingsContext = createContext<CalendarSettingsValue | null>(null);

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

  const setTopHour = (v: number) => setTopHourRaw(clampTopHour(v, bottomHour));
  const setBottomHour = (v: number) => setBottomHourRaw(clampBottomHour(v, topHour));

  // Ephemeral, not persisted — pointer-tracking state for the band hover sync.
  const [hoveredBand, setHoveredBand] = useState<"top" | "bottom" | null>(null);

  const value: CalendarSettingsValue = {
    collapse,
    dayCount,
    density,
    geometry,
    hoveredBand,
    metrics,
    setBottomCollapsed: setBottomCollapsedRaw,
    setBottomHour,
    setDayCount,
    setDensity,
    setHoveredBand,
    setTopCollapsed: setTopCollapsedRaw,
    setTopHour,
  };

  return (
    <CalendarSettingsContext.Provider value={value}>{children}</CalendarSettingsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCalendarSettings(): CalendarSettingsValue {
  const ctx = useContext(CalendarSettingsContext);
  if (!ctx) throw new Error("useCalendarSettings must be used within <CalendarSettingsProvider>");
  return ctx;
}
