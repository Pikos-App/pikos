import { addDays, format, isSameDay } from "date-fns";
import { useEffect, useState } from "react";

import { getCalendarDayCount, useLayoutMode } from "@/features/layout/breakpoints";
import { clampDayCount } from "@/shared/constants/calendar";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { useRecurrenceExpansion } from "../hooks/useRecurrenceExpansion";
import { buildCalendarDays } from "../utils/calendarGeometry";
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
    createPage,
    deletePage,
    flushPage,
    getPage,
    listSchedulesRange,
    mergePages,
    pages,
    recurrenceRules,
    rescheduleVirtualOccurrence,
    scheduleOnce,
  } = usePages();
  const { storage } = useWorkspace();
  const { activeViewId, openPage, referenceDate } = useUI();
  const { hiddenIds } = useUndoDelete();
  const { defaultFolderId: settingsDefaultFolder, weekStart } = useAppSettings();
  const { dayCount: preferredDayCount } = useCalendarSettings();
  const visiblePages = pages.filter((p) => !hiddenIds.has(p.id));

  const [autoOpenPageId, setAutoOpenPageId] = useState<string | null>(null);

  // Blur whatever had focus in the editor panel so no focus ring lingers.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const layoutMode = useLayoutMode();
  // User preference wins, but breakpoint caps it — choosing 7 on a narrow window
  // would truncate day columns to unusable widths.
  const dayCount = clampDayCount(preferredDayCount, getCalendarDayCount(layoutMode));
  const days = buildCalendarDays(referenceDate, dayCount, weekStart);
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
  useEffect(() => {
    if (!storage || !rangeStart || !rangeEnd) return;
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
    listSchedulesRange,
    pages: visiblePages,
    recurrenceRules,
  });

  function handlePageDoubleClick(pageId: string) {
    openPage(pageId);
  }

  async function handleCreatePage(day: Date, start: Date, end?: Date) {
    // Default folder: active folder, then settings default, then Inbox.
    const folderId =
      activeViewId === "today" || activeViewId === "inbox" ? settingsDefaultFolder : activeViewId;

    const page = await createPage({ folderId });
    // Use local-time format (no Z suffix) — SQLite's date() functions require this.
    const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");
    await scheduleOnce(page.id, fmt(start), end ? fmt(end) : undefined);
    setAutoOpenPageId(page.id);
  }

  /** `end` is undefined for a single-day click; set by the drag-to-create
   * gesture for a multi-day span. */
  async function handleCreateAllDay(start: Date, end?: Date) {
    const folderId = activeViewId === "today" || activeViewId === "inbox" ? null : activeViewId;
    const page = await createPage({ folderId });
    // Date-only strings → isAllDayPage() returns true.
    await scheduleOnce(
      page.id,
      format(start, "yyyy-MM-dd"),
      end ? format(end, "yyyy-MM-dd") : undefined
    );
    setAutoOpenPageId(page.id);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <WeekGrid
        autoOpenPageId={autoOpenPageId}
        days={days}
        isCurrentWeek={isCurrentWeek}
        onAutoOpenConsumed={handleAutoOpenConsumed}
        onCreateAllDay={handleCreateAllDay}
        onCreatePage={handleCreatePage}
        onPageDoubleClick={handlePageDoubleClick}
        onReschedule={handleReschedule}
        pages={expandedPages}
      />
    </div>
  );
}
