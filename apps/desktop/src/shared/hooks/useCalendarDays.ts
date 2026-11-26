import {
  buildCalendarDays,
  buildMonthGrid,
  type CalendarDayCount,
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
import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";
import { useNow } from "@/shared/hooks/useNow";
import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

/**
 * The days the time grid shows: the preferred count, capped by what the window can hold.
 * The grid and the header's arrows both read it, so a step never skips the days not shown.
 *
 * The window is judged at its width in 100% interface text, since the breakpoints were set for
 * panels at 100% and the sidebar and page list grow with the text while the calendar takes what is
 * left. Judged on the raw width, 200% text kept seven days in a calendar squeezed to its minimum.
 */
export function useCalendarDayCount(): CalendarDayCount {
  const { dayCount: preferredDayCount } = useCalendarSettings();
  const { textScale } = useInterfaceSettings();
  const widthAtBaseText = useWindowWidth() / textScale;

  return clampDayCount(preferredDayCount, getCalendarDayCount(getLayoutMode(widthAtBaseText)));
}

/** The days the calendar shows: the month's padded grid, or the run of days around its date. */
export function useCalendarDays() {
  const { referenceDate } = useCalendarDate();
  const { weekStart } = useAppSettings();
  const { viewMode } = useCalendarSettings();
  const dayCount = useCalendarDayCount();
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
