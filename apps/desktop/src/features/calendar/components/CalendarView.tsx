import {
  buildCalendarDays,
  buildMonthGrid,
  clampDayCount,
  getCalendarDayCount,
  monthGridDays,
  utcInstant,
} from "@pikos/core";
import { addDays, format, isSameDay, startOfDay } from "date-fns";
import { type CSSProperties, useEffect, useState } from "react";

import { useLayoutMode } from "@/features/layout/breakpoints";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import {
  calendarTextScale,
  calendarZoom,
  useCalendarSettings,
} from "@/shared/context/CalendarSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useRecurrenceExpansion } from "@/shared/hooks/useRecurrenceExpansion";
import { useCachedRange } from "@/shared/viewCache/useCachedRange";

import { useCalendarPageCreate } from "../hooks/useCalendarPageCreate";
import { CALENDAR_GUTTER_VAR, CALENDAR_ZOOM_VAR, calendarGutterPx } from "../utils/gutterWidth";
import { MonthGrid } from "./MonthGrid";
import { WeekGrid } from "./WeekGrid";

/**
 * Buffer (days) subtracted from the visible window's first day when fetching
 * completed scheduled pages. `listPages` filters by scheduledStart, so a
 * multi-day event that started before the window but extends into it would
 * otherwise be missed. 31 days covers every realistic multi-day span
 * (vacations, sprints) without ballooning the query.
 */
const COMPLETED_LOOKBACK_DAYS = 31;

/**
 * Reads pages from context (scheduledStart denorm) and expands rrule rules
 * into virtual occurrences. Navigation (prev/next/today) is owned by
 * EditorPanel via UIContext.referenceDate.
 */
