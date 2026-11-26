import type { CalendarBlock, CalendarMetrics, CollapseGeometry, PageSummary } from "@pikos/core";
import {
  addClockMinutes,
  clockMinutesBetween,
  isDone,
  mapYToDate,
  snapYCollapse,
} from "@pikos/core";
import { format } from "date-fns";
import { useRef, useState } from "react";

import type { BlockDragStartInfo } from "../components/DayColumn";
import type { GhostContent } from "./useDragGhost";

interface DragRefState {
  pageId: string;
  block: CalendarBlock;
  grabOffsetY: number;
  folderColor: string | undefined;
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
  /** Day index under the cursor while dragging; null in the all-day strip or when idle. */
  timedDragDayIndex: number | null;
  handleBlockDragStart: (info: BlockDragStartInfo) => void;
}

/**
 * Drags a timed PageBlock within the grid. Ghost rendering is the shared useDragGhost hook's,
 * passed in as individual functions to keep this hook free of mutate-foreign-ref lint errors.
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
    if (block.page.scheduleLocked) return;

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
    queueInitialGhostPosition(dayIndex, initialTop, blockH);
    setGhostContent({
      folderColor,
      height: blockH,
      isCompact: block.isCompact,
      isDone: page != null && isDone(page),
      title: page?.title ?? "Untitled",
    });

    let lastClientY = clientY;

    function onMove(ev: PointerEvent) {
      // A second finger landing mid-drag must not steer the first one's gesture.
      if (!ev.isPrimary) return;
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

    function onUp(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
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

      // Keep the duration whenever the event has one: short timed events (30m at compact density)
      // would otherwise lose it on drag.
      const duration = clockMinutesBetween(state.block.startDate, state.block.endDate);
      const newEnd = duration > 0 ? fmt(addClockMinutes(newStart, duration)) : undefined;

      onReschedule(state.pageId, fmt(newStart), newEnd, state.originalDate);
    }

    function onCancel(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      cancelAnimationFrame(rafIdRef.current);
      dragRef.current = null;
      dragGhostPositionRef.current = null;
      timedAllDayTargetDayIndexRef.current = null;
      timedDragDayIndexRef.current = null;
      setTimedDraggingPageId(null);
      setGhostContent(null);
      setTimedDragAllDayTarget(null);
      setTimedDragDayIndex(null);
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
    handleBlockDragStart,
    timedDragAllDayTarget,
    timedDragDayIndex,
    timedDraggingPageId,
  };
}
