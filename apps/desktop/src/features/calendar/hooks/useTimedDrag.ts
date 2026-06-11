import type { PageSummary } from "@pikos/core";
import { isDone } from "@pikos/core";
import { format } from "date-fns";
import { useRef, useState } from "react";

import type { BlockDragStartInfo } from "../components/DayColumn";
import {
  type CalendarMetrics,
  type CollapseGeometry,
  mapYToDate,
  snapYCollapse,
} from "../utils/calendarGeometry";
import type { CalendarBlock } from "../utils/calendarLayout";
import type { GhostContent } from "./useDragGhost";

interface DragRefState {
  pageId: string;
  block: CalendarBlock;
  grabOffsetY: number;
  folderColor: string | undefined;
  /** Set when dragging a virtual rrule occurrence — keys the override. */
  originalDate?: string;
}

interface TimedDragAllDayTarget {
  dayIndex: number;
  folderColor: string | undefined;
}

export interface UseTimedDragOptions {
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
  queueInitialGhostPosition: (dayIndex: number, top: number, height: number) => void;
  onReschedule: (pageId: string, start: string, end?: string, originalDate?: string) => void;
  disableSelect: (cursor: "dragging-grab" | "dragging-resize") => void;
  enableSelect: () => void;
  eatNextClick: () => void;
}

export interface UseTimedDragResult {
  timedDraggingPageId: string | null;
  timedDragAllDayTarget: TimedDragAllDayTarget | null;
  /** Day index currently under the cursor while dragging a timed block.
   * Null when the cursor is in the all-day strip or no drag is active.
   * Used to highlight the target column — same affordance as external drop. */
  timedDragDayIndex: number | null;
  handleBlockDragStart: (info: BlockDragStartInfo) => void;
}

/**
 * Drags a timed PageBlock within the grid. Owns the drag state machine +
 * cursor tracking; the ghost rendering is handled by the shared useDragGhost
 * hook (passed in via individual functions to keep this hook free of
 * mutate-foreign-ref lint errors).
 */
