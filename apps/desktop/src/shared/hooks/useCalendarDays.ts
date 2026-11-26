import {
  buildCalendarDays,
  buildMonthGrid,
  clampDayCount,
  formatDateOnly,
  getCalendarDayCount,
  getLayoutMode,
  monthGridDays,
} from "@pikos/core";
import { isSameDay } from "date-fns";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useCalendarDate } from "@/shared/context/CalendarDateContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useNow } from "@/shared/hooks/useNow";
import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

/** The days the calendar shows: the month's padded grid, or the run of days around its date. */
export function useCalendarDays() {
  const { referenceDate } = useCalendarDate();
  const { weekStart } = useAppSettings();
  const { dayCount: preferredDayCount, viewMode } = useCalendarSettings();
  // User preference wins, but breakpoint caps it — choosing 7 on a narrow window
  // would truncate day columns to unusable widths.
  const dayCount = clampDayCount(
    preferredDayCount,
    getCalendarDayCount(getLayoutMode(useWindowWidth()))
  );
  const isMonth = viewMode === "month";
  // The padded grid (up to 42 days), not the month, so the padding rows get their pages and
  // occurrences too.
  const monthWeeks = buildMonthGrid(referenceDate, weekStart);
  const days = isMonth
    ? monthGridDays(monthWeeks)
    : buildCalendarDays(referenceDate, dayCount, weekStart);

  return { days, isMonth, monthWeeks };
}

/**
 * The `YYYY-MM-DD` the calendar is being looked at on: today while today is on screen, else the
 * day it was moved to. The calendar's date alone would do neither, since it is kept across
 * launches and a week opened on Monday still holds Monday on Wednesday.
 */
export function useCalendarDayInView(): string {
  const { referenceDate } = useCalendarDate();
  const { days } = useCalendarDays();
  const today = useNow();

  const showsToday = days.some((day) => isSameDay(day, today));

  return formatDateOnly(showsToday ? today : referenceDate);
}
