import type { PageSummary } from "@pikos/core";
import {
  assignStableAllDayRows,
  barPositionStyle,
  buildAllDayBars,
  firstFreeRowInSpan,
} from "@pikos/core";
import { format } from "date-fns";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { usePages } from "@/shared/context/PagesContext";

import { chipFolderStyle } from "../utils/calendarColors";
import { CALENDAR_GUTTER_WIDTH } from "../utils/gutterWidth";
import { AllDayBar } from "./AllDayBar";

/** Rows drawn past each edge of the strip's scrolled view. A busy week holds hundreds of bars in
 *  a strip a few rows tall, and drawing them all was most of the cost of showing the week. */
const OVERSCAN_ROWS = 4;

interface AllDaySectionProps {
  allDayDragHoverIndex: number | null;
  autoOpenPageId: string | null;
  /** Ghost overlay spanning [startDayIndex..endDayIndex] at the first-free row during drag-to-create;
   *  absolute, so it stays outside bar layout. */
  createPreview: { startDayIndex: number; endDayIndex: number } | null;
  days: Date[];
  draggingPageId: string | null;
  height: number;
  onAutoOpenConsumed: () => void;
  onChipDragStart: (info: {
    folderColor: string | undefined;
    pageId: string;
    originalDate?: string;
  }) => void;
  onCreateDragStart: (info: { clientX: number; clientY: number; dayIndex: number }) => void;
  onEdgeResizeStart: (info: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
    originalDate?: string;
  }) => void;
  onPageDoubleClick: (pageId: string) => void;
  onResizeStart: (e: React.PointerEvent<HTMLElement>) => void;
  pages: PageSummary[];
  timedDragTarget: { dayIndex: number; folderColor: string | undefined } | null;
}

/**
 * All-day event strip between the day-name row and the time grid. Each event is one
 * absolutely-positioned bar spanning its columns; the day columns are thin backgrounds that
 * handle striping, dividers, drag-target highlight and click-to-create.
 */
