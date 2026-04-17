import type { PageSummary } from "@pikos/core";
import { format, isSameDay } from "date-fns";
import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  CalendarSettingsContext,
  useCalendarSettings,
} from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";

function isWeekend(day: Date) {
  const d = day.getDay();
  return d === 0 || d === 6;
}

import { useHeightResize } from "../hooks/useHeightResize";
import type { CalendarBlock, CalendarMetrics } from "../utils/calendarUtils";
import {
  chipFolderStyle,
  formatTimeRange,
  snapY,
  VISIBLE_HOURS,
  yToDate,
} from "../utils/calendarUtils";
import { AllDaySection } from "./AllDaySection";
import type { BlockDragStartInfo, BlockResizeStartInfo, DragGhost, ResizeGhost } from "./DayColumn";
import { DayColumn } from "./DayColumn";
import { TimeGutter } from "./TimeGutter";

interface WeekGridProps {
  days: Date[];
  autoOpenPageId: string | null;
  isCurrentWeek: boolean;
  onAutoOpenConsumed: () => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  onReschedule: (pageId: string, start: string, end?: string) => void;
  pages: PageSummary[];
}

/**
 * Scroll position is persisted as an hour offset (0–24) so the stored value is
 * independent of density. On first mount (no saved value) we smart-start at
 * max(7am, currentHour − 1) so "now" is visible without burying it.
 */
