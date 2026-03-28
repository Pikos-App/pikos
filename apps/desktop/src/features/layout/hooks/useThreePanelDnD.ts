import {
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Folder, PageSummary } from "@pikos/core";
import { parseLocalISO } from "@pikos/core";
import { format } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { getVisiblePages, sortPages } from "@/features/pages";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/** Returns the duration in ms for a timed page schedule, or undefined for all-day/unscheduled. */
function getPageDurationMs(page: PageSummary): number | undefined {
  if (!page.scheduledStart?.includes("T") || !page.scheduledEnd) return undefined;
  const ms =
    parseLocalISO(page.scheduledEnd).getTime() - parseLocalISO(page.scheduledStart).getTime();
  return ms > 0 ? ms : undefined;
}

export function useThreePanelDnD() {
  const { folders, pages, reorderFolders, reorderPages, scheduleOnce, updatePage } = useWorkspace();
  const { activeViewId, callExternalDragUpdater, getSortMode, setIsDraggingOverCalendar } = useUI();

  const [activePageData, setActivePageData] = useState<PageSummary | null>(null);
  const [activeFolderData, setActiveFolderData] = useState<Folder | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Refs kept current each render so the mousemove closure never goes stale.
  const activePageDataRef = useRef<PageSummary | null>(null);
  const foldersRef = useRef(folders);
  const callExternalDragUpdaterRef = useRef(callExternalDragUpdater);
  useEffect(() => {
    foldersRef.current = folders;
  });
  useEffect(() => {
    callExternalDragUpdaterRef.current = callExternalDragUpdater;
  });

  // ISO start string captured from the last mousemove that was over the calendar.
  // Read in handleDragEnd to decide whether to schedule or reorder.
  const calendarStartRef = useRef<string | null>(null);
  // Tracks whether cursor is currently over the calendar to avoid redundant state updates.
  const overCalendarRef = useRef(false);

  // While a page is being dragged, track cursor position and update the
  // WeekGrid ghost preview via callExternalDragUpdater.
  useEffect(() => {
    if (!activePageData) {
      calendarStartRef.current = null;
      callExternalDragUpdaterRef.current(-1, -1, undefined); // clear ghost
      return;
    }

    activePageDataRef.current = activePageData;

    function onMove(ev: MouseEvent) {
      const page = activePageDataRef.current;
      if (!page) return;
      const folder = foldersRef.current.find((f) => f.id === page.folderId);
      const durationMs = getPageDurationMs(page);
      const result = callExternalDragUpdaterRef.current(
        ev.clientX,
        ev.clientY,
        folder?.color ?? undefined,
        durationMs,
        page.title,
        page.status === "done"
      );
      calendarStartRef.current = result?.start ?? null;
      const isOver = result !== null;
      if (isOver !== overCalendarRef.current) {
        overCalendarRef.current = isOver;
        setIsDraggingOverCalendar(isOver);
      }
    }

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      overCalendarRef.current = false;
      setIsDraggingOverCalendar(false);
    };
  }, [activePageData, setIsDraggingOverCalendar]);

  function handleDragStart({ active }: DragStartEvent) {
    const type = active.data.current?.["type"] as string | undefined;
    if (type === "page") {
      setActivePageData(pages.find((p) => p.id === active.id) ?? null);
    } else if (type === "folder") {
      setActiveFolderData(folders.find((f) => f.id === active.id) ?? null);
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const pageData = activePageData;
    const calendarStart = calendarStartRef.current;

    setActivePageData(null);
    setActiveFolderData(null);
    calendarStartRef.current = null;
    // Clear the WeekGrid ghost immediately (don't wait for the effect cleanup).
    callExternalDragUpdaterRef.current(-1, -1, undefined);

    // Calendar drop takes priority over list reorder.
    if (calendarStart && pageData) {
      let calendarEnd: string | undefined;
      if (calendarStart.includes("T")) {
        const durationMs = getPageDurationMs(pageData);
        if (durationMs != null) {
          calendarEnd = format(
            new Date(new Date(calendarStart).getTime() + durationMs),
            "yyyy-MM-dd'T'HH:mm:ss"
          );
        }
      }
      void scheduleOnce(pageData.id, calendarStart, calendarEnd);
      return;
    }

    if (!over || active.id === over.id) return;

    const at = active.data.current?.["type"] as string | undefined;
    const ot = over.data.current?.["type"] as string | undefined;

    if (at === "page" && ot === "page") {
      // Only reorder in manual sort mode — other modes lock DnD.
      if (activeViewId === "today") return;
      const currentSortMode = getSortMode(activeViewId);
      if (currentSortMode !== "manual") return;
      const visible = sortPages(getVisiblePages(pages, activeViewId), currentSortMode);
      const oldIdx = visible.findIndex((p) => p.id === active.id);
      const newIdx = visible.findIndex((p) => p.id === over.id);
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
      const folderId = activeViewId !== "today" && activeViewId !== "inbox" ? activeViewId : null;
      void reorderPages(
        folderId,
        arrayMove(visible, oldIdx, newIdx).map((p) => p.id)
      );
    } else if (at === "page" && ot === "folder") {
      // folderId stored in droppable data; null means Inbox.
      const folderId = (over.data.current?.["folderId"] as string | null | undefined) ?? null;
      updatePage(String(active.id), { folderId });
    } else if (at === "folder" && ot === "folder") {
      const oldIdx = folders.findIndex((f) => f.id === active.id);
      const newIdx = folders.findIndex((f) => f.id === over.id);
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
      void reorderFolders(arrayMove(folders, oldIdx, newIdx).map((f) => f.id));
    }
  }

  function handleDragCancel() {
    setActivePageData(null);
    setActiveFolderData(null);
    calendarStartRef.current = null;
    callExternalDragUpdaterRef.current(-1, -1, undefined);
  }

  return {
    activeFolderData,
    activePageData,
    handleDragCancel,
    handleDragEnd,
    handleDragStart,
    sensors,
  };
}
