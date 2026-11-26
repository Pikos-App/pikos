import type { CalendarMetrics, CollapseGeometry } from "@pikos/core";
import { mapYToDate, snapYCollapse } from "@pikos/core";
import { format } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { useCalendarDnD } from "@/shared/context/CalendarDnDContext";

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
  weekGridRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseExternalDropPreviewResult {
  externalPreview: ExternalPreview | null;
}

/**
 * Live ghost state for a page dragged from outside the calendar onto the grid. The drop
 * handler passes the snapped start ISO on to scheduleOnce.
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
   * Called by useThreePanelDnD on every mousemove; returns { start } for scheduleOnce.
   * Out-of-bounds coords (e.g. -1, -1) clear the preview.
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

  // Keeps the registered updater on the latest closure (fresh days, refs).
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