const SCROLL_STORAGE_KEY = "pikos:calendarScrollHour";
const SCROLL_PERSIST_DEBOUNCE_MS = 200;

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
  autoOpenPageId,
  days,
  isCurrentWeek,
  onAutoOpenConsumed,
  onCreateAllDay,
  onCreatePage,
  onPageDoubleClick,
  onReschedule,
  pages,
}: WeekGridProps) {
  const { registerExternalDragUpdater } = useUI();
  const settings = useCalendarSettings();
  const weekGridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayColumnsRef = useRef<HTMLDivElement>(null);
  useMinuteTick();
  const today = new Date();

  // Measure the scroll container so we can inflate hour rows when the viewport
  // is taller than 24 * baseHourHeight. Goal: calendar always fills available
  // space instead of leaving empty area below the last hour at any density.
  const [containerHeight, setContainerHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Derived "effective" metrics: hour height grows to fit the viewport when
  // the base density leaves empty space. Shrinks back when content overflows.
  const effectiveHourHeight = Math.max(
    settings.metrics.hourHeight,
    containerHeight / VISIBLE_HOURS
  );
  const metrics: CalendarMetrics = {
    compactBlockHeight: effectiveHourHeight / 4,
    gridHeight: effectiveHourHeight * VISIBLE_HOURS,
    hourHeight: effectiveHourHeight,
    minResizeHeight: (15 / 60) * effectiveHourHeight,
  };
  const settingsValue = { ...settings, metrics };

  // ── Drag-to-reschedule ──────────────────────────────────────────────────────
  const dragRef = useRef<DragRefState | null>(null);
  const dragGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
  const [timedDraggingPageId, setTimedDraggingPageId] = useState<string | null>(null);
  const [ghostContent, setGhostContent] = useState<{
    folderColor: string | undefined;
    height: number;
    isCompact: boolean;
    isDone: boolean;
    title: string;
  } | null>(null);
  const ghostElRef = useRef<HTMLDivElement>(null);
  const ghostTimeLabelRef = useRef<HTMLParagraphElement>(null);
  const rafIdRef = useRef(0);
  const resizeRafIdRef = useRef(0);
  const timedAllDayTargetDayIndexRef = useRef<number | null>(null);

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

  // Initial scroll: restore saved scrollHour, else smart-start at max(7am, now-1h).
  // Persist scroll position as an hour offset (0–24) so the saved value survives
  // density changes — `scrollTop = scrollHour * hourHeight` regardless of density.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raw = localStorage.getItem(SCROLL_STORAGE_KEY);
    const saved = raw !== null ? Number(raw) : NaN;
    const scrollHour = Number.isFinite(saved)
      ? Math.min(Math.max(saved, 0), VISIBLE_HOURS)
      : Math.max(7, new Date().getHours() - 1);
    el.scrollTop = scrollHour * metrics.hourHeight;
    // Intentionally runs once on mount — subsequent density changes shouldn't
    // snap scroll back to a saved position.
  }, []);

  // Persist scrollHour on scroll (debounced).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let tid: ReturnType<typeof setTimeout> | null = null;
    function handle() {
      if (!el) return;
      if (tid !== null) clearTimeout(tid);
      tid = setTimeout(() => {
        const scrollHour = el.scrollTop / metrics.hourHeight;
        localStorage.setItem(SCROLL_STORAGE_KEY, String(scrollHour));
      }, SCROLL_PERSIST_DEBOUNCE_MS);
    }
    el.addEventListener("scroll", handle, { passive: true });
    return () => {
      el.removeEventListener("scroll", handle);
      if (tid !== null) clearTimeout(tid);
    };
  }, [metrics.hourHeight]);

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

  // ── Ghost positioning (bypasses React render cycle) ─────────────────────────

  function positionGhost(dayIndex: number, top: number, height: number) {
    const el = ghostElRef.current;
    const cols = dayColumnsRef.current;
    if (!el || !cols) return;
    const colW = cols.clientWidth / days.length;
    el.style.left = `${dayIndex * colW + 2}px`;
    el.style.top = `${top}px`;
    el.style.width = `${colW - 4}px`;
    el.style.height = `${height}px`;
    if (ghostTimeLabelRef.current) {
      const day = days[dayIndex];
      if (day) {
        ghostTimeLabelRef.current.textContent = formatTimeRange(
          yToDate(top, day, metrics.hourHeight),
          yToDate(top + height, day, metrics.hourHeight)
        );
      }
    }
  }

  function hideGhost() {
    if (ghostElRef.current) ghostElRef.current.style.display = "none";
  }

  function showGhost() {
    if (ghostElRef.current) ghostElRef.current.style.display = "";
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
    const initialTop = snapY(Math.max(0, block.top), metrics.hourHeight);
    dragGhostPositionRef.current = { dayIndex, top: initialTop };
    timedAllDayTargetDayIndexRef.current = null;

    const page = pages.find((p) => p.id === pageId);
    const blockH = block.height;
    setTimedDraggingPageId(pageId);
    setGhostContent({
      folderColor,
      height: blockH,
      isCompact: block.isCompact,
      isDone: page?.status === "done",
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
        return;
      }

      if (timedAllDayTargetDayIndexRef.current !== null) {
        timedAllDayTargetDayIndexRef.current = null;
        setTimedDragAllDayTarget(null);
      }

      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const bH = state.block.height;
      const rawTop = cursorYInGrid - state.grabOffsetY;
      const ghostTop = snapY(
        Math.max(0, Math.min(metrics.gridHeight - bH, rawTop)),
        metrics.hourHeight
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
      setTimedDraggingPageId(null);
      setGhostContent(null);
      setTimedDragAllDayTarget(null);

      if (!state || !ghostPos) return;

      const scrollElUp = scrollRef.current;
      if (scrollElUp && lastClientY < scrollElUp.getBoundingClientRect().top) {
        const allDayTarget = days[ghostPos.dayIndex];
        if (allDayTarget) onReschedule(state.pageId, format(allDayTarget, "yyyy-MM-dd"), undefined);
        return;
      }

      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;

      const newStart = yToDate(ghostPos.top, targetDay, metrics.hourHeight);
      const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");

      // Preserve duration whenever the event actually has one. The previous
      // `!isCompact` check conflated "rendered as chip" with "no explicit end",
      // which dropped the duration of short-but-timed events (e.g. 30m at
      // compact density) on drag.
      const durationMs = state.block.endDate.getTime() - state.block.startDate.getTime();
      const newEnd = durationMs > 0 ? fmt(new Date(newStart.getTime() + durationMs)) : undefined;

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
    setResizeRenderState({ bottom: initialBottom, dayIndex, pageId });

    function onMove(ev: MouseEvent) {
      const state = resizeRef.current;
      if (!state || !scrollRef.current) return;

      const scrollEl = scrollRef.current;
      const scrollRect = scrollEl.getBoundingClientRect();
      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const minBottom = state.block.top + metrics.minResizeHeight;
      // No snapping during live drag — smooth resize. snapY is applied on commit via yToDate.
      const ghostBottom = Math.max(minBottom, Math.min(metrics.gridHeight, cursorYInGrid));

      resizeGhostBottomRef.current = ghostBottom;
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = requestAnimationFrame(() => {
        setResizeRenderState({
          bottom: ghostBottom,
          dayIndex: state.dayIndex,
          pageId: state.pageId,
        });
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      cancelAnimationFrame(resizeRafIdRef.current);

      const state = resizeRef.current;
      const ghostBottom = resizeGhostBottomRef.current;
      resizeRef.current = null;
      resizeGhostBottomRef.current = null;
      setResizeRenderState(null);

      if (!state || ghostBottom === null) return;
      const targetDay = days[state.dayIndex];
      if (!targetDay) return;

      const newEnd = yToDate(ghostBottom, targetDay, metrics.hourHeight);
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
        Math.max(0, Math.min(metrics.gridHeight - metrics.compactBlockHeight, cursorYInGrid)),
        metrics.hourHeight
      );
      const ghostDayIndex = Math.max(
        0,
        Math.min(dayCount - 1, Math.floor((ev.clientX - columnsRect.left) / columnWidth))
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
      const newStart = yToDate(ghostPos.top, targetDay, metrics.hourHeight);
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

    // Cursor in timed grid.
    const cursorYInGrid = clientY - scrollRect.top + scrollEl.scrollTop;
    const ghostHeight =
      durationMs != null
        ? Math.max((durationMs / 3_600_000) * metrics.hourHeight, metrics.compactBlockHeight)
        : metrics.compactBlockHeight;
    const top = snapY(
      Math.max(0, Math.min(metrics.gridHeight - ghostHeight, cursorYInGrid)),
      metrics.hourHeight
    );
    const newStart = yToDate(top, targetDay, metrics.hourHeight);
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
    <CalendarSettingsContext.Provider value={settingsValue}>
      <div
        aria-label="Week calendar"
        className="flex min-h-0 flex-1 flex-col"
        ref={weekGridRef}
        role="region"
      >
        {/* Day header — "Mon 16", "Tue 17", etc. Today's date gets a pill highlight */}
        <div className="flex shrink-0 border-t border-b border-border/40">
          {/* Gutter spacer */}
          <div className="w-14 shrink-0" />
          {days.map((day) => {
            const isToday = isSameDay(day, today);
            return (
              <div
                aria-label={format(day, "EEEE, MMMM d")}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-1 border-l border-border/40 py-1.5 first:border-l-0",
                  isWeekend(day) ? "bg-white/[0.012]" : ""
                )}
                key={day.toISOString()}
              >
                <span
                  className={cn(
                    "type-ui-sm tracking-wide uppercase",
                    isToday ? "text-primary" : "text-subtle"
                  )}
                >
                  {format(day, "EEE")}
                </span>
                <span
                  className={cn(
                    "type-ui-sm tabular-nums",
                    isToday ? "text-primary" : "text-subtle"
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
          autoOpenPageId={autoOpenPageId}
          days={days}
          draggingPageId={allDayDraggingPageId}
          height={allDay.height}
          onAutoOpenConsumed={onAutoOpenConsumed}
          onChipDragStart={handleAllDayChipDragStart}
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
        <div aria-label="Time grid" className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
          <div className="flex">
            <TimeGutter />
            <div className="relative flex flex-1" ref={dayColumnsRef}>
              {days.map((day, i) => {
                // Only pass the drag ghost to the column it targets.
                // Priority: all-day chip drag > external list drag. Internal block
                // drag uses a ref-positioned overlay (below) to avoid per-frame re-renders.
                const colDragGhost: DragGhost | null =
                  allDayDragRenderState?.dayIndex === i
                    ? {
                        folderColor: allDayDragRenderState.folderColor,
                        height: metrics.compactBlockHeight,
                        isCompact: true,
                        isDone:
                          pages.find((p) => p.id === allDayDragRenderState.pageId)?.status ===
                          "done",
                        title: pages.find((p) => p.id === allDayDragRenderState.pageId)?.title,
                        top: allDayDragRenderState.top,
                      }
                    : externalPreview && !externalPreview.isAllDay && externalPreview.dayIndex === i
                      ? {
                          folderColor: externalPreview.folderColor,
                          height:
                            externalPreview.durationMs != null
                              ? Math.max(
                                  (externalPreview.durationMs / 3_600_000) * metrics.hourHeight,
                                  metrics.compactBlockHeight
                                )
                              : metrics.compactBlockHeight,
                          isCompact: externalPreview.durationMs == null,
                          isDone: externalPreview.isDone,
                          title: externalPreview.title,
                          top: externalPreview.top,
                        }
                      : null;

                return (
                  <DayColumn
                    autoOpenPageId={autoOpenPageId}
                    day={day}
                    dayIndex={i}
                    dragGhost={colDragGhost}
                    draggingPageId={timedDraggingPageId}
                    isCurrentWeek={isCurrentWeek}
                    key={day.toISOString()}
                    now={today}
                    onAutoOpenConsumed={onAutoOpenConsumed}
                    onBlockDragStart={handleBlockDragStart}
                    onBlockResizeStart={handleBlockResizeStart}
                    onCreatePage={onCreatePage}
                    onPageDoubleClick={onPageDoubleClick}
                    pages={pages}
                    resizeGhost={resizeRenderState?.dayIndex === i ? resizeRenderState : null}
                  />
                );
              })}

              {/* Drag ghost overlay — content via state (2x/gesture), position via ref (every frame) */}
              {ghostContent && (
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute z-30 overflow-hidden rounded-sm border-l-2 opacity-80",
                    ghostContent.isCompact
                      ? "flex items-center gap-1 px-1.5"
                      : "flex flex-col items-start px-1.5 py-0.5"
                  )}
                  ref={(el) => {
                    ghostElRef.current = el;
                    if (el && dragGhostPositionRef.current) {
                      positionGhost(
                        dragGhostPositionRef.current.dayIndex,
                        dragGhostPositionRef.current.top,
                        ghostContent.height
                      );
                    }
                  }}
                  style={
                    ghostContent.folderColor
                      ? chipFolderStyle(ghostContent.folderColor)
                      : { backgroundColor: "rgba(59,130,246,0.25)", borderColor: "rgb(59,130,246)" }
                  }
                >
                  {ghostContent.isCompact ? (
                    <>
                      <span
                        className={cn(
                          "flex shrink-0 items-center justify-center rounded-[2px] border",
                          ghostContent.height < 16 ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
                          ghostContent.isDone
                            ? "border-foreground/40 bg-foreground/10"
                            : "border-current/30"
                        )}
                      >
                        {ghostContent.isDone && <Check size={8} strokeWidth={2.5} />}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate font-medium text-foreground",
                          ghostContent.height < 16
                            ? "-mt-px text-[10px] leading-none"
                            : "type-body-sm"
                        )}
                      >
                        {ghostContent.title || "Untitled"}
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="flex w-full min-w-0 items-center gap-1">
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border",
                            ghostContent.isDone
                              ? "border-foreground/40 bg-foreground/10"
                              : "border-current/30"
                          )}
                        >
                          {ghostContent.isDone && <Check size={8} strokeWidth={2.5} />}
                        </span>
                        <p className="type-body-sm min-w-0 truncate font-medium text-foreground">
                          {ghostContent.title || "Untitled"}
                        </p>
                      </div>
                      {ghostContent.height >= 40 && (
                        <p
                          className="type-ui-sm mt-0.5 truncate text-subtle"
                          ref={ghostTimeLabelRef}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </CalendarSettingsContext.Provider>
  );
}
