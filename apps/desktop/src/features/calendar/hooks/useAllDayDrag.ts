import type { PageSummary } from "@pikos/core";
import { isDone } from "@pikos/core";
import { format } from "date-fns";
import { useRef, useState } from "react";

import { computeAllDayEdgeResize, shiftAllDayEnd } from "../utils/allDayLayout";
import {
  type CalendarMetrics,
  type CollapseGeometry,
  mapYToDate,
  snapYCollapse,
} from "../utils/calendarGeometry";
import type { GhostContent } from "./useDragGhost";

interface AllDayDragRefState {
  pageId: string;
  folderColor: string | undefined;
  /** Set when dragging a virtual rrule occurrence — keys the override. */
  originalDate?: string;
}

interface AllDayEdgePreview {
  pageId: string;
  startDate: string;
  endDate: string;
}

export interface UseAllDayDragOptions {
  days: Date[];
  pages: PageSummary[];
  geometry: CollapseGeometry;
  metrics: CalendarMetrics;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
  /** Ghost imperative API (from useDragGhost). */
  setGhostContent: (next: GhostContent | null) => void;
  positionGhost: (dayIndex: number, top: number, height: number) => void;
  showGhost: () => void;
  hideGhost: () => void;
  onReschedule: (pageId: string, start: string, end?: string, originalDate?: string) => void;
  disableSelect: (cursor: "dragging-grab" | "dragging-resize") => void;
  enableSelect: () => void;
  eatNextClick: () => void;
}

export interface UseAllDayDragResult {
  allDayDraggingPageId: string | null;
  allDayDragHoverIndex: number | null;
  allDayEdgeResizePreview: AllDayEdgePreview | null;
  handleAllDayChipDragStart: (args: {
    folderColor: string | undefined;
    pageId: string;
    originalDate?: string;
  }) => void;
  handleAllDayEdgeResizeStart: (args: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
    originalDate?: string;
  }) => void;
}

/**
 * Drags an existing all-day chip across days (column hover) or into the timed
 * grid (reschedule to a timed time). Also handles the left/right edge-resize
 * that extends or shrinks a multi-day span.
 *
 * The chip drag and the edge resize share the all-day page list (which the
 * caller derives, applying the edge-resize preview as an override before
 * passing it to AllDaySection), so colocating both gestures keeps the
 * preview/commit flow in one place.
 */