export function useTimedDrag({
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
  queueInitialGhostPosition,
  scrollRef,
  setGhostContent,
  showGhost,
}: UseTimedDragOptions): UseTimedDragResult {
  const dragRef = useRef<DragRefState | null>(null);
  const dragGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
  const timedAllDayTargetDayIndexRef = useRef<number | null>(null);
  const timedDragDayIndexRef = useRef<number | null>(null);
  const rafIdRef = useRef(0);
  const [timedDraggingPageId, setTimedDraggingPageId] = useState<string | null>(null);
  const [timedDragAllDayTarget, setTimedDragAllDayTarget] = useState<TimedDragAllDayTarget | null>(
    null
  );
  const [timedDragDayIndex, setTimedDragDayIndex] = useState<number | null>(null);

  function handleBlockDragStart({
    block,
    clientY,
    dayIndex,
    folderColor,
    originalDate,
    pageId,
  }: BlockDragStartInfo) {
    const scrollEl = scrollRef.current;
    const columnsEl = dayColumnsRef.current;
    if (!scrollEl || !columnsEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const cursorYInGrid = clientY - scrollRect.top + scrollEl.scrollTop;
    const grabOffsetY = cursorYInGrid - block.top;

    disableSelect("dragging-grab");
    dragRef.current = {
      block,
      folderColor,
      grabOffsetY,
      pageId,
      ...(originalDate && { originalDate }),
    };
    const initialTop = snapYCollapse(Math.max(0, block.top), geometry);
    dragGhostPositionRef.current = { dayIndex, top: initialTop };
    timedAllDayTargetDayIndexRef.current = null;
    timedDragDayIndexRef.current = dayIndex;
    setTimedDragDayIndex(dayIndex);

    const page = pages.find((p) => p.id === pageId);
    const blockH = block.height;
    setTimedDraggingPageId(pageId);
    // Queue the initial position so the ghost is positioned the instant it
    // mounts (before any mousemove fires).
    queueInitialGhostPosition(dayIndex, initialTop, blockH);
    setGhostContent({
      folderColor,
      height: blockH,
      isCompact: block.isCompact,
      isDone: page != null && isDone(page),
      title: page?.title ?? "Untitled",
    });

    let lastClientY = clientY;

    function onMove(ev: MouseEvent) {
      lastClientY = ev.clientY;
      const state = dragRef.current;
      if (!state || !scrollRef.current || !dayColumnsRef.current) return;

      const scrollEl = scrollRef.current;
      const columnsEl = dayColumnsRef.current;
      const scrollRect = scrollEl.getBoundingClientRect();
      const columnsRect = columnsEl.getBoundingClientRect();

      const dayCount = days.length;
      const columnWidth = columnsRect.width / dayCount;
      const cursorXInColumns = ev.clientX - columnsRect.left;
      const ghostDayIndex = Math.max(
        0,
        Math.min(dayCount - 1, Math.floor(cursorXInColumns / columnWidth))
      );

      if (ev.clientY < scrollRect.top) {
        cancelAnimationFrame(rafIdRef.current);
        hideGhost();
        dragGhostPositionRef.current = { dayIndex: ghostDayIndex, top: 0 };
        if (timedAllDayTargetDayIndexRef.current !== ghostDayIndex) {
          timedAllDayTargetDayIndexRef.current = ghostDayIndex;
          setTimedDragAllDayTarget({ dayIndex: ghostDayIndex, folderColor: state.folderColor });
        }
        if (timedDragDayIndexRef.current !== null) {
          timedDragDayIndexRef.current = null;
          setTimedDragDayIndex(null);
        }
        return;
      }

      if (timedAllDayTargetDayIndexRef.current !== null) {
        timedAllDayTargetDayIndexRef.current = null;
        setTimedDragAllDayTarget(null);
      }
      if (timedDragDayIndexRef.current !== ghostDayIndex) {
        timedDragDayIndexRef.current = ghostDayIndex;
        setTimedDragDayIndex(ghostDayIndex);
      }

      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const bH = state.block.height;
      const rawTop = cursorYInGrid - state.grabOffsetY;
      const ghostTop = snapYCollapse(
        Math.max(0, Math.min(metrics.gridHeight - bH, rawTop)),
        geometry
      );

      dragGhostPositionRef.current = { dayIndex: ghostDayIndex, top: ghostTop };

      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        showGhost();
        positionGhost(ghostDayIndex, ghostTop, bH);
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      cancelAnimationFrame(rafIdRef.current);

      const state = dragRef.current;
      const ghostPos = dragGhostPositionRef.current;
      dragRef.current = null;
      dragGhostPositionRef.current = null;
      timedAllDayTargetDayIndexRef.current = null;
      timedDragDayIndexRef.current = null;
      setTimedDraggingPageId(null);
      setGhostContent(null);
      setTimedDragAllDayTarget(null);
      setTimedDragDayIndex(null);

      if (!state || !ghostPos) return;

      const scrollElUp = scrollRef.current;
      if (scrollElUp && lastClientY < scrollElUp.getBoundingClientRect().top) {
        const allDayTarget = days[ghostPos.dayIndex];
        if (allDayTarget)
          onReschedule(
            state.pageId,
            format(allDayTarget, "yyyy-MM-dd"),
            undefined,
            state.originalDate
          );
        return;
      }

      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;

      const newStart = mapYToDate(ghostPos.top, targetDay, geometry);
      const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");

      // Preserve duration whenever the event actually has one. The previous
      // `!isCompact` check conflated "rendered as chip" with "no explicit
      // end", which dropped the duration of short-but-timed events (e.g.
      // 30m at compact density) on drag.
      const durationMs = state.block.endDate.getTime() - state.block.startDate.getTime();
      const newEnd = durationMs > 0 ? fmt(new Date(newStart.getTime() + durationMs)) : undefined;

      onReschedule(state.pageId, fmt(newStart), newEnd, state.originalDate);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return {
    handleBlockDragStart,
    timedDragAllDayTarget,
    timedDragDayIndex,
    timedDraggingPageId,
  };
}
