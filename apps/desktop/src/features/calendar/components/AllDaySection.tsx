// AllDaySection — sits between the day-name row and the time grid.
// Each event renders as a single absolutely-positioned bar spanning its
// columns; the day columns are thin background elements that handle weekend
// striping, dividers, drag-target highlight, and click-to-create.

import type { PageSummary } from "@pikos/core";
import { format } from "date-fns";

import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  ALL_DAY_BAR_HEIGHT,
  ALL_DAY_ROW_HEIGHT,
  ALL_DAY_TOP_PADDING,
  assignStableAllDayRows,
  barPositionStyle,
  buildAllDayBars,
  firstFreeRowInSpan,
} from "../utils/calendarUtils";
import { AllDayBar } from "./AllDayBar";

interface AllDaySectionProps {
  allDayDragHoverIndex: number | null;
  autoOpenPageId: string | null;
  /** When set, render a ghost overlay spanning [startDayIndex..endDayIndex] at
   * the first-free row of the spanned columns during a drag-to-create gesture.
   * Absolute-positioned — doesn't participate in bar layout. */
  createPreview: { startDayIndex: number; endDayIndex: number } | null;
  days: Date[];
  draggingPageId: string | null;
  height: number;
  onAutoOpenConsumed: () => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  /** Mousedown on empty all-day cells — WeekGrid decides click-vs-drag at mouseup. */
  onCreateDragStart: (info: { clientX: number; clientY: number; dayIndex: number }) => void;
  onEdgeResizeStart: (info: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
  }) => void;
  onPageDoubleClick: (pageId: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  pages: PageSummary[];
  timedDragTarget: { dayIndex: number; folderColor: string | undefined } | null;
}

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
  const { folders } = useWorkspace();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );
  const slotsByDay = assignStableAllDayRows(pages, days);
  const bars = buildAllDayBars(slotsByDay);
  const rowCount = slotsByDay[0]?.length ?? 0;
  const columnCount = days.length;
  // Reserve enough height for every row plus symmetric top/bottom padding.
  // min-h-full on the scroll container ensures backgrounds still reach the
  // bottom edge when the bar count is short.
  const contentMinHeight = ALL_DAY_TOP_PADDING * 2 + rowCount * ALL_DAY_ROW_HEIGHT;

  // Auto-open fires on at most one bar. `!continuesLeft` rules out week-crossed
  // continuation bars (autoOpen targets a newly-created page, which always
  // starts inside the current view), and if multiple bars still match (shared-
  // id recurring), the first one wins deterministically.
  const autoOpenBarKey = autoOpenPageId
    ? (bars.find((b) => b.page.id === autoOpenPageId && !b.continuesLeft)?.key ?? null)
    : null;

  // Normalise create-preview bounds (mousedown could drag in either direction).
  const previewBounds = createPreview
    ? {
        hi: Math.max(createPreview.startDayIndex, createPreview.endDayIndex),
        lo: Math.min(createPreview.startDayIndex, createPreview.endDayIndex),
      }
    : null;
  // Ghost row matches where assignAllDayRows will actually place the new bar
  // on commit, so there's no visual jump when the ghost becomes a real bar.
  const previewTopPx = previewBounds
    ? ALL_DAY_TOP_PADDING +
      firstFreeRowInSpan(slotsByDay, previewBounds.lo, previewBounds.hi) * ALL_DAY_ROW_HEIGHT
    : 0;

  function handleColumnMouseDown(e: React.MouseEvent, dayIndex: number) {
    if (e.button !== 0) return;
    // Prevent the native mousedown from starting a text selection — dragging
    // the cursor across nearby bar labels would otherwise highlight them.
    e.preventDefault();
    onCreateDragStart({ clientX: e.clientX, clientY: e.clientY, dayIndex });
  }

  return (
    <div className="relative shrink-0 border-b border-border/50" style={{ height }}>
      {/* Vertical scroll container — when bar count exceeds the user-set
          section height, scroll instead of clipping. `min-h-full` keeps the
          columns tall when bars are short so weekend bg + dividers reach the
          bottom edge. */}
      <div className="h-full overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:hidden">
        <div className="flex min-h-full">
          {/* Gutter spacer — aligns with TimeGutter's w-14 */}
          <div className="w-14 shrink-0" />

          <div className="relative flex flex-1" style={{ minHeight: contentMinHeight }}>
            {/* Background columns — weekend bg, divider, drag-target highlight, click-to-create target. */}
            {days.map((day, dayIndex) => {
              const weekend = day.getDay() === 0 || day.getDay() === 6;
              const isAllDayTarget = allDayDragHoverIndex === dayIndex;
              const isTimedTarget = timedDragTarget?.dayIndex === dayIndex;
              return (
                <div
                  aria-label={`All-day events, ${format(day, "EEEE MMMM d")}`}
                  className={cn(
                    "relative min-w-0 flex-1 cursor-cell",
                    "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border/40 first:before:hidden",
                    weekend && "bg-white/[0.012]",
                    (isAllDayTarget || isTimedTarget) && "bg-accent/30"
                  )}
                  data-day-index={dayIndex}
                  key={day.toISOString()}
                  onMouseDown={(e) => handleColumnMouseDown(e, dayIndex)}
                />
              );
            })}

            {/* Bars overlay — wrapper is pointer-events-none so empty space
                routes clicks through to the background columns beneath. Each
                bar re-enables pointer-events-auto on itself. No aria-hidden:
                that would take every bar out of the accessibility tree. */}
            <div className="pointer-events-none absolute inset-0">
              {bars.map((bar) => {
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
                    position={barPositionStyle(bar, columnCount)}
                  />
                );
              })}
            </div>

            {/* Drag-to-create ghost overlay — absolute, doesn't affect row layout. */}
            {previewBounds && (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-sm border-l-[2px] border-blue-500 bg-blue-500/20"
                style={{
                  height: ALL_DAY_BAR_HEIGHT,
                  left: `${(previewBounds.lo / columnCount) * 100}%`,
                  top: previewTopPx,
                  width: `calc(${((previewBounds.hi - previewBounds.lo + 1) / columnCount) * 100}% - 2px)`,
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Drag handle — bottom edge. Always-visible 3px bar so it stays
          grippable when the all-day section scrolls. `z-20` keeps it above
          the bars overlay so chips covering the bottom don't steal the
          mousedown. */}
      <div
        aria-label="Resize all-day section"
        className="absolute inset-x-0 bottom-0 z-20 h-[3px] cursor-row-resize bg-border/25 transition-colors duration-[var(--transition-fast)] hover:bg-border/60 active:bg-border/80"
        onMouseDown={onResizeStart}
        role="separator"
      />
    </div>
  );
}
