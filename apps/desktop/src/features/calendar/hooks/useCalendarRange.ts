import { utcInstant } from "@pikos/core";
import { addDays, startOfDay } from "date-fns";
import { useEffect } from "react";

import { usePages } from "@/shared/context/PagesContext";
import {
  useCalendarExpansionHold,
  useViewCacheController,
} from "@/shared/context/WorkspaceContext";
import { useCalendarDays } from "@/shared/hooks/useCalendarDays";
import { usePreloadRecurrenceExpansion } from "@/shared/hooks/useRecurrenceExpansion";
import type { Range } from "@/shared/viewCache/controller";

/** The days the calendar shows, and the range of instants it reads them from. */
export function useCalendarRange() {
  const { days, isMonth, monthWeeks } = useCalendarDays();

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