export function useAllDayDrag({
  dayColumnsRef,
  days,
  disableSelect,
  eatNextClick,
  enableSelect,
  geometry,
  hideGhost,
  metrics,
  onReschedule,
  pages,
  positionGhost,
  scrollRef,
  setGhostContent,
  showGhost,
}: UseAllDayDragOptions): UseAllDayDragResult {
  const allDayDragRef = useRef<AllDayDragRefState | null>(null);
  const allDayGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
  const allDayHoverColumnRef = useRef<number | null>(null);
  const rafIdRef = useRef(0);
  const [allDayDraggingPageId, setAllDayDraggingPageId] = useState<string | null>(null);
  const [allDayDragHoverIndex, setAllDayDragHoverIndex] = useState<number | null>(null);

  const allDayEdgeResizePreviewRef = useRef<AllDayEdgePreview | null>(null);
  const [allDayEdgeResizePreview, setAllDayEdgeResizePreview] = useState<AllDayEdgePreview | null>(
    null
  );

  function dayIndexFromClientX(clientX: number): number | null {
    const columnsEl = dayColumnsRef.current;
    if (!columnsEl) return null;
    const rect = columnsEl.getBoundingClientRect();
    const columnWidth = rect.width / days.length;
    return Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / columnWidth)));
  }

  function handleAllDayChipDragStart({
    folderColor,
    originalDate,
    pageId,
  }: {
    folderColor: string | undefined;
    pageId: string;
    originalDate?: string;
  }) {
    disableSelect("dragging-grab");
    allDayDragRef.current = { folderColor, pageId, ...(originalDate && { originalDate }) };
    allDayGhostPositionRef.current = null;
    allDayHoverColumnRef.current = null;
    setAllDayDraggingPageId(pageId);

    // Render the ghost DOM once up-front. Position updates during the drag
    // go through positionGhost() — ref-based, no React re-render per frame.
    const page = pages.find((p) => p.id === pageId);
    setGhostContent({
      folderColor,
      height: metrics.compactBlockHeight,
      isCompact: true,
      isDone: page != null && isDone(page),
      title: page?.title ?? "Untitled",
    });

    function onMove(ev: MouseEvent) {
      const scrollEl = scrollRef.current;
      const columnsEl = dayColumnsRef.current;
      if (!scrollEl || !columnsEl) return;

      const scrollRect = scrollEl.getBoundingClientRect();
      const columnsRect = columnsEl.getBoundingClientRect();
      const dayCount = days.length;
      const columnWidth = columnsRect.width / dayCount;
      const hoverDayIndex = Math.max(
        0,
        Math.min(dayCount - 1, Math.floor((ev.clientX - columnsRect.left) / columnWidth))
      );

      // Cursor is in the all-day/header zone — track horizontal column, hide timed ghost.
      if (ev.clientY < scrollRect.top) {
        if (allDayGhostPositionRef.current !== null) {
          allDayGhostPositionRef.current = null;
          cancelAnimationFrame(rafIdRef.current);
          hideGhost();
        }
        if (allDayHoverColumnRef.current !== hoverDayIndex) {
          allDayHoverColumnRef.current = hoverDayIndex;
          setAllDayDragHoverIndex(hoverDayIndex);
        }
        return;
      }

      // Cursor is in the timed grid — clear all-day hover, show timed ghost.
      if (allDayHoverColumnRef.current !== null) {
        allDayHoverColumnRef.current = null;
        setAllDayDragHoverIndex(null);
      }

      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const ghostTop = snapYCollapse(
        Math.max(0, Math.min(metrics.gridHeight - metrics.compactBlockHeight, cursorYInGrid)),
        geometry
      );

      allDayGhostPositionRef.current = { dayIndex: hoverDayIndex, top: ghostTop };

      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        showGhost();
        positionGhost(hoverDayIndex, ghostTop, metrics.compactBlockHeight);
      });
    }

    function onUp(ev: MouseEvent) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      cancelAnimationFrame(rafIdRef.current);

      const state = allDayDragRef.current;
      const ghostPos = allDayGhostPositionRef.current;
      const hoverColumn = allDayHoverColumnRef.current;
      allDayDragRef.current = null;
      allDayGhostPositionRef.current = null;
      allDayHoverColumnRef.current = null;
      setGhostContent(null);
      setAllDayDraggingPageId(null);
      setAllDayDragHoverIndex(null);

      if (!state) return;

      const scrollEl = scrollRef.current;
      // Dropped in the all-day zone → reschedule as all-day on the hovered
      // column.
      if (scrollEl && ev.clientY < scrollEl.getBoundingClientRect().top) {
        if (hoverColumn === null) return;
        const targetDay = days[hoverColumn];
        if (!targetDay) return;
        const startStr = format(targetDay, "yyyy-MM-dd");
        // Preserve a multi-day span: a 4-day event dragged stays 4 days
        // long. Virtuals share the head's id so the lookup still works for
        // span computation, even though the rescheduling materialises an
        // override.
        const page = pages.find((p) => p.id === state.pageId);
        const endStr = shiftAllDayEnd(page?.scheduledStart, page?.scheduledEnd, targetDay);
        onReschedule(state.pageId, startStr, endStr, state.originalDate);
        return;
      }

      // Dropped in the timed grid.
      if (!ghostPos) return;
      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;
      const newStart = mapYToDate(ghostPos.top, targetDay, geometry);
      onReschedule(
        state.pageId,
        format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
        undefined,
        state.originalDate
      );
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /**
   * All-day edge resize — drags the left/right edge of a multi-day chip to
   * extend/shrink the span. Clamps the grabbed edge to visible days; cross-
   * week reach is via the popover's date picker. The non-grabbed ("anchor")
   * edge is the opposite end of the span at gesture start; during the drag,
   * start = min(grabbed, anchor), end = max, so crossing over the anchor
   * flips the semantics without losing the range.
   */
  function handleAllDayEdgeResizeStart({
    edge,
    originalDate,
    pageId,
  }: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
    originalDate?: string;
  }) {
    const page = pages.find((p) => p.id === pageId);
    if (!page?.scheduledStart) return;
    const startStr = page.scheduledStart;
    const endStr = page.scheduledEnd ?? page.scheduledStart;
    const anchorStr = edge === "start" ? endStr : startStr;

    disableSelect("dragging-resize");
    allDayEdgeResizePreviewRef.current = { endDate: endStr, pageId, startDate: startStr };
    setAllDayEdgeResizePreview({ endDate: endStr, pageId, startDate: startStr });

    function onMove(ev: MouseEvent) {
      const idx = dayIndexFromClientX(ev.clientX);
      if (idx === null) return;
      const grabbedDay = days[idx];
      if (!grabbedDay) return;
      const grabbedStr = format(grabbedDay, "yyyy-MM-dd");
      const { end: nextEnd, start: nextStart } = computeAllDayEdgeResize(anchorStr, grabbedStr);
      const prev = allDayEdgeResizePreviewRef.current;
      if (prev?.startDate === nextStart && prev.endDate === nextEnd) return;
      const next = { endDate: nextEnd, pageId, startDate: nextStart };
      allDayEdgeResizePreviewRef.current = next;
      setAllDayEdgeResizePreview(next);
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      const final = allDayEdgeResizePreviewRef.current;
      allDayEdgeResizePreviewRef.current = null;
      setAllDayEdgeResizePreview(null);
      if (!final) return;
      const endArg = final.startDate === final.endDate ? undefined : final.endDate;
      onReschedule(final.pageId, final.startDate, endArg, originalDate);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return {
    allDayDraggingPageId,
    allDayDragHoverIndex,
    allDayEdgeResizePreview,
    handleAllDayChipDragStart,
    handleAllDayEdgeResizeStart,
  };
}
