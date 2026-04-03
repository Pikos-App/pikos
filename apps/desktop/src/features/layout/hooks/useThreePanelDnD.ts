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
import type { SortMode } from "@/features/pages";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/** Gap between timed pages when multi-dropping on calendar (ms). */
const MULTI_DROP_GAP_MS = 15 * 60 * 1000; // 15 minutes
/** Gap between point-in-time pages when multi-dropping on calendar (ms). */
const MULTI_DROP_POINT_GAP_MS = 30 * 60 * 1000; // 30 minute

/** Returns the duration in ms for a timed page schedule, or undefined for all-day/unscheduled. */
function getPageDurationMs(page: PageSummary): number | undefined {
  if (!page.scheduledStart?.includes("T") || !page.scheduledEnd) return undefined;
  const ms =
    parseLocalISO(page.scheduledEnd).getTime() - parseLocalISO(page.scheduledStart).getTime();
  return ms > 0 ? ms : undefined;
}

export function useThreePanelDnD() {
  const { folders, pages, reorderFolders, reorderPages, scheduleOnce, updatePage } = useWorkspace();
  const {
    activeViewId,
    callExternalDragUpdater,
    clearSelection,
    getSortMode,
    selectedPageIds,
    setIsDraggingOverCalendar,
  } = useUI();

  const [activePageData, setActivePageData] = useState<PageSummary | null>(null);
  const [activeFolderData, setActiveFolderData] = useState<Folder | null>(null);
  /** IDs of all pages being dragged (includes the active drag item + selected). */
  const [draggedPageIds, setDraggedPageIds] = useState<string[]>([]);

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
      const page = pages.find((p) => p.id === active.id) ?? null;
      setActivePageData(page);

      // If dragging a selected item, drag all selected pages (in list order).
      // If dragging an unselected item, treat as single-drag and clear selection.
      if (selectedPageIds.has(String(active.id))) {
        const sortMode: SortMode = activeViewId === "today" ? "date" : getSortMode(activeViewId);
        const visible = sortPages(getVisiblePages(pages, activeViewId), sortMode);
        const ids = visible.filter((p) => selectedPageIds.has(p.id)).map((p) => p.id);
        setDraggedPageIds(ids);
      } else {
        clearSelection();
        setDraggedPageIds(page ? [page.id] : []);
      }
    } else if (type === "folder") {
      setActiveFolderData(folders.find((f) => f.id === active.id) ?? null);
      setDraggedPageIds([]);
    }
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const pageData = activePageData;
    const calendarStart = calendarStartRef.current;
    const idsToMove = [...draggedPageIds];

    setActivePageData(null);
    setActiveFolderData(null);
    setDraggedPageIds([]);
    calendarStartRef.current = null;
    // Clear the WeekGrid ghost immediately (don't wait for the effect cleanup).
    callExternalDragUpdaterRef.current(-1, -1, undefined);

    // Calendar drop takes priority over list reorder.
    if (calendarStart && pageData) {
      if (idsToMove.length <= 1) {
        // Single-page drop: preserve existing behavior (keep duration)
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
      } else {
        // Multi-page drop
        const isTimedDrop = calendarStart.includes("T");
        if (isTimedDrop) {
          // Stagger pages 30min apart, preserving each page's existing duration.
          const baseTime = new Date(calendarStart).getTime();
          let offset = 0;
          for (const id of idsToMove) {
            const page = pages.find((p) => p.id === id);
            const durationMs = page ? getPageDurationMs(page) : undefined;
            const startTime = new Date(baseTime + offset);
            const start = format(startTime, "yyyy-MM-dd'T'HH:mm:ss");
            const end =
              durationMs != null
                ? format(new Date(startTime.getTime() + durationMs), "yyyy-MM-dd'T'HH:mm:ss")
                : undefined;
            void scheduleOnce(id, start, end);
            offset +=
              (durationMs ?? 0) +
              (durationMs != null ? MULTI_DROP_GAP_MS : MULTI_DROP_POINT_GAP_MS);
          }
        } else {
          // All-day drop: all pages become all-day for that date
          for (const id of idsToMove) {
            void scheduleOnce(id, calendarStart);
          }
        }
      }
      clearSelection();
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
      const folderId = activeViewId !== "today" && activeViewId !== "inbox" ? activeViewId : null;

      if (idsToMove.length > 1) {
        // Multi-page reorder: remove all dragged pages, reinsert as group at drop target.
        const dragSet = new Set(idsToMove);
        const dragged = visible.filter((p) => dragSet.has(p.id));
        const rest = visible.filter((p) => !dragSet.has(p.id));
        const dropIdx = rest.findIndex((p) => p.id === over.id);
        if (dropIdx === -1) return;
        // Insert after drop target if dragging downward, before if upward.
        const activeIdx = visible.findIndex((p) => p.id === active.id);
        const overIdx = visible.findIndex((p) => p.id === over.id);
        const insertIdx = activeIdx < overIdx ? dropIdx + 1 : dropIdx;
        rest.splice(insertIdx, 0, ...dragged);
        void reorderPages(
          folderId,
          rest.map((p) => p.id)
        );
      } else {
        const oldIdx = visible.findIndex((p) => p.id === active.id);
        const newIdx = visible.findIndex((p) => p.id === over.id);
        if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
        void reorderPages(
          folderId,
          arrayMove(visible, oldIdx, newIdx).map((p) => p.id)
        );
      }
    } else if (at === "page" && ot === "folder") {
      // folderId stored in droppable data; null means Inbox.
      const folderId = (over.data.current?.["folderId"] as string | null | undefined) ?? null;
      // Move all dragged pages to the target folder
      for (const id of idsToMove.length > 0 ? idsToMove : [String(active.id)]) {
        updatePage(id, { folderId });
      }
      clearSelection();
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
    setDraggedPageIds([]);
    calendarStartRef.current = null;
    callExternalDragUpdaterRef.current(-1, -1, undefined);
  }

  return {
    activeFolderData,
    activePageData,
    draggedPageCount: draggedPageIds.length,
    handleDragCancel,
    handleDragEnd,
    handleDragStart,
    sensors,
  };
}
