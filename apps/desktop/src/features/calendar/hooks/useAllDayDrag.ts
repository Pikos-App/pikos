import type { CalendarMetrics, CollapseGeometry, PageSummary } from "@pikos/core";
import {
  computeAllDayEdgeResize,
  isDone,
  mapYToDate,
  shiftAllDayEnd,
  snapYCollapse,
} from "@pikos/core";
import { format } from "date-fns";
import { useRef, useState } from "react";

import type { GhostContent } from "./useDragGhost";

interface AllDayDragRefState {
  pageId: string;
  folderColor: string | undefined;
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
 * Drags an existing all-day chip across days or into the timed grid, and edge-resizes a
 * multi-day span. Both gestures share the all-day list the caller derives (with the resize
 * preview applied as an override), so the preview/commit flow lives in one place.
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
    const page = pages.find((p) => p.id === pageId);
    if (page?.scheduleLocked) return;

    disableSelect("dragging-grab");
    allDayDragRef.current = { folderColor, pageId, ...(originalDate && { originalDate }) };
    allDayGhostPositionRef.current = null;
    allDayHoverColumnRef.current = null;
    setAllDayDraggingPageId(pageId);

    // Position updates go through positionGhost(), not React state, so no re-render per frame.
    setGhostContent({
      folderColor,
      height: metrics.compactBlockHeight,
      isCompact: true,
      isDone: page != null && isDone(page),
      title: page?.title ?? "Untitled",
    });

    function onMove(ev: PointerEvent) {
      // A second finger landing mid-drag must not steer the gesture the first
      // one started; mouse and pen are always primary.
      if (!ev.isPrimary) return;
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

    function onUp(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
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
      if (scrollEl && ev.clientY < scrollEl.getBoundingClientRect().top) {
        if (hoverColumn === null) return;
        const targetDay = days[hoverColumn];
        if (!targetDay) return;
        const startStr = format(targetDay, "yyyy-MM-dd");
        // Keep a multi-day span's length. Virtuals share the head's id, so the lookup still works.
        const page = pages.find((p) => p.id === state.pageId);
        const endStr = shiftAllDayEnd(page?.scheduledStart, page?.scheduledEnd, targetDay);
        onReschedule(state.pageId, startStr, endStr, state.originalDate);
        return;
      }

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

    function onCancel(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      cancelAnimationFrame(rafIdRef.current);
      allDayDragRef.current = null;
      allDayGhostPositionRef.current = null;
      allDayHoverColumnRef.current = null;
      setGhostContent(null);
      setAllDayDraggingPageId(null);
      setAllDayDragHoverIndex(null);
    }

    function teardown() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  /**
   * Edge resize of a multi-day chip. The grabbed edge clamps to visible days (cross-week reach
   * is the popover's date picker); crossing the opposite edge flips which end moves without
   * losing the range.
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
    if (page.scheduleLocked) return;
    const startStr = page.scheduledStart;
    const endStr = page.scheduledEnd ?? page.scheduledStart;
    const anchorStr = edge === "start" ? endStr : startStr;

    disableSelect("dragging-resize");
    allDayEdgeResizePreviewRef.current = { endDate: endStr, pageId, startDate: startStr };
    setAllDayEdgeResizePreview({ endDate: endStr, pageId, startDate: startStr });

    function onMove(ev: PointerEvent) {
      if (!ev.isPrimary) return;
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

    function onUp(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      eatNextClick();
      const final = allDayEdgeResizePreviewRef.current;
      allDayEdgeResizePreviewRef.current = null;
      setAllDayEdgeResizePreview(null);
      if (!final) return;
      const endArg = final.startDate === final.endDate ? undefined : final.endDate;
      onReschedule(final.pageId, final.startDate, endArg, originalDate);
    }

    function onCancel(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      allDayEdgeResizePreviewRef.current = null;
      setAllDayEdgeResizePreview(null);
    }

    function teardown() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return {
    allDayDraggingPageId,
    allDayDragHoverIndex,
    allDayEdgeResizePreview,
    handleAllDayChipDragStart,
    handleAllDayEdgeResizeStart,
  };
}
