import {
  buildCalendarDays,
  buildMonthGrid,
  clampDayCount,
  getCalendarDayCount,
  monthGridDays,
  utcInstant,
} from "@pikos/core";
import { addDays, startOfDay } from "date-fns";
import { useEffect } from "react";

import { useLayoutMode } from "@/features/layout/breakpoints";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useCalendarDate } from "@/shared/context/CalendarDateContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import {
  useCalendarExpansionHold,
  useViewCacheController,
} from "@/shared/context/WorkspaceContext";
import { usePreloadRecurrenceExpansion } from "@/shared/hooks/useRecurrenceExpansion";
import type { Range } from "@/shared/viewCache/controller";

/** The days the calendar shows, and the range of instants it reads them from. */
export function useCalendarRange() {
  const { referenceDate } = useCalendarDate();
  const { weekStart } = useAppSettings();
  const { dayCount: preferredDayCount, viewMode } = useCalendarSettings();
  // User preference wins, but breakpoint caps it — choosing 7 on a narrow window
  // would truncate day columns to unusable widths.
  const dayCount = clampDayCount(preferredDayCount, getCalendarDayCount(useLayoutMode()));
  const isMonth = viewMode === "month";
  // The padded grid (up to 42 days), not the month, so the padding rows get their pages and
  // occurrences too.
  const monthWeeks = buildMonthGrid(referenceDate, weekStart);
  const days = isMonth
    ? monthGridDays(monthWeeks)
    : buildCalendarDays(referenceDate, dayCount, weekStart);

  const rangeStart = days[0];
  const rangeEnd = days[days.length - 1];
  // A week or less also holds the range a step either side; a month's neighbours would be large.
  const stepDays = days.length <= 7 ? days.length : 0;
  const instants = (shift: number): Range | null =>
    rangeStart && rangeEnd
      ? [
          utcInstant(startOfDay(addDays(rangeStart, shift))),
          utcInstant(startOfDay(addDays(rangeEnd, shift + 1))),
        ]
      : null;
  const shown = instants(0);
  const neighbours =
    stepDays > 0 ? [instants(-stepDays), instants(stepDays)].flatMap((r) => (r ? [r] : [])) : [];

  return { days, isMonth, monthWeeks, neighbours, shown, stepDays };
}

/** Loads the calendar's range and its repeating occurrences while it is hidden, where its own
 *  effects don't run, so its first open after launch draws the blocks with the grid rather than a
 *  fetch later. */
export function usePreloadCalendarRange(): void {
  const controller = useViewCacheController();
  const { days, shown, stepDays } = useCalendarRange();
  const { expandRecurrenceRange, listOverridesForRules, overridesVersion, recurrenceRules } =
    usePages();
  usePreloadRecurrenceExpansion({
    days,
    expandRecurrenceRange,
    hold: useCalendarExpansionHold(),
    listOverridesForRules,
    margin: stepDays,
    overridesVersion,
    recurrenceRules,
  });
  const start = shown?.[0];
  const end = shown?.[1];

  useEffect(() => {
    if (controller && start && end) controller.preloadRange(start, end);
  }, [controller, start, end]);
}
