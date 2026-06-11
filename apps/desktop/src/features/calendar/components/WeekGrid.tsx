import type { PageSummary } from "@pikos/core";
import { useRef } from "react";

import {
  CalendarSettingsContext,
  useCalendarSettings,
} from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";

import { useAllDayCreate } from "../hooks/useAllDayCreate";
import { useAllDayDrag } from "../hooks/useAllDayDrag";
import { useDragGhost } from "../hooks/useDragGhost";
import { useExternalDropPreview } from "../hooks/useExternalDropPreview";
import { useHeightResize } from "../hooks/useHeightResize";
import { useScrollPersist } from "../hooks/useScrollPersist";
import { useTimedDrag } from "../hooks/useTimedDrag";
import { useTimedResize } from "../hooks/useTimedResize";
import { COLLAPSED_BAND_HEIGHT } from "../utils/calendarConstants";
import {
  buildCollapseGeometry,
  type CalendarMetrics,
  type CollapseGeometry,
} from "../utils/calendarGeometry";
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
  /** Create an all-day page. Optional end date for multi-day spans (drag-to-create). */
  onCreateAllDay: (start: Date, end?: Date) => Promise<void> | void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  /** When `originalDate` is set, the dragged block is a virtual rrule occurrence
   * — caller should materialise an override instead of mutating the head schedule. */
  onReschedule: (pageId: string, start: string, end?: string, originalDate?: string) => void;
  pages: PageSummary[];
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
  useMinuteTick();
  const today = new Date();

  // Geometry needs a stable shape before useScrollPersist can map an hour to
  // a pixel, but the final fit-to-viewport geometry depends on the measured
  // containerHeight from useScrollPersist. Resolve the cycle by computing a
  // first-pass geometry at the base hour height; the hook reads it once on
  // restore. Subsequent re-renders use the fit-to-viewport geometry.
  const baseGeometry = buildCollapseGeometry(settings.collapse, settings.metrics.hourHeight);
  const { containerHeight, scrollRef } = useScrollPersist({
    calendarScrollRequest,
    geometry: baseGeometry,
    rightPanel,
  });

  // Fit-to-viewport sizes hours so the rendered grid fills the available
  // height exactly — midnight (or whichever hour ends the visible range)
  // sits at the bottom edge of the scroll area with no dead space below.
  // Fixed-height collapsed bands subtract from the available space first so
  // the per-hour stretch only divides the truly hour-pitched portion.
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
  const metrics: CalendarMetrics = {
    compactBlockHeight: effectiveHourHeight / 4,
    gridHeight: geometry.totalHeight,
    hourHeight: effectiveHourHeight,
    minResizeHeight: (15 / 60) * effectiveHourHeight,
  };
  const settingsValue = { ...settings, geometry, metrics };

  // Shared drag ghost — owned by the ghost hook; consumed by useTimedDrag and
  // useAllDayDrag via individual imperative functions (avoids ref leaks).
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
    storageKey: "pikos:calendarAllDayHeight",
  });

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

  return (
    <CalendarSettingsContext.Provider value={settingsValue}>
      <div
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

              {/* Drag ghost overlay — content via state (2x/gesture),
                  position via ref (every frame). */}
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
