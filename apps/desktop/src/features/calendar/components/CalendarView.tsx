// CalendarView — right panel calendar mode.
// Reads pages from WorkspaceContext (scheduledStart denorm), renders week view.
// Expands rrule recurrence rules into virtual occurrences for the visible week.
// Navigation (prev/next/today) is owned by EditorPanel via UIContext.referenceDate.

import { format, isSameDay } from "date-fns";
import { useEffect, useState } from "react";

import { getCalendarDayCount, useLayoutMode } from "@/features/layout/breakpoints";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { useRecurrenceExpansion } from "../hooks/useRecurrenceExpansion";
import { buildCalendarDays } from "../utils/calendarUtils";
import { WeekGrid } from "./WeekGrid";

export function CalendarView() {
  const {
    createPage,
    deletePage,
    flushPage,
    getPage,
    listSchedulesRange,
    pages,
    recurrenceRules,
    scheduleOnce,
  } = useWorkspace();
  const { activeViewId, openPage, referenceDate } = useUI();
  const { hiddenIds } = useUndoDelete();
  const { defaultFolderId: settingsDefaultFolder, weekStart } = useAppSettings();
  const visiblePages = pages.filter((p) => !hiddenIds.has(p.id));

  // ID of the page that should auto-open its metadata popover after calendar creation.
  const [autoOpenPageId, setAutoOpenPageId] = useState<string | null>(null);

  // Blur whatever had focus in the editor panel so no focus ring lingers.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const layoutMode = useLayoutMode();
  const dayCount = getCalendarDayCount(layoutMode);
  const days = buildCalendarDays(referenceDate, dayCount, weekStart);
  const today = new Date();
  const isCurrentWeek = days.some((d) => isSameDay(d, today));

  // Expand rrule recurrence rules into virtual calendar occurrences for this week.
  const expandedPages = useRecurrenceExpansion({
    days,
    listSchedulesRange,
    pages: visiblePages,
    recurrenceRules,
  });

  // Double-click on a PageBlock opens the page in the editor.
  function handlePageDoubleClick(pageId: string) {
    openPage(pageId);
  }

  // Click or drag on an empty time slot → create page + auto-open its metadata popover.
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

  // Click on an empty all-day column → create all-day page for that date.
  async function handleCreateAllDay(day: Date) {
    const folderId = activeViewId === "today" || activeViewId === "inbox" ? null : activeViewId;
    const page = await createPage({ folderId });
    // Date-only string → isAllDayPage() returns true.
    await scheduleOnce(page.id, format(day, "yyyy-MM-dd"));
    setAutoOpenPageId(page.id);
  }

  // Drag-to-reschedule or resize: update the schedule in place.
  function handleReschedule(pageId: string, start: string, end?: string) {
    void scheduleOnce(pageId, start, end);
  }

  // Called after the auto-opened popover closes. If the user never gave the
  // page a title — regardless of close path (Escape, outside click) — delete
  // it so stray blank pages don't pile up. Only an explicit title (or Enter,
  // which commits "Untitled" via PageBlockPopover) keeps the page. We flush
  // any pending debounced title write, then read the persisted page straight
  // from the adapter so we're not racing with React's effect scheduler.
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
