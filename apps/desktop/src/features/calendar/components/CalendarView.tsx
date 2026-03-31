// CalendarView — right panel calendar mode.
// Reads pages from WorkspaceContext (scheduledStart denorm), renders week view.
// Navigation (prev/next/today) is owned by EditorPanel via UIContext.referenceDate.

import { format, isSameWeek } from "date-fns";
import { useEffect, useState } from "react";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { weekDays } from "../utils/calendarUtils";
import { WeekGrid } from "./WeekGrid";

export function CalendarView() {
  const { createPage, deletePage, pages, scheduleOnce, updatePage } = useWorkspace();
  const { activeViewId, openPage, referenceDate } = useUI();
  const { hiddenIds } = useUndoDelete();
  const { defaultFolderId: settingsDefaultFolder, weekStart } = useAppSettings();
  const visiblePages = pages.filter((p) => !hiddenIds.has(p.id));

  // ID of the page currently being inline-edited after calendar creation.
  const [editingPageId, setEditingPageId] = useState<string | null>(null);

  // Blur whatever had focus in the editor panel so no focus ring lingers.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const days = weekDays(referenceDate, weekStart);
  const isCurrentWeek = isSameWeek(referenceDate, new Date(), { weekStartsOn: weekStart });

  // Double-click on a PageBlock opens the page in the editor.
  function handlePageDoubleClick(pageId: string) {
    openPage(pageId);
  }

  // Click or drag on an empty time slot → create page + enter inline editing.
  async function handleCreatePage(day: Date, start: Date, end?: Date) {
    // Default folder: active folder, then settings default, then Inbox.
    const folderId =
      activeViewId === "today" || activeViewId === "inbox" ? settingsDefaultFolder : activeViewId;

    const page = await createPage({ folderId });
    // Use local-time format (no Z suffix) — SQLite's date() functions require this.
    const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");
    await scheduleOnce(page.id, fmt(start), end ? fmt(end) : undefined);
    setEditingPageId(page.id);
  }

  // Click on an empty all-day column → create all-day page for that date.
  async function handleCreateAllDay(day: Date) {
    const folderId = activeViewId === "today" || activeViewId === "inbox" ? null : activeViewId;
    const page = await createPage({ folderId });
    // Date-only string → isAllDayPage() returns true.
    await scheduleOnce(page.id, format(day, "yyyy-MM-dd"));
    setEditingPageId(page.id);
  }

  // Inline title committed — save if non-empty, delete if empty.
  function handleCommitTitle(pageId: string, title: string) {
    setEditingPageId(null);
    if (title.trim()) {
      updatePage(pageId, { title: title.trim() });
    } else {
      void deletePage(pageId);
    }
  }

  // Inline title cancelled — delete the page.
  function handleCancelCreate(pageId: string) {
    setEditingPageId(null);
    void deletePage(pageId);
  }

  // Drag-to-reschedule or resize: update the schedule in place.
  function handleReschedule(pageId: string, start: string, end?: string) {
    void scheduleOnce(pageId, start, end);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WeekGrid
        days={days}
        editingPageId={editingPageId}
        isCurrentWeek={isCurrentWeek}
        onCancelCreate={handleCancelCreate}
        onCommitTitle={handleCommitTitle}
        onCreateAllDay={handleCreateAllDay}
        onCreatePage={handleCreatePage}
        onPageDoubleClick={handlePageDoubleClick}
        onReschedule={handleReschedule}
        pages={visiblePages}
      />
    </div>
  );
}
