import type { PageSummary } from "@pikos/core";
import { format, isSameDay } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useUI } from "@/shared/context/UIContext";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";

function isWeekend(day: Date) {
  const d = day.getDay();
  return d === 0 || d === 6;
}

import { AllDaySection } from "./AllDaySection";
import type { CalendarBlock } from "./calendarUtils";
import {
  COMPACT_BLOCK_HEIGHT,
  GRID_HEIGHT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  MIN_RESIZE_HEIGHT,
  snapY,
  yToDate,
} from "./calendarUtils";
import type { BlockDragStartInfo, BlockResizeStartInfo, DragGhost, ResizeGhost } from "./DayColumn";
import { DayColumn } from "./DayColumn";
import { TimeGutter } from "./TimeGutter";
import { useHeightResize } from "./useHeightResize";

interface WeekGridProps {
  days: Date[];
  editingPageId: string | null;
  isCurrentWeek: boolean;
  onCancelCreate: (pageId: string) => void;
  onCommitTitle: (pageId: string, title: string) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  onReschedule: (pageId: string, start: string, end?: string) => void;
  pages: PageSummary[];
}

/** Pixel offset from grid top to scroll so 8:00 AM is at the top of the viewport. */
const SCROLL_TO_HOUR = 8;
const INITIAL_SCROLL_TOP = (SCROLL_TO_HOUR - GRID_START_HOUR) * HOUR_HEIGHT;

// ─── Drag state ───────────────────────────────────────────────────────────────

interface DragRefState {
  pageId: string;
  block: CalendarBlock;
  grabOffsetY: number;
  folderColor: string | undefined;
}

// ─── Resize state ─────────────────────────────────────────────────────────────

interface ResizeRefState {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
}

