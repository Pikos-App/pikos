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
import type { CalendarBlock, CalendarMetrics, CollapseGeometry } from "../utils/calendarUtils";
import {
  buildCollapseGeometry,
  chipFolderStyle,
  computeAllDayEdgeResize,
  formatTimeRange,
  mapHourToY,
  mapYToDate,
  mapYToHour,
  shiftAllDayEnd,
  snapYCollapse,
  VISIBLE_HOURS,
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
  /** Create an all-day page. Optional end date for multi-day spans (drag-to-create). */
  onCreateAllDay: (start: Date, end?: Date) => Promise<void> | void;
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
  const { registerExternalDragUpdater, rightPanel } = useUI();
  const settings = useCalendarSettings();
  const weekGridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayColumnsRef = useRef<HTMLDivElement>(null);
  useMinuteTick();
  const today = new Date();

  // Measure the scroll container so we can inflate hour rows when the viewport
  // is taller than `FIT_TO_VIEWPORT_HOURS * baseHourHeight`. Goal: calendar
  // uses the available vertical space for bigger, more readable blocks.
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

  // EditorPanel toggles panels via `hidden` (both mounted), so on first load
  // the calendar container has clientHeight=0 and ResizeObserver isn't guaranteed
  // to re-fire when `display: none → block`. Remeasure explicitly when the
  // panel becomes visible so the scroll-restore effect has a real height to
  // work with.
  useLayoutEffect(() => {
    if (rightPanel !== "calendar") return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight > 0 && el.clientHeight !== containerHeight) {
      setContainerHeight(el.clientHeight);
    }
  }, [rightPanel, containerHeight]);

  // Fit-to-viewport sizes hours so the visible "waking hours" middle fills
  // the available height. With both bands collapsed at the default 6am/10pm
  // boundaries that's exactly 16 hours; with the bands expanded we still aim
  // for the middle range, falling back to a min of 16 so an all-expanded grid
  // remains scrollable instead of collapsing into a fully-shown 24h view that
  // would leave zero scroll room.
  const visibleMiddleHours = Math.max(
    settings.collapse.bottomHour - settings.collapse.topHour,
    16
  );
  const effectiveHourHeight = Math.max(
    settings.metrics.hourHeight,
    containerHeight / visibleMiddleHours
  );
  const geometry: CollapseGeometry = buildCollapseGeometry(
    settings.collapse,
    effectiveHourHeight
  );
  const metrics: CalendarMetrics = {
    compactBlockHeight: effectiveHourHeight / 4,
    gridHeight: geometry.totalHeight,
    hourHeight: effectiveHourHeight,
    minResizeHeight: (15 / 60) * effectiveHourHeight,
  };
  const settingsValue = { ...settings, geometry, metrics };

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

  // ── All-day edge resize ────────────────────────────────────────────────────
  // Dragging the left or right edge of an all-day chip extends/shrinks the span.
  // Live preview is rendered by overriding the page's scheduledStart/End in the
  // pages list passed to AllDaySection — existing layout machinery reflows naturally.
  interface AllDayEdgePreview {
    pageId: string;
    startDate: string;
    endDate: string;
  }
  const allDayEdgeResizePreviewRef = useRef<AllDayEdgePreview | null>(null);
  const [allDayEdgeResizePreview, setAllDayEdgeResizePreview] = useState<AllDayEdgePreview | null>(
    null
  );

  // ── All-day drag-to-create ─────────────────────────────────────────────────
  // Mousedown on empty all-day space → track cursor across columns, render a
  // ghost overlay (absolutely positioned — does NOT participate in page row
  // assignment), commit on mouseup as a new page. The overlay approach avoids
  // the popover open-close-open dance that happens when a fake preview page
  // shares/swaps rows with the real chip.
  interface AllDayCreatePreview {
    startDayIndex: number;
    endDayIndex: number;
    moved: boolean;
  }
  const allDayCreatePreviewRef = useRef<AllDayCreatePreview | null>(null);
  const [allDayCreatePreview, setAllDayCreatePreview] = useState<AllDayCreatePreview | null>(null);

  // ── All-day drag state (all-day chip dragged into timed grid) ───────────────
  interface AllDayDragRefState {
    pageId: string;
    folderColor: string | undefined;
  }

  const allDayDragRef = useRef<AllDayDragRefState | null>(null);
  const allDayGhostPositionRef = useRef<{ dayIndex: number; top: number } | null>(null);
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
  // density changes — converted to/from pixels via the collapse-aware mapping
  // so a saved 9am also lands at 9am after the user toggles a band.
  //
  // Runs once, but deferred until containerHeight is measured — otherwise
  // metrics.hourHeight is the pre-fit-to-viewport base value and scrollTop
  // lands at the wrong hour on tall monitors.
  const didRestoreScrollRef = useRef(false);
  useEffect(() => {
    if (didRestoreScrollRef.current) return;
    if (containerHeight === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    didRestoreScrollRef.current = true;
    const raw = localStorage.getItem(SCROLL_STORAGE_KEY);
    const saved = raw !== null ? Number(raw) : NaN;
    // Values under 0.5h are treated as unset. Earlier builds had a scroll-clamp
    // bug on tall monitors that persisted scrollHour=0, which would otherwise
    // pin the calendar to midnight on every subsequent open.
    const hasUsableSaved = Number.isFinite(saved) && saved >= 0.5;
    const scrollHour = hasUsableSaved
      ? Math.min(saved, VISIBLE_HOURS)
      : Math.max(7, new Date().getHours() - 1);
    el.scrollTop = mapHourToY(scrollHour, geometry);
  }, [containerHeight, geometry]);

  // Persist scrollHour on scroll (debounced).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let tid: ReturnType<typeof setTimeout> | null = null;
    function handle() {
      if (!el) return;
      if (tid !== null) clearTimeout(tid);
      tid = setTimeout(() => {
        const scrollHour = mapYToHour(el.scrollTop, geometry);
        localStorage.setItem(SCROLL_STORAGE_KEY, String(scrollHour));
      }, SCROLL_PERSIST_DEBOUNCE_MS);
    }
    el.addEventListener("scroll", handle, { passive: true });
    return () => {
      el.removeEventListener("scroll", handle);
      if (tid !== null) clearTimeout(tid);
    };
  }, [geometry]);

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
          mapYToDate(top, day, geometry),
          mapYToDate(top + height, day, geometry)
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
    const initialTop = snapYCollapse(Math.max(0, block.top), geometry);
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

      const newStart = mapYToDate(ghostPos.top, targetDay, geometry);
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

      const newEnd = mapYToDate(ghostBottom, targetDay, geometry);
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

    // Render the ghost DOM once up-front. Position updates during the drag go
    // through positionGhost() — ref-based, no React re-render per frame.
    const page = pages.find((p) => p.id === pageId);
    setGhostContent({
      folderColor,
      height: metrics.compactBlockHeight,
      isCompact: true,
      isDone: page?.status === "done",
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
      // Dropped in the all-day zone → reschedule as all-day on the hovered column.
      if (scrollEl && ev.clientY < scrollEl.getBoundingClientRect().top) {
        if (hoverColumn === null) return;
        const targetDay = days[hoverColumn];
        if (!targetDay) return;
        const startStr = format(targetDay, "yyyy-MM-dd");
        // Preserve a multi-day span: a 4-day event dragged stays 4 days long.
        const page = pages.find((p) => p.id === state.pageId);
        const endStr = shiftAllDayEnd(page?.scheduledStart, page?.scheduledEnd, targetDay);
        onReschedule(state.pageId, startStr, endStr);
        return;
      }

      // Dropped in the timed grid.
      if (!ghostPos) return;
      const targetDay = days[ghostPos.dayIndex];
      if (!targetDay) return;
      const newStart = mapYToDate(ghostPos.top, targetDay, geometry);
      onReschedule(state.pageId, format(newStart, "yyyy-MM-dd'T'HH:mm:ss"), undefined);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── All-day edge resize ────────────────────────────────────────────────────
  // Clamps the grabbed edge to visible days. Past-edge-of-week drags stop at
  // the boundary — out-of-week extension is handled via the popover's date
  // picker. The non-grabbed ("anchor") edge is the opposite end of the span
  // at gesture start; during the drag, start = min(grabbed, anchor), end = max,
  // so crossing over the anchor flips the semantics without losing the range.

  function dayIndexFromClientX(clientX: number): number | null {
    const columnsEl = dayColumnsRef.current;
    if (!columnsEl) return null;
    const rect = columnsEl.getBoundingClientRect();
    const columnWidth = rect.width / days.length;
    return Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / columnWidth)));
  }

  function handleAllDayEdgeResizeStart({
    edge,
    pageId,
  }: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
  }) {
    const page = pages.find((p) => p.id === pageId);
    if (!page?.scheduledStart) return;
    const startStr = page.scheduledStart;
    const endStr = page.scheduledEnd ?? page.scheduledStart;
    // Anchor = the edge NOT being dragged. Stays fixed for the gesture.
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
      onReschedule(final.pageId, final.startDate, endArg);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── All-day drag-to-create ─────────────────────────────────────────────────
  // Mousedown on empty all-day space; mouseup commits.
  //   - No movement (plain click): single-day create → onCreateAllDay(start)
  //   - Dragged across columns: multi-day span → onCreateAllDay(start, end)

  function handleAllDayCreateDragStart({
    clientX,
    dayIndex,
  }: {
    clientX: number;
    clientY: number;
    dayIndex: number;
  }) {
    disableSelect("dragging-grab");
    allDayCreatePreviewRef.current = {
      endDayIndex: dayIndex,
      moved: false,
      startDayIndex: dayIndex,
    };
    // Ghost renders immediately at the first-free-row of the clicked column
    // (see AllDaySection) so it lands exactly where the real chip will mount on
    // commit — no visual jump between ghost → chip.
    setAllDayCreatePreview({ endDayIndex: dayIndex, moved: false, startDayIndex: dayIndex });
    const originClientX = clientX;

    function onMove(ev: MouseEvent) {
      const state = allDayCreatePreviewRef.current;
      if (!state) return;
      const idx = dayIndexFromClientX(ev.clientX);
      if (idx === null) return;
      const moved =
        state.moved || Math.abs(ev.clientX - originClientX) > 4 || idx !== state.startDayIndex;
      if (state.endDayIndex === idx && state.moved === moved) return;
      const next = { endDayIndex: idx, moved, startDayIndex: state.startDayIndex };
      allDayCreatePreviewRef.current = next;
      setAllDayCreatePreview(next);
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      const state = allDayCreatePreviewRef.current;
      // Clear the ghost overlay synchronously; the create/schedule chain below
      // is fast (setPages is optimistic) so the real chip appears on the next
      // render with minimal gap. The overlay is not a PageSummary, so it
      // doesn't interfere with row assignment or popover anchoring.
      allDayCreatePreviewRef.current = null;
      setAllDayCreatePreview(null);
      if (!state) return;
      const lo = Math.min(state.startDayIndex, state.endDayIndex);
      const hi = Math.max(state.startDayIndex, state.endDayIndex);
      const startDay = days[lo];
      const endDay = days[hi];
      if (!startDay || !endDay) return;
      void onCreateAllDay(startDay, state.moved && lo !== hi ? endDay : undefined);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Page list passed to AllDaySection, with live override for edge-resize
  // preview. Drag-to-create preview is rendered separately as an absolute
  // overlay so it doesn't participate in row assignment (see AllDaySection).
  const displayedAllDayPages: PageSummary[] = allDayEdgeResizePreview
    ? pages.map((p) =>
        p.id === allDayEdgeResizePreview.pageId
          ? {
              ...p,
              scheduledEnd: allDayEdgeResizePreview.endDate,
              scheduledStart: allDayEdgeResizePreview.startDate,
            }
          : p
      )
    : pages;

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
        {/* Day header — "Mon 16", "Tue 17", etc. Today's date gets a pill
            highlight. Mousedown routes through the same drag-to-create handler
            as the all-day column, so the header stays clickable even when the
            all-day section is scrolled past the fold. */}
        <div className="flex shrink-0 border-t border-b border-border/40">
          {/* Gutter spacer */}
          <div className="w-14 shrink-0" />
          {days.map((day, i) => {
            const isToday = isSameDay(day, today);
            return (
              <div
                aria-label={format(day, "EEEE, MMMM d")}
                className={cn(
                  "flex min-w-0 flex-1 cursor-cell items-center justify-center gap-1 border-l border-border/40 py-1.5 first:border-l-0",
                  isWeekend(day) ? "bg-white/[0.012]" : ""
                )}
                key={day.toISOString()}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  handleAllDayCreateDragStart({
                    clientX: e.clientX,
                    clientY: e.clientY,
                    dayIndex: i,
                  });
                }}
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
          createPreview={
            allDayCreatePreview
              ? {
                  endDayIndex: allDayCreatePreview.endDayIndex,
                  startDayIndex: allDayCreatePreview.startDayIndex,
                }
              : null
          }
          days={days}
          draggingPageId={allDayDraggingPageId}
          height={allDay.height}
          onAutoOpenConsumed={onAutoOpenConsumed}
          onChipDragStart={handleAllDayChipDragStart}
          onCreateDragStart={handleAllDayCreateDragStart}
          onEdgeResizeStart={handleAllDayEdgeResizeStart}
          onPageDoubleClick={onPageDoubleClick}
          onResizeStart={allDay.onResizeStart}
          pages={displayedAllDayPages}
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
                // External page-list drag ghost only. Internal block drag and
                // all-day chip drag both use the ref-positioned overlay below
                // to avoid per-frame re-renders.
                const colDragGhost: DragGhost | null =
                  externalPreview && !externalPreview.isAllDay && externalPreview.dayIndex === i
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
