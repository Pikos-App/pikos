import type { CalendarMetrics, CollapseGeometry, PageSummary } from "@pikos/core";
import { buildCollapseGeometry, COLLAPSED_BAND_HEIGHT, timedPagesByDay } from "@pikos/core";
import { useRef } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import {
  CalendarSettingsContext,
  useCalendarSettings,
} from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useNow } from "@/shared/hooks/useNow";

import { useAllDayCreate } from "../hooks/useAllDayCreate";
import { useAllDayDrag } from "../hooks/useAllDayDrag";
import { useDragGhost } from "../hooks/useDragGhost";
import { useExternalDropPreview } from "../hooks/useExternalDropPreview";
import { useHeightResize } from "../hooks/useHeightResize";
import { useScrollPersist } from "../hooks/useScrollPersist";
import { useTimedDrag } from "../hooks/useTimedDrag";
import { useTimedResize } from "../hooks/useTimedResize";
import { eatNextClick } from "../utils/eatNextClick";
import { AllDaySection } from "./AllDaySection";
import type { DragGhost } from "./DayColumn";
import { DayColumn } from "./DayColumn";
import { DayHeaderRow } from "./DayHeaderRow";
import { DragGhostOverlay } from "./DragGhostOverlay";
import { TimeGutter } from "./TimeGutter";

interface WeekGridProps {
  days: Date[];
  autoOpenPageId: string | null;
  isCurrentWeek: boolean;
  onAutoOpenConsumed: () => void;
  onCreateAllDay: (start: Date, end?: Date) => Promise<void> | void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  /** With `originalDate` the dragged block is a virtual rrule occurrence: materialise an override rather than mutate the head. */
  onReschedule: (pageId: string, start: string, end?: string, originalDate?: string) => void;
  pages: PageSummary[];
  loading: boolean;
}

function disableSelect(cursorClass: "dragging-grab" | "dragging-resize") {
  document.body.style.userSelect = "none";
  document.documentElement.classList.add(cursorClass);
}
function enableSelect() {
  document.body.style.userSelect = "";
  document.documentElement.classList.remove("dragging-grab", "dragging-resize");
}