export function CalendarView() {
  const {
    deletePage,
    expandRecurrenceRange,
    flushPage,
    getPage,
    listOverridesForRules,
    mergePages,
    overridesVersion,
    pages,
    recurrenceRules,
    rescheduleVirtualOccurrence,
    scheduleOnce,
  } = usePages();
  const { on, storage } = useWorkspace();
  const { openPage, referenceDate, setReferenceDate } = useUI();
  const { hiddenIds } = useUndoDelete();
  const { weekStart } = useAppSettings();
  const {
    dayCount: preferredDayCount,
    setViewMode,
    textSize: calendarTextSize,
    viewMode,
  } = useCalendarSettings();

  const [autoOpenPageId, setAutoOpenPageId] = useState<string | null>(null);
  const { createAllDayPage, createTimedPage } = useCalendarPageCreate(setAutoOpenPageId);

  // A deleted page gives up its claim on the auto-open. The block clears this by
  // reporting its popover closed, and deleting the page from that very popover
  // unmounts the block before it can — which left the id pointing at a page in the
  // trash. Restoring it matched again, so a restore re-opened the naming popover
  // for a page nobody had just made, with the empty-title cleanup still attached to
  // dismissing it.
  useEffect(() => {
    return on("page:deleted", (id) => {
      setAutoOpenPageId((current) => (current === id ? null : current));
    });
  }, [on]);

  // Blur whatever had focus in the editor panel so no focus ring lingers.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const layoutMode = useLayoutMode();
  // User preference wins, but breakpoint caps it — choosing 7 on a narrow window
  // would truncate day columns to unusable widths.
  const dayCount = clampDayCount(preferredDayCount, getCalendarDayCount(layoutMode));
  const isMonth = viewMode === "month";
  // Month view's visible range is the padded grid (up to 42 days), not the
  // month — recurrence expansion and the completed-page fetch below both key
  // off `days`, so the padding rows get their occurrences too.
  const monthWeeks = buildMonthGrid(referenceDate, weekStart);
  const days = isMonth
    ? monthGridDays(monthWeeks)
    : buildCalendarDays(referenceDate, dayCount, weekStart);
  const today = new Date();
  const isCurrentWeek = days.some((d) => isSameDay(d, today));

  // Load completed scheduled pages that overlap the visible range. Active
  // pages are all loaded at init so multi-day spans and navigation Just Work;
  // completed pages are fetched lazily here (and only here) so a user with
  // years of completed history doesn't pay that cost on workspace load.
  // mergePages dedupes across navigations.
  const rangeStart = days[0];
  const rangeEnd = days[days.length - 1];
  const rangeKey =
    rangeStart && rangeEnd
      ? `${format(rangeStart, "yyyy-MM-dd")}|${format(rangeEnd, "yyyy-MM-dd")}`
      : null;
  const cachedRange = useCachedRange(
    rangeStart ? utcInstant(startOfDay(rangeStart)) : null,
    rangeEnd ? utcInstant(startOfDay(addDays(rangeEnd, 1))) : null
  );
  // Until edits are kept beside the cached rows, the in-memory copy carries the unsaved ones.
  const inMemory = cachedRange ? new Map(pages.map((p) => [p.id, p])) : null;
  const visiblePages = (
    cachedRange && inMemory ? cachedRange.map((p) => inMemory.get(p.id) ?? p) : pages
  ).filter((p) => !hiddenIds.has(p.id));
  useEffect(() => {
    if (cachedRange || !storage || !rangeStart || !rangeEnd) return;
    const scheduledAfter = format(addDays(rangeStart, -COMPLETED_LOOKBACK_DAYS), "yyyy-MM-dd");
    const scheduledBefore = format(rangeEnd, "yyyy-MM-dd");
    let cancelled = false;
    void (async () => {
      const completed = await storage.listPages({
        hasSchedule: true,
        scheduledAfter,
        scheduledBefore,
        status: "done",
      });
      if (!cancelled) mergePages(completed);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage, rangeKey, mergePages, rangeStart, rangeEnd]);

  const expandedPages = useRecurrenceExpansion({
    days,
    expandRecurrenceRange,
    listOverridesForRules,
    overridesVersion,
    pages: visiblePages,
    recurrenceRules,
  });

  function handlePageDoubleClick(pageId: string) {
    openPage(pageId);
  }

  /** Month view's only navigation gesture: land on the picked day in the time
   * grid, which is where every scheduling gesture lives. */
  function handleOpenDay(day: Date) {
    setReferenceDate(day);
    setViewMode("time");
  }

  /**
   * Drag-to-reschedule or resize. When `originalDate` is set, the dragged block
   * is a virtual rrule occurrence (which shares the head's id) — calling
   * scheduleOnce here would corrupt the head's denorm. Materialise an
   * independent clone at the new time and exdate the original date, so the
   * head and rule stay intact while the moved occurrence becomes a regular
   * page (with its own status, drag, delete, etc.).
   */
  function handleReschedule(pageId: string, start: string, end?: string, originalDate?: string) {
    if (originalDate) {
      const rule = recurrenceRules.find((r) => r.pageId === pageId);
      if (!rule) return;
      void rescheduleVirtualOccurrence(rule.id, originalDate, start, end);
      return;
    }
    void scheduleOnce(pageId, start, end);
  }

  /**
   * Called after the auto-opened popover closes. If the user never gave the
   * page a title — regardless of close path (Escape, outside click) — delete
   * it so stray blank pages don't pile up. Only an explicit title (or Enter,
   * which commits "Untitled" via PageBlockPopover) keeps the page. We flush
   * any pending debounced title write, then read the persisted page straight
   * from the adapter so we're not racing with React's effect scheduler.
   */
  function handleAutoOpenConsumed() {
    const id = autoOpenPageId;
    setAutoOpenPageId(null);
    if (!id) return;
    void (async () => {
      await flushPage(id);
      const latest = await getPage(id);
      if (latest && !latest.title.trim()) {
        void deletePage(id);
      }
    })();
  }

  return (
    // Overriding `--ui-text-scale` here is what makes the calendar's text size
    // independent of the interface's: everything below inherits the calendar's
    // value, everything above keeps the interface's.
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={
        {
          "--ui-text-scale": calendarTextScale(calendarTextSize),
          [CALENDAR_GUTTER_VAR]: `${calendarGutterPx(calendarTextScale(calendarTextSize))}px`,
          [CALENDAR_ZOOM_VAR]: calendarZoom(calendarTextSize),
        } as CSSProperties
      }
    >
      {isMonth ? (
        <MonthGrid
          onOpenDay={handleOpenDay}
          onPageDoubleClick={handlePageDoubleClick}
          pages={expandedPages}
          weeks={monthWeeks}
        />
      ) : (
        <WeekGrid
          autoOpenPageId={autoOpenPageId}
          days={days}
          isCurrentWeek={isCurrentWeek}
          onAutoOpenConsumed={handleAutoOpenConsumed}
          onCreateAllDay={createAllDayPage}
          onCreatePage={(_day, start, end) => createTimedPage(start, end)}
          onPageDoubleClick={handlePageDoubleClick}
          onReschedule={handleReschedule}
          pages={expandedPages}
        />
      )}
    </div>
  );
}
