// useRecurrenceExpansion — expands rrule-based recurrence rules into virtual
// PageSummary objects for the calendar's visible date range.
//
// Virtual occurrences are merged with real pages so the calendar can render
// them identically. The hook fetches materialised schedule overrides for the
// range and excludes those dates from expansion.

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "@pikos/core";
import { expandRecurrenceForRange } from "@pikos/core";
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

  // Fetch range schedules when the visible week or rules change.
  useEffect(() => {
    if (recurrenceRules.length === 0) return;

    const rangeStart = days[0];
    const rangeEnd = addDays(days[days.length - 1]!, 1);
    if (!rangeStart || !rangeEnd) return;

    const token = ++abortRef.current;
    const startStr = formatDate(rangeStart);
    const endStr = formatDate(rangeEnd);

    void listSchedulesRange(startStr, endStr).then((schedules) => {
      if (token !== abortRef.current) return;

      setRangeSchedules(schedules);
    });
  }, [days, recurrenceRules, listSchedulesRange]);

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
    allVirtual.push(...occurrences);
  }

  if (allVirtual.length === 0) return pages;
  return [...pages, ...allVirtual];
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