/** Prevent text selection and lock cursor during pointer-driven drag/resize gestures. */
function disableSelect(cursorClass: "dragging-grab" | "dragging-resize") {
  document.body.style.userSelect = "none";
  document.documentElement.classList.add(cursorClass);
}
function enableSelect() {
  document.body.style.userSelect = "";
  document.documentElement.classList.remove("dragging-grab", "dragging-resize");
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WeekGrid({
  days,
  editingPageId,
  isCurrentWeek,
  onCancelCreate,
  onCommitTitle,
  onCreateAllDay,
  onCreatePage,
  onPageDoubleClick,
  onReschedule,
  pages,
}: WeekGridProps) {
  const { registerExternalDragUpdater } = useUI();
  const weekGridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayColumnsRef = useRef<HTMLDivElement>(null);
  useMinuteTick();
  const now = new Date();
  const today = now;

  // ── Drag-to-reschedule ──────────────────────────────────────────────────────
  const dragRef = useRef<DragRefState | null>(null);
  // Mutable ghost position (avoids stale closures in window handlers)
  const dragGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
  // State used for rendering
  const [dragRenderState, setDragRenderState] = useState<{
    pageId: string;
    dayIndex: number;
    top: number;
    height: number;
    isCompact: boolean;
    folderColor: string | undefined;
  } | null>(null);

  // ── Resize ──────────────────────────────────────────────────────────────────
  const resizeRef = useRef<ResizeRefState | null>(null);
  const resizeGhostBottomRef = useRef<number | null>(null);
  const [resizeRenderState, setResizeRenderState] = useState<ResizeGhost | null>(null);

  // ── All-day drag state (all-day chip dragged into timed grid) ───────────────
  interface AllDayDragRefState {
    pageId: string;
    folderColor: string | undefined;
  }

  const allDayDragRef = useRef<AllDayDragRefState | null>(null);
  const allDayGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
  const [allDayDragRenderState, setAllDayDragRenderState] = useState<{
    dayIndex: number;
    folderColor: string | undefined;
    pageId: string;
    top: number;
  } | null>(null);
  // Separate state so the AllDaySection re-renders to dim the dragged chip.
  const [allDayDraggingPageId, setAllDayDraggingPageId] = useState<string | null>(null);
  // Column index highlighted while an all-day chip is dragged horizontally in the all-day zone.
  const allDayHoverColumnRef = useRef<number | null>(null);
  const [allDayDragHoverIndex, setAllDayDragHoverIndex] = useState<number | null>(null);

  // ── Timed block dragged over all-day zone ───────────────────────────────────
  // Set while a timed PageBlock is being dragged above the timed grid.
  const [timedDragAllDayTarget, setTimedDragAllDayTarget] = useState<{
    dayIndex: number;
    folderColor: string | undefined;
  } | null>(null);

  // ── External drag preview (page list → calendar via dnd-kit handoff) ─────────
  // Updated by useThreePanelDnD via callExternalDragUpdater on every mousemove.
  const [externalPreview, setExternalPreview] = useState<{
    dayIndex: number;
    top: number;
    isAllDay: boolean;
    folderColor: string | undefined;
    durationMs?: number | undefined;
    title?: string | undefined;
    isDone?: boolean | undefined;
  } | null>(null);

  const allDay = useHeightResize({
    defaultHeight: 60,
    max: 200,
    min: 30,
    storageKey: "pikos:calendarAllDayHeight",
  });

  // Auto-scroll to 8 AM on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = INITIAL_SCROLL_TOP;
    }
  }, []);

  /**
   * Eats the next window click event in the capture phase.
   * Call at the end of any drag/resize mouseup so the click that fires after
   * mouseup (e.g. on whichever block is under the cursor) doesn't open the popover.
   */
  function eatNextClick() {
    function handler(ev: MouseEvent) {
      ev.stopPropagation();
      window.removeEventListener("click", handler, true);
    }
    window.addEventListener("click", handler, true);
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────

  function handleBlockDragStart({
    block,
    clientY,
    dayIndex,
    folderColor,
    pageId,
  }: BlockDragStartInfo) {
    const scrollEl = scrollRef.current;
    const columnsEl = dayColumnsRef.current;
    if (!scrollEl || !columnsEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const cursorYInGrid = clientY - scrollRect.top + scrollEl.scrollTop;
    const grabOffsetY = cursorYInGrid - block.top;

    disableSelect("dragging-grab");
    dragRef.current = { block, folderColor, grabOffsetY, pageId };
    const initialGhost = { dayIndex, top: snapY(Math.max(0, block.top)) };
    dragGhostPositionRef.current = initialGhost;

    setDragRenderState({
      dayIndex: initialGhost.dayIndex,
      folderColor,
      height: block.height,
      isCompact: block.isCompact,
      pageId,
      top: initialGhost.top,
    });

    // Track raw cursor Y so onUp can detect all-day zone drops.
    let lastClientY = clientY;

    function onMove(ev: MouseEvent) {
      lastClientY = ev.clientY;
      const state = dragRef.current;
      if (!state || !scrollRef.current || !dayColumnsRef.current) return;

      const scrollEl2 = scrollRef.current;
      const columnsEl2 = dayColumnsRef.current;
      const scrollRect2 = scrollEl2.getBoundingClientRect();
      const columnsRect = columnsEl2.getBoundingClientRect();

      const columnWidth = columnsRect.width / 7;
      const cursorXInColumns = ev.clientX - columnsRect.left;
      const ghostDayIndex = Math.max(0, Math.min(6, Math.floor(cursorXInColumns / columnWidth)));

      if (ev.clientY < scrollRect2.top) {
        // Cursor is in the all-day zone — hide timed ghost, highlight the target column.
        dragGhostPositionRef.current = { dayIndex: ghostDayIndex, top: 0 };
        setDragRenderState(null);
        setTimedDragAllDayTarget({ dayIndex: ghostDayIndex, folderColor: state.folderColor });
        return;
      }

      // Cursor is in the timed grid — restore ghost, clear all-day highlight.
      setTimedDragAllDayTarget(null);

      const cursorYInGrid2 = ev.clientY - scrollRect2.top + scrollEl2.scrollTop;
      const blockH = state.block.isCompact ? COMPACT_BLOCK_HEIGHT : state.block.height;
      const rawTop = cursorYInGrid2 - state.grabOffsetY;
      const ghostTop = snapY(Math.max(0, Math.min(GRID_HEIGHT - blockH, rawTop)));

      dragGhostPositionRef.current = { dayIndex: ghostDayIndex, top: ghostTop };
      setDragRenderState({
        dayIndex: ghostDayIndex,
        folderColor: state.folderColor,
        height: state.block.height,
        isCompact: state.block.isCompact,
        pageId: state.pageId,
        top: ghostTop,
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();

      const state = dragRef.current;
      const ghostPos = dragGhostPositionRef.current;
      dragRef.current = null;
      dragGhostPositionRef.current = null;
      setDragRenderState(null);
      setTimedDragAllDayTarget(null);

      if (!state || !ghostPos) return;

      // Dropped above the timed grid → schedule as all-day on the target column's day.
      const scrollElUp = scrollRef.current;
      if (scrollElUp && lastClientY < scrollElUp.getBoundingClientRect().top) {
        const allDayTarget = days[ghostPos.dayIndex];
        if (allDayTarget) onReschedule(state.pageId, format(allDayTarget, "yyyy-MM-dd"), undefined);
        return;
      }

      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;

      const newStart = yToDate(ghostPos.top, targetDay);
      const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");

      let newEnd: string | undefined;
      if (!state.block.isCompact) {
        const durationMs = state.block.endDate.getTime() - state.block.startDate.getTime();
        newEnd = fmt(new Date(newStart.getTime() + durationMs));
      }

      onReschedule(state.pageId, fmt(newStart), newEnd);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Resize handlers ────────────────────────────────────────────────────────

  function handleBlockResizeStart({ block, dayIndex, pageId }: BlockResizeStartInfo) {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    disableSelect("dragging-resize");
    resizeRef.current = { block, dayIndex, pageId };
    const initialBottom = block.top + block.height;
    resizeGhostBottomRef.current = initialBottom;
    setResizeRenderState({ bottom: initialBottom, pageId });

    function onMove(ev: MouseEvent) {
      const state = resizeRef.current;
      if (!state || !scrollRef.current) return;

      const scrollEl2 = scrollRef.current;
      const scrollRect2 = scrollEl2.getBoundingClientRect();
      const cursorYInGrid = ev.clientY - scrollRect2.top + scrollEl2.scrollTop;
      const minBottom = state.block.top + MIN_RESIZE_HEIGHT;
      // No snapping during live drag — smooth resize. snapY is applied on commit via yToDate.
      const ghostBottom = Math.max(minBottom, Math.min(GRID_HEIGHT, cursorYInGrid));

      resizeGhostBottomRef.current = ghostBottom;
      setResizeRenderState({ bottom: ghostBottom, pageId: state.pageId });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();

      const state = resizeRef.current;
      const ghostBottom = resizeGhostBottomRef.current;
      resizeRef.current = null;
      resizeGhostBottomRef.current = null;
      setResizeRenderState(null);

      if (!state || ghostBottom === null) return;
      const targetDay = days[state.dayIndex];
      if (!targetDay) return;

      const newEnd = yToDate(ghostBottom, targetDay);
      const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");
      onReschedule(state.pageId, fmt(state.block.startDate), fmt(newEnd));
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── All-day chip drag into timed grid ──────────────────────────────────────

  function handleAllDayChipDragStart({
    folderColor,
    pageId,
  }: {
    folderColor: string | undefined;
    pageId: string;
  }) {
    disableSelect("dragging-grab");
    allDayDragRef.current = { folderColor, pageId };
    allDayGhostPositionRef.current = null;
    allDayHoverColumnRef.current = null;
    setAllDayDraggingPageId(pageId);

    function onMove(ev: MouseEvent) {
      const scrollEl = scrollRef.current;
      const columnsEl = dayColumnsRef.current;
      if (!scrollEl || !columnsEl) return;

      const scrollRect = scrollEl.getBoundingClientRect();
      const columnsRect = columnsEl.getBoundingClientRect();
      const columnWidth = columnsRect.width / 7;
      const hoverDayIndex = Math.max(
        0,
        Math.min(6, Math.floor((ev.clientX - columnsRect.left) / columnWidth))
      );

      // Cursor is in the all-day/header zone — track horizontal column, hide timed ghost.
      if (ev.clientY < scrollRect.top) {
        if (allDayGhostPositionRef.current !== null) {
          allDayGhostPositionRef.current = null;
          setAllDayDragRenderState(null);
        }
        allDayHoverColumnRef.current = hoverDayIndex;
        setAllDayDragHoverIndex(hoverDayIndex);
        return;
      }

      // Cursor is in the timed grid — clear all-day hover, show timed ghost.
      allDayHoverColumnRef.current = null;
      setAllDayDragHoverIndex(null);

      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const ghostTop = snapY(
        Math.max(0, Math.min(GRID_HEIGHT - COMPACT_BLOCK_HEIGHT, cursorYInGrid))
      );
      const ghostDayIndex = Math.max(
        0,
        Math.min(6, Math.floor((ev.clientX - columnsRect.left) / columnWidth))
      );

      allDayGhostPositionRef.current = { dayIndex: ghostDayIndex, top: ghostTop };
      setAllDayDragRenderState({ dayIndex: ghostDayIndex, folderColor, pageId, top: ghostTop });
    }

    function onUp(ev: MouseEvent) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();

      const state = allDayDragRef.current;
      const ghostPos = allDayGhostPositionRef.current;
      const hoverColumn = allDayHoverColumnRef.current;
      allDayDragRef.current = null;
      allDayGhostPositionRef.current = null;
      allDayHoverColumnRef.current = null;
      setAllDayDragRenderState(null);
      setAllDayDraggingPageId(null);
      setAllDayDragHoverIndex(null);

      if (!state) return;

      const scrollEl = scrollRef.current;
      // Dropped in the all-day zone → reschedule as all-day on the hovered column.
      if (scrollEl && ev.clientY < scrollEl.getBoundingClientRect().top) {
        if (hoverColumn === null) return;
        const targetDay = days[hoverColumn];
        if (targetDay) onReschedule(state.pageId, format(targetDay, "yyyy-MM-dd"), undefined);
        return;
      }

      // Dropped in the timed grid.
      if (!ghostPos) return;
      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;
      const newStart = yToDate(ghostPos.top, targetDay);
      onReschedule(state.pageId, format(newStart, "yyyy-MM-dd'T'HH:mm:ss"), undefined);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── External drag updater: called by useThreePanelDnD on every mousemove ───
  // Computes the drop slot from cursor coords, updates local preview state for
  // ghost rendering, and returns { start } (ISO string) for scheduleOnce.
  // Passing out-of-bounds coords (e.g. -1, -1) clears the preview.

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

    // Must be within the calendar panel horizontally.
    if (clientX < columnsRect.left || clientX > columnsRect.right) {
      setExternalPreview(null);
      return null;
    }
    // Must be within the calendar panel vertically (all-day row counts too).
    if (clientY < gridRect.top || clientY > scrollRect.bottom) {
      setExternalPreview(null);
      return null;
    }

    const columnWidth = columnsRect.width / 7;
    const dayIndex = Math.max(
      0,
      Math.min(6, Math.floor((clientX - columnsRect.left) / columnWidth))
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

    // Cursor in timed grid.
    const cursorYInGrid = clientY - scrollRect.top + scrollEl.scrollTop;
    const ghostHeight =
      durationMs != null
        ? Math.max((durationMs / 3_600_000) * HOUR_HEIGHT, COMPACT_BLOCK_HEIGHT)
        : COMPACT_BLOCK_HEIGHT;
    const top = snapY(Math.max(0, Math.min(GRID_HEIGHT - ghostHeight, cursorYInGrid)));
    const newStart = yToDate(top, targetDay);
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

  // Keep registerExternalDragUpdater pointed at the latest updateExternalDrag
  // so useThreePanelDnD always calls the current closure (fresh days, refs).
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

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={weekGridRef}>
      {/* Day header — "Mon 16", "Tue 17", etc. Today's date gets a pill highlight */}
      <div className="flex shrink-0 border-t border-b border-border/40">
        {/* Gutter spacer */}
        <div className="w-14 shrink-0" />
        {days.map((day) => {
          const isToday = isSameDay(day, today);
          return (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1 border-l border-border/40 py-1.5 first:border-l-0",
                isWeekend(day) ? "bg-white/[0.012]" : ""
              )}
              key={day.toISOString()}
            >
              <span
                className={cn(
                  "text-xs tracking-wide uppercase",
                  isToday ? "font-medium text-primary" : "text-muted-foreground/70"
                )}
              >
                {format(day, "EEE")}
              </span>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isToday ? "font-medium text-primary" : "text-muted-foreground/70"
                )}
              >
                {format(day, "d")}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day row — includes date numbers at top of each column */}
      <AllDaySection
        allDayDragHoverIndex={allDayDragHoverIndex}
        days={days}
        draggingPageId={allDayDraggingPageId}
        editingPageId={editingPageId}
        height={allDay.height}
        onCancelCreate={onCancelCreate}
        onChipDragStart={handleAllDayChipDragStart}
        onCommitTitle={onCommitTitle}
        onCreateAllDay={onCreateAllDay}
        onPageDoubleClick={onPageDoubleClick}
        onResizeStart={allDay.onResizeStart}
        pages={pages}
        timedDragTarget={
          externalPreview?.isAllDay
            ? { dayIndex: externalPreview.dayIndex, folderColor: externalPreview.folderColor }
            : timedDragAllDayTarget
        }
      />

      {/* Scrollable time grid */}
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="flex">
          <TimeGutter />
          <div className="flex flex-1" ref={dayColumnsRef}>
            {days.map((day, i) => {
              // Only pass the drag ghost to the column it targets.
              // Priority: all-day chip drag > internal block drag > external list drag.
              const colDragGhost: DragGhost | null =
                allDayDragRenderState?.dayIndex === i
                  ? {
                      folderColor: allDayDragRenderState.folderColor,
                      height: COMPACT_BLOCK_HEIGHT,
                      isCompact: true,
                      isDone:
                        pages.find((p) => p.id === allDayDragRenderState.pageId)?.status === "done",
                      title: pages.find((p) => p.id === allDayDragRenderState.pageId)?.title,
                      top: allDayDragRenderState.top,
                    }
                  : dragRenderState?.dayIndex === i
                    ? {
                        folderColor: dragRenderState.folderColor,
                        height: dragRenderState.height,
                        isCompact: dragRenderState.isCompact,
                        isDone:
                          pages.find((p) => p.id === dragRenderState.pageId)?.status === "done",
                        title: pages.find((p) => p.id === dragRenderState.pageId)?.title,
                        top: dragRenderState.top,
                      }
                    : externalPreview && !externalPreview.isAllDay && externalPreview.dayIndex === i
                      ? {
                          folderColor: externalPreview.folderColor,
                          height:
                            externalPreview.durationMs != null
                              ? Math.max(
                                  (externalPreview.durationMs / 3_600_000) * HOUR_HEIGHT,
                                  COMPACT_BLOCK_HEIGHT
                                )
                              : COMPACT_BLOCK_HEIGHT,
                          isCompact: externalPreview.durationMs == null,
                          isDone: externalPreview.isDone,
                          title: externalPreview.title,
                          top: externalPreview.top,
                        }
                      : null;

              return (
                <DayColumn
                  day={day}
                  dayIndex={i}
                  dragGhost={colDragGhost}
                  draggingPageId={dragRenderState?.pageId ?? null}
                  editingPageId={editingPageId}
                  isCurrentWeek={isCurrentWeek}
                  key={day.toISOString()}
                  now={now}
                  onBlockDragStart={handleBlockDragStart}
                  onBlockResizeStart={handleBlockResizeStart}
                  onCancelCreate={onCancelCreate}
                  onCommitTitle={onCommitTitle}
                  onCreatePage={onCreatePage}
                  onPageDoubleClick={onPageDoubleClick}
                  pages={pages}
                  resizeGhost={resizeRenderState}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
