// CalendarSettingsContext — day count and density preferences for the calendar panel.
// Persisted to localStorage. Consumed by CalendarView + WeekGrid + children.

import { createContext, type ReactNode, useContext } from "react";

import {
  type CalendarDayCount,
  type CalendarDensity,
  type CalendarMetrics,
  computeCalendarMetrics,
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
}

export const CalendarSettingsContext = createContext<CalendarSettingsValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CalendarSettingsProvider({ children }: { children: ReactNode }) {
  const [dayCount, setDayCount] = useLocalStorage<CalendarDayCount>("pikos:calendarDayCount", 7);
  const [density, setDensity] = useLocalStorage<CalendarDensity>("pikos:calendarDensity", "normal");

  const metrics = computeCalendarMetrics(density);

  const value: CalendarSettingsValue = {
    dayCount,
    density,
    metrics,
    setDayCount,
    setDensity,
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
