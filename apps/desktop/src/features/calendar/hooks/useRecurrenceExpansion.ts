// useRecurrenceExpansion — expands rrule-based recurrence rules into virtual
// PageSummary objects for the calendar's visible date range.
//
// Virtual occurrences are merged with real pages so the calendar can render
// them identically. The hook fetches materialised schedule overrides for the
// range and excludes those dates from expansion (legacy: kept for any
// page_schedules rows tagged with ruleId from older builds).

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "@pikos/core";
import { expandRecurrenceForRange, formatDateOnly } from "@pikos/core";
import type { VirtualOccurrence } from "@pikos/core";
import { addDays } from "date-fns";
import { useEffect, useRef, useState } from "react";

interface UseRecurrenceExpansionParams {
  pages: PageSummary[];
  recurrenceRules: PageRecurrenceRule[];
  /** The 7 days currently visible in the week grid. */
  days: Date[];
  /** Fetch materialised schedule rows for a date range. */
  listSchedulesRange: (start: string, end: string) => Promise<PageSchedule[]>;
}

/**
 * Returns pages merged with virtual rrule occurrences for the current week.
 * Virtual occurrences carry `isVirtual: true` for downstream identification.
 */
export function useRecurrenceExpansion({
  days,
  listSchedulesRange,
  pages,
  recurrenceRules,
}: UseRecurrenceExpansionParams): (PageSummary | VirtualOccurrence)[] {
  // Materialised schedules for the visible range, fetched async.
  const [rangeSchedules, setRangeSchedules] = useState<PageSchedule[]>([]);
  const abortRef = useRef(0);

  const rangeStartDate = days[0];
  const lastDay = days[days.length - 1];
  const rangeEndDate = lastDay ? addDays(lastDay, 1) : null;
  const startStr = rangeStartDate ? formatDateOnly(rangeStartDate) : null;
  const endStr = rangeEndDate ? formatDateOnly(rangeEndDate) : null;
  const ruleCount = recurrenceRules.length;

  useEffect(() => {
    if (!startStr || !endStr || ruleCount === 0) return;

    const token = ++abortRef.current;
    void listSchedulesRange(startStr, endStr).then((schedules) => {
      if (token !== abortRef.current) return;
      setRangeSchedules((prev) => {
        if (prev.length === schedules.length && prev.every((p, i) => p.id === schedules[i]?.id)) {
          return prev;
        }
        return schedules;
      });
    });
  }, [startStr, endStr, ruleCount]);

  // No rules → return pages as-is (no virtual occurrences).
  if (recurrenceRules.length === 0) return pages;

  // Compute virtual occurrences synchronously from cached range schedules.
  const rangeStart = days[0];
  const rangeEnd = addDays(days[days.length - 1]!, 1);
  if (!rangeStart || !rangeEnd) return pages;

  const allVirtual: VirtualOccurrence[] = [];

  for (const rule of recurrenceRules) {
    const page = pages.find((p) => p.id === rule.pageId);
    if (!page) continue;

    const ruleSchedules = rangeSchedules.filter((s) => s.ruleId === rule.id);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd, ruleSchedules);

    // Exclude any virtual on or before the head's current date. The head's
    // own date is excluded so the real head block isn't double-rendered;
    // virtuals before the head are excluded so the series visibly tracks
    // the head when the user moves it forward (drag, edit, completion
    // advance). Without this, moving the head from Mon to Wed would
    // resurrect Mon's virtual the next render, since the rule's expansion
    // still emits Mon and only the head's exact date was being filtered.
    const headDate = page.scheduledStart?.slice(0, 10);
    for (const occ of occurrences) {
      if (headDate && occ.originalDate <= headDate) continue;
      allVirtual.push(occ);
    }
  }

  if (allVirtual.length === 0) return pages;
  return [...pages, ...allVirtual];
}
