import { format } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { useCalendarDnD } from "@/shared/context/CalendarDnDContext";

import {
  type CalendarMetrics,
  type CollapseGeometry,
  mapYToDate,
  snapYCollapse,
} from "../utils/calendarGeometry";

interface ExternalPreview {
  dayIndex: number;
  top: number;
  isAllDay: boolean;
  folderColor: string | undefined;
  durationMs?: number | undefined;
  title?: string | undefined;
  isDone?: boolean | undefined;
}

export interface UseExternalDropPreviewOptions {
  days: Date[];
  geometry: CollapseGeometry;
  metrics: CalendarMetrics;
  /** Refs to the calendar's wrapper, scroll viewport, and day-columns row.
   * Used to translate client coords → grid coords. */
  weekGridRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseExternalDropPreviewResult {
  externalPreview: ExternalPreview | null;
}

/**
 * Owns the live ghost state shown when a page is dragged from the page list
 * (or anywhere outside the calendar) onto the timed/all-day grid. The actual
 * drop coordinates are pushed in by useThreePanelDnD via
 * CalendarDnDContext.registerExternalDragUpdater; this hook just translates
 * client coords → preview state and returns the snapped start ISO that the
 * drop handler hands off to scheduleOnce.
 */
export function useExternalDropPreview({
  dayColumnsRef,
  days,
  geometry,
  metrics,
  scrollRef,
  weekGridRef,
}: UseExternalDropPreviewOptions): UseExternalDropPreviewResult {
  const { registerExternalDragUpdater } = useCalendarDnD();
  const [externalPreview, setExternalPreview] = useState<ExternalPreview | null>(null);

  /**
   * Called by useThreePanelDnD on every mousemove. Computes the drop slot
   * from cursor coords, updates local preview state for ghost rendering, and
   * returns { start } (ISO string) for scheduleOnce. Passing out-of-bounds
   * coords (e.g. -1, -1) clears the preview.
   */
  function updateExternalDrag(
    clientX: number,
    clientY: number,
    folderColor: string | undefined,
    durationMs?: number,
    title?: string,
    isDone?: boolean
  ): { start: string } | null {
    const gridEl = weekGridRef.current;
    const scrollEl = scrollRef.current;
    const columnsEl = dayColumnsRef.current;
    if (!gridEl || !scrollEl || !columnsEl) {
      setExternalPreview(null);
      return null;
    }

    const gridRect = gridEl.getBoundingClientRect();
    const columnsRect = columnsEl.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();

    if (clientX < columnsRect.left || clientX > columnsRect.right) {
      setExternalPreview(null);
      return null;
    }
    // Must be within the calendar panel vertically (all-day row counts too).
    if (clientY < gridRect.top || clientY > scrollRect.bottom) {
      setExternalPreview(null);
      return null;
    }

    const dayCount = days.length;
    const columnWidth = columnsRect.width / dayCount;
    const dayIndex = Math.max(
      0,
      Math.min(dayCount - 1, Math.floor((clientX - columnsRect.left) / columnWidth))
    );
    const targetDay = days[dayIndex];
    if (!targetDay) {
      setExternalPreview(null);
      return null;
    }

    // Cursor above the timed scroll area → all-day zone.
    if (clientY < scrollRect.top) {
      setExternalPreview({ dayIndex, folderColor, isAllDay: true, isDone, title, top: 0 });
      return { start: format(targetDay, "yyyy-MM-dd") };
    }

    const cursorYInGrid = clientY - scrollRect.top + scrollEl.scrollTop;
    const ghostHeight =
      durationMs != null
        ? Math.max((durationMs / 3_600_000) * metrics.hourHeight, metrics.compactBlockHeight)
        : metrics.compactBlockHeight;
    const top = snapYCollapse(
      Math.max(0, Math.min(metrics.gridHeight - ghostHeight, cursorYInGrid)),
      geometry
    );
    const newStart = mapYToDate(top, targetDay, geometry);
    setExternalPreview({
      dayIndex,
      folderColor,
      isAllDay: false,
      isDone,
      title,
      top,
      ...(durationMs != null && { durationMs }),
    });
    return { start: format(newStart, "yyyy-MM-dd'T'HH:mm:ss") };
  }

  // Keep registerExternalDragUpdater pointed at the latest closure so
  // useThreePanelDnD always calls the current updater (fresh days, refs).
  const latestUpdaterRef = useRef(updateExternalDrag);
  useEffect(() => {
    latestUpdaterRef.current = updateExternalDrag;
  });
  useEffect(() => {
    registerExternalDragUpdater((clientX, clientY, folderColor, durationMs, title, isDone) =>
      latestUpdaterRef.current(clientX, clientY, folderColor, durationMs, title, isDone)
    );
    return () => {
      registerExternalDragUpdater(null);
    };
  }, [registerExternalDragUpdater]);

  return { externalPreview };
}