export function AllDaySection({
  allDayDragHoverIndex,
  autoOpenPageId,
  createPreview,
  days,
  draggingPageId,
  height,
  onAutoOpenConsumed,
  onChipDragStart,
  onCreateDragStart,
  onEdgeResizeStart,
  onPageDoubleClick,
  onResizeStart,
  pages,
  timedDragTarget,
}: AllDaySectionProps) {
  const { folders } = usePages();
  const { metrics } = useCalendarSettings();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );
  const slotsByDay = assignStableAllDayRows(pages, days);
  const bars = buildAllDayBars(slotsByDay);
  const rowCount = slotsByDay[0]?.length ?? 0;
  const columnCount = days.length;
  // Every row plus symmetric padding; min-h-full keeps backgrounds reaching the bottom when bars are few.
  const contentMinHeight = metrics.allDayTopPadding * 2 + rowCount * metrics.allDayRowHeight;

  // Auto-open fires on at most one bar. `!continuesLeft` rules out week-crossed continuations
  // (autoOpen targets a newly created page, which starts inside the view); if several bars still
  // match (shared-id recurring), the first wins.
  const autoOpenBarKey = autoOpenPageId
    ? (bars.find((b) => b.page.id === autoOpenPageId && !b.continuesLeft)?.key ?? null)
    : null;

  const [scrollTop, setScrollTop] = useState(0);
  const firstRow =
    Math.floor((scrollTop - metrics.allDayTopPadding) / metrics.allDayRowHeight) - OVERSCAN_ROWS;
  const lastRow = Math.ceil((scrollTop + height) / metrics.allDayRowHeight) + OVERSCAN_ROWS;
  const drawnBars = bars.filter(
    (bar) =>
      (bar.row >= firstRow && bar.row <= lastRow) ||
      bar.key === autoOpenBarKey ||
      bar.page.id === draggingPageId
  );

  const previewBounds = createPreview
    ? {
        hi: Math.max(createPreview.startDayIndex, createPreview.endDayIndex),
        lo: Math.min(createPreview.startDayIndex, createPreview.endDayIndex),
      }
    : null;
  // Matches where assignAllDayRows places the new bar on commit, so the ghost doesn't jump.
  const previewTopPx = previewBounds
    ? metrics.allDayTopPadding +
      firstFreeRowInSpan(slotsByDay, previewBounds.lo, previewBounds.hi) * metrics.allDayRowHeight
    : 0;

  function handleColumnPointerDown(e: React.PointerEvent, dayIndex: number) {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    onCreateDragStart({ clientX: e.clientX, clientY: e.clientY, dayIndex });
  }

  return (
    <div className="relative shrink-0 border-b border-border/50" style={{ height }}>
      {/* Scrolls rather than clips past the user-set height; `min-h-full` keeps weekend bg and dividers to the bottom edge. */}
      <div
        aria-label="All-day events"
        className="h-full overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:hidden"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        role="group"
      >
        <div className="flex min-h-full">
          <div className={cn(CALENDAR_GUTTER_WIDTH, "shrink-0")} />

          <div className="relative flex flex-1" style={{ minHeight: contentMinHeight }}>
            {days.map((day, dayIndex) => {
              const weekend = day.getDay() === 0 || day.getDay() === 6;
              const isAllDayTarget = allDayDragHoverIndex === dayIndex;
              const isTimedTarget = timedDragTarget?.dayIndex === dayIndex;
              return (
                <div
                  aria-label={`All-day events, ${format(day, "EEEE MMMM d")}`}
                  className={cn(
                    // The same divider the time grid draws, not a look-alike: a pseudo-element at another opacity
                    // antialiased differently on a fractional column edge and sat a pixel off. Unlike the grid, the
                    // first column keeps its border: the gutter beside it is empty here, so the line closes the row.
                    "relative min-w-0 flex-1 cursor-cell border-l border-border/50",
                    weekend && "bg-white/[0.012]",
                    (isAllDayTarget || isTimedTarget) && "bg-accent/30"
                  )}
                  data-day-index={dayIndex}
                  key={day.toISOString()}
                  onPointerDown={(e) => handleColumnPointerDown(e, dayIndex)}
                  role="button"
                  tabIndex={-1}
                />
              );
            })}

            {/* pointer-events-none routes clicks on empty space to the columns beneath; each bar re-enables
                it. No aria-hidden: that would take every bar out of the accessibility tree. */}
            <div className="pointer-events-none absolute inset-0">
              {drawnBars.map((bar) => {
                const folderColor = bar.page.folderId
                  ? folderColorMap.get(bar.page.folderId)
                  : undefined;
                return (
                  <AllDayBar
                    autoOpenPopover={autoOpenBarKey === bar.key}
                    bar={bar}
                    draggingPageId={draggingPageId}
                    folderColor={folderColor}
                    key={bar.key}
                    onAutoOpenConsumed={onAutoOpenConsumed}
                    onDoubleClick={onPageDoubleClick}
                    onDragStart={onChipDragStart}
                    onEdgeResizeStart={onEdgeResizeStart}
                    position={barPositionStyle(bar, columnCount, {
                      rowHeight: metrics.allDayRowHeight,
                      topPadding: metrics.allDayTopPadding,
                    })}
                  />
                );
              })}
            </div>

            {previewBounds && (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-sm border-l-[2px]"
                style={{
                  ...chipFolderStyle(),
                  height: metrics.allDayBarHeight,
                  left: `${(previewBounds.lo / columnCount) * 100}%`,
                  top: previewTopPx,
                  width: `calc(${((previewBounds.hi - previewBounds.lo + 1) / columnCount) * 100}% - 2px)`,
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Always-visible 3px bar so it stays grippable when the section scrolls. `z-20` keeps it above
          the bars overlay; `touch-none` because its only gesture is the resize, and otherwise the
          browser claims a touch drag here for a scroll. */}
      <div
        aria-label="Resize all-day section"
        className="absolute inset-x-0 bottom-0 z-20 h-[3px] cursor-row-resize touch-none bg-border/25 transition-colors duration-[var(--transition-fast)] hover:bg-border/60 active:bg-border/80"
        onPointerDown={onResizeStart}
        role="separator"
      />
    </div>
  );
}