export function WeekGrid({
  autoOpenPageId,
  days,
  isCurrentWeek,
  loading,
  onAutoOpenConsumed,
  onCreateAllDay,
  onCreatePage,
  onPageDoubleClick,
  onReschedule,
  pages,
}: WeekGridProps) {
  const { calendarScrollRequest, rightPanel } = useUI();
  const settings = useCalendarSettings();
  const weekGridRef = useRef<HTMLDivElement>(null);
  const dayColumnsRef = useRef<HTMLDivElement>(null);
  const today = useNow();

  // useScrollPersist needs geometry to map an hour to a pixel, but the fit-to-viewport geometry
  // needs its measured containerHeight. Break the cycle with a first-pass geometry at the base hour
  // height, which the hook reads once on restore.
  const baseGeometry = buildCollapseGeometry(settings.collapse, settings.metrics.hourHeight);
  const { containerHeight, scrollRef } = useScrollPersist({
    calendarScrollRequest,
    geometry: baseGeometry,
    rightPanel,
  });

  // Fit-to-viewport sizes hours so the grid fills the height exactly, with no dead space below the
  // last visible hour. Fixed-height collapsed bands subtract first, so the stretch divides only the
  // hour-pitched portion.
  const renderedHours =
    (settings.collapse.topCollapsed ? 0 : settings.collapse.topHour) +
    (settings.collapse.bottomHour - settings.collapse.topHour) +
    (settings.collapse.bottomCollapsed ? 0 : 24 - settings.collapse.bottomHour);
  const fixedBandTotal =
    (settings.collapse.topCollapsed ? COLLAPSED_BAND_HEIGHT : 0) +
    (settings.collapse.bottomCollapsed ? COLLAPSED_BAND_HEIGHT : 0);
  const fillHourHeight = renderedHours > 0 ? (containerHeight - fixedBandTotal) / renderedHours : 0;
  const effectiveHourHeight = Math.max(settings.metrics.hourHeight, fillHourHeight);
  const geometry: CollapseGeometry = buildCollapseGeometry(settings.collapse, effectiveHourHeight);
  // Only the height-derived values change when the grid stretches to fill its
  // container. The block layout tiers come from the calendar text size, so they
  // are carried over rather than recomputed from the stretched hour.
  const metrics: CalendarMetrics = {
    ...settings.metrics,
    compactBlockHeight: effectiveHourHeight / 4,
    gridHeight: geometry.totalHeight,
    hourHeight: effectiveHourHeight,
    minResizeHeight: (15 / 60) * effectiveHourHeight,
  };
  const settingsValue = { ...settings, geometry, metrics };

  const {
    ghostContent,
    ghostRefCallback,
    ghostTimeLabelRefCallback,
    hideGhost,
    positionGhost,
    queueInitialPosition: queueInitialGhostPosition,
    setGhostContent,
    showGhost,
  } = useDragGhost({ dayColumnsRef, days, geometry });
  const pagesByDay = timedPagesByDay(pages, days);

  const { handleBlockResizeStart, resizeRenderState } = useTimedResize({
    days,
    disableSelect,
    eatNextClick,
    enableSelect,
    geometry,
    metrics,
    onReschedule,
    scrollRef,
  });

  const { handleBlockDragStart, timedDragAllDayTarget, timedDragDayIndex, timedDraggingPageId } =
    useTimedDrag({
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
    });

  const {
    allDayDraggingPageId,
    allDayDragHoverIndex,
    allDayEdgeResizePreview,
    handleAllDayChipDragStart,
    handleAllDayEdgeResizeStart,
  } = useAllDayDrag({
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
  });

  const { allDayCreatePreview, handleAllDayCreateDragStart } = useAllDayCreate({
    dayColumnsRef,
    days,
    disableSelect,
    eatNextClick,
    enableSelect,
    onCreateAllDay,
  });

  const { externalPreview } = useExternalDropPreview({
    dayColumnsRef,
    days,
    geometry,
    metrics,
    scrollRef,
    weekGridRef,
  });

  const allDay = useHeightResize({
    defaultHeight: 60,
    max: 200,
    min: 30,
    scale: metrics.zoom,
    storageKey: STORAGE_KEYS.calendarAllDayHeight,
  });

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

  return (
    <CalendarSettingsContext.Provider value={settingsValue}>
      <div
        aria-busy={loading}
        aria-label="Week calendar"
        className="flex min-h-0 flex-1 flex-col"
        ref={weekGridRef}
        role="region"
      >
        <DayHeaderRow days={days} onCreateDragStart={handleAllDayCreateDragStart} today={today} />

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

        <div aria-label="Time grid" className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
          <div className="flex">
            <TimeGutter />
            <div className="relative flex flex-1" ref={dayColumnsRef}>
              {days.map((day, i) => {
                // External page-list drag ghost only; internal drags use the ref-positioned overlay below.
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

                const isDropTarget = colDragGhost !== null || timedDragDayIndex === i;
                return (
                  <DayColumn
                    autoOpenPageId={autoOpenPageId}
                    day={day}
                    dayIndex={i}
                    dragGhost={colDragGhost}
                    draggingPageId={timedDraggingPageId}
                    isCurrentWeek={isCurrentWeek}
                    isDropTarget={isDropTarget}
                    // Keyed by slot, not date: a column keeps its measured width across a week
                    // change. A fresh column renders unmeasured, which lays out every block of a
                    // busy day before collapsing them into a pill.
                    key={i}
                    now={today}
                    onAutoOpenConsumed={onAutoOpenConsumed}
                    onBlockDragStart={handleBlockDragStart}
                    onBlockResizeStart={handleBlockResizeStart}
                    onCreatePage={onCreatePage}
                    onPageDoubleClick={onPageDoubleClick}
                    pages={pagesByDay[i]!}
                    resizeGhost={resizeRenderState?.dayIndex === i ? resizeRenderState : null}
                  />
                );
              })}

              {ghostContent && (
                <DragGhostOverlay
                  content={ghostContent}
                  ghostRefCallback={ghostRefCallback}
                  ghostTimeLabelRefCallback={ghostTimeLabelRefCallback}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </CalendarSettingsContext.Provider>
  );
}
