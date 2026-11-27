import type { CalendarBlock, VirtualOccurrence } from "@pikos/core";
import {
  addClockMinutes,
  crossingMidnightsCount,
  DEFAULT_EVENT_COLOR,
  fallsShortOf,
  formatMultiDayTimeRange,
  formatTimeRange,
  isDone,
  snapY,
} from "@pikos/core";
import { Repeat2 } from "lucide-react";

import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import { beginDragThreshold } from "../utils/beginDragThreshold";
import { BLOCK_TIME_TEXT_CLASS, CHIP_BASE_CLASSES, chipFolderStyle } from "../utils/calendarColors";
import { BlockPopoverContent } from "./BlockPopoverContent";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

/** The block's own vertical padding at the default zoom, which its contents sit inside. */
const BLOCK_PADDING_PX = 4;

/** Bottom-edge resize handle height (px); 3px on blocks under 30px so it stays under a third of the height. */
function resizeZoneFor(displayHeight: number): number {
  return displayHeight < 30 ? 3 : 4;
}

interface PageBlockProps {
  block: CalendarBlock;
  folderColor: string | undefined;
  /** When true, the block mounts with its metadata popover open (e.g. just created via calendar click/drag). */
  autoOpenPopover?: boolean;
  /** Called once after the auto-opened popover is closed by the user. */
  onAutoOpenConsumed?: () => void;
  onDoubleClick: (pageId: string) => void;
  isDragging?: boolean;
  isSettling?: boolean;
  onSettled?: () => void;
  /**
   * True when the rendered width is below the legible-time threshold (COMPACT_MODE_WIDTH_PX): single-line
   * title, no time row, checkbox hidden until hover. Independent of the height-driven `isCompact`.
   */
  isCompactWidth?: boolean;
  /** False when the block is too narrow for any of its title (`TITLE_MIN_WIDTH_PX`), which
   * leaves the checkbox alone. */
  hasRoomForTitle?: boolean;
  onDragStart?: (clientX: number, clientY: number) => void;
  onResizeStart?: () => void;
  /** Overrides the rendered height (px) to show the live resize ghost. */
  resizeHeight?: number;
}

export function PageBlock({
  autoOpenPopover,
  block,
  folderColor,
  hasRoomForTitle = true,
  isCompactWidth,
  isDragging,
  isSettling,
  onAutoOpenConsumed,
  onDoubleClick,
  onDragStart,
  onResizeStart,
  onSettled,
  resizeHeight,
}: PageBlockProps) {
  const {
    endDate,
    height,
    isCompact,
    isContinuationAfter,
    isContinuationBefore,
    leftPct,
    page,
    startDate,
    straddlesBottomBand,
    straddlesTopBand,
    top,
    widthPct,
  } = block;
  const { highlightedPageId } = useUI();
  const { metrics } = useCalendarSettings();
  const { deleteBlock, isVirtual, showsCheckbox, toggleStatus } = useRecurringActions(page);
  const isHighlighted = highlightedPageId === page.id;

  const isResizing = resizeHeight !== undefined;
  const displayHeight = isResizing ? Math.max(resizeHeight, 0) : height;
  // While being resized, a compact chip grows into a tall block.
  const isRenderingCompact = isCompact && !isResizing;
  // During resize, show the live end time, snapped to 15 min like the commit.
  const liveEndDate =
    resizeHeight !== undefined
      ? addClockMinutes(
          startDate,
          (snapY(Math.max(resizeHeight, 0), metrics.hourHeight) / metrics.hourHeight) * 60
        )
      : null;
  // The first segment of a 2+-midnight event shows both endpoints in the label.
  const isMultiDayTimed = crossingMidnightsCount(startDate, endDate) >= 2;
  const timeLabel =
    isMultiDayTimed && !isContinuationBefore
      ? formatMultiDayTimeRange(startDate, liveEndDate ?? endDate)
      : formatTimeRange(startDate, liveEndDate ?? endDate);
  // Layout tiers by available height, in `CalendarMetrics` units: title only, then title + time row,
  // then a 2-line title. Short blocks keep their time; `isCompactWidth` forces a 1-line title.
  const showTimeLabel =
    hasRoomForTitle &&
    !isRenderingCompact &&
    !fallsShortOf(displayHeight, metrics.timeRowMinHeight) &&
    !isContinuationBefore;
  const useTwoLineTitle =
    !isCompactWidth && !fallsShortOf(displayHeight, metrics.twoLineTitleMinHeight);
  // The shortest blocks are smaller than the scaled checkbox; unclamped, the box is clipped to the two
  // vertical edges of its square, which reads as a rendering fault.
  const checkboxMaxPx = Math.max(displayHeight - BLOCK_PADDING_PX * metrics.zoom, 1);
  const done = isDone(page);
  // Multi-day events read as one bar: only the first day shows the title and checkbox.
  const showLabel = !isContinuationBefore;
  const showTitle = showLabel && hasRoomForTitle;

  const {
    handleClick,
    handleContextMenu,
    handlePopoverOpenChange,
    markDragging,
    popoverOpen,
    setPopoverOpen,
    suppressPendingClick,
  } = useCalendarBlockPopover({
    autoOpenPopover: autoOpenPopover ?? false,
    onAutoOpenConsumed,
    onDoubleClick: () => onDoubleClick(page.id),
  });

  // Cross-midnight events render as two segments. Segment B (isContinuationBefore) is read-only: drag
  // and resize both come from segment A, whose visual bottom is the day boundary, not the real end.
  const isSplitSegment = isContinuationBefore || isContinuationAfter;
  const isSegmentB = isContinuationBefore === true;
  // Synced events lock the schedule. The hooks already no-op, but the grab cursor and resize handle
  // must go too, or the cursor advertises a move that can't happen.
  const locked = page.scheduleLocked;
  const resizeEnabled = !!onResizeStart && !isContinuationAfter && !isSegmentB && !locked;

  /**
   * Both split segments share `page.id`, so toggling a class on every `[data-cal-page-id]` element
   * lights the partner segment without a context round-trip. The CSS lives in app.css.
   */
  function applyHoverLink(active: boolean) {
    if (!isSplitSegment) return;
    const els = document.querySelectorAll(`[data-cal-page-id="${page.id}"]`);
    for (const el of els) {
      el.classList.toggle("cal-segment-hover", active);
    }
  }

  /**
   * Segment B blocks the drag, so a two-segment event reschedules only from its start segment. The
   * resize handle doesn't route through here.
   */
  function handleBlockPointerDown(e: React.PointerEvent) {
    if (!e.isPrimary || e.button !== 0) return;
    // No stopPropagation: DayColumn filters presses on a block by target, because Radix dismisses
    // an open popover on pointerdown.
    if (!onDragStart) return;
    if (isSegmentB) return;
    // Locked (synced): no drag threshold; a click still opens the popover.
    if (locked) return;
    const { clientX: startX, clientY: startY } = e;
    beginDragThreshold(startX, startY, {
      bodyCursor: "dragging-grab",
      onCrossed: () => {
        suppressPendingClick();
        setPopoverOpen(false);
        markDragging();
        onDragStart(startX, startY);
      },
    });
  }

  /** Marks the gesture as a drag at once so a plain click on the handle still suppresses the popover. */
  function handleResizeHandlePointerDown(e: React.PointerEvent) {
    if (!e.isPrimary || e.button !== 0) return;
    // Keeps handleBlockPointerDown's "does not route through here" true — both
    // thresholds would otherwise arm and fire on the same movement.
    e.stopPropagation();
    if (!onResizeStart) return;
    markDragging();
    beginDragThreshold(e.clientX, e.clientY, {
      bodyCursor: "dragging-resize",
      onCrossed: () => {
        suppressPendingClick();
        setPopoverOpen(false);
        onResizeStart();
      },
    });
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    suppressPendingClick();
    toggleStatus();
  }

  const sharedStyle = {
    ...chipFolderStyle(folderColor),
    // Full computed height: adjacent blocks touch, and the bg-derived outline (app.css
    // `[data-cal-page-id]`) of A.bottom and B.top coincide as one 1px seam. Cascaded blocks use the
    // same outline.
    height: displayHeight,
    left: `${leftPct}%`,
    top,
    width: `calc(${widthPct}% - 2px)`,
  };

  // One 14px icon size across chip and stacked layouts. Vertical offsets align the checkbox with the
  // text's cap-height, not the line-box edge, and ride `--calendar-zoom` with the block's insets: a
  // fixed px offset left the checkbox above the title once the text grew.
  const iconOffset = isRenderingCompact
    ? "mt-[calc(1px*var(--calendar-zoom,1))]"
    : "mt-[calc(3px*var(--calendar-zoom,1))]";
  const checkbox = showsCheckbox ? (
    <TaskCheckbox
      as="span"
      borderColor={folderColor ?? DEFAULT_EVENT_COLOR}
      checked={done}
      className={cn(iconOffset, "cursor-pointer!")}
      maxPx={checkboxMaxPx}
      onChange={handleCheckboxClick}
      size="sm"
    />
  ) : (
    <Repeat2
      aria-label="Recurring"
      className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", iconOffset)}
    />
  );

  const resizeHandle = resizeEnabled ? (
    // touch-none: the strip's only gesture is the resize; the block body doesn't set it, so a touch
    // drag there still scrolls the grid.
    <div
      aria-hidden
      className="absolute right-0 bottom-0 left-0 cursor-row-resize! touch-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={handleResizeHandlePointerDown}
      style={{ height: resizeZoneFor(displayHeight) }}
    />
  ) : null;

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        {isRenderingCompact ? (
          <button
            aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
            className={cn(
              "absolute select-none",
              CHIP_BASE_CLASSES,
              "flex items-center gap-1 rounded-tl-xs rounded-tr-[3px] rounded-br-[3px] rounded-bl-xs",
              done && "opacity-50",
              isHighlighted && "animate-highlight-flash",
              isSettling && "animate-block-settle",
              (isContinuationBefore || straddlesTopBand) && "rounded-tl-none rounded-tr-none",
              (isContinuationAfter || straddlesBottomBand) && "rounded-br-none rounded-bl-none",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!"
            )}
            data-cal-page-id={page.id}
            onAnimationEnd={isSettling ? onSettled : undefined}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onMouseEnter={() => applyHoverLink(true)}
            onMouseLeave={() => applyHoverLink(false)}
            onPointerDown={handleBlockPointerDown}
            style={sharedStyle}
          >
            {showLabel && checkbox}
            {showTitle && (
              <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
                {page.title || "Untitled"}
              </span>
            )}
            {showTitle && <SyncSourceIcon className="ml-auto h-3 w-3" syncState={page.syncState} />}
            {resizeHandle}
          </button>
        ) : (
          <button
            aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
            className={cn(
              "absolute flex flex-col items-start overflow-hidden rounded-tl-xs rounded-tr-[3px] rounded-br-[3px] rounded-bl-xs border-l-2 px-1.5 py-[calc(0.125rem*var(--calendar-zoom,1))] select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              done
                ? "opacity-50"
                : "transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm",
              isHighlighted && "animate-highlight-flash",
              isSettling && "animate-block-settle",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!",
              (isContinuationBefore || straddlesTopBand) && "rounded-tl-none rounded-tr-none",
              (isContinuationAfter || straddlesBottomBand) && "rounded-br-none rounded-bl-none"
            )}
            data-cal-page-id={page.id}
            onAnimationEnd={isSettling ? onSettled : undefined}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onMouseEnter={() => applyHoverLink(true)}
            onMouseLeave={() => applyHoverLink(false)}
            onPointerDown={handleBlockPointerDown}
            style={sharedStyle}
          >
            {showLabel && (
              <div className="flex w-full min-w-0 items-start gap-1">
                {checkbox}
                {hasRoomForTitle && (
                  <p
                    className={cn(
                      "type-body-sm min-w-0 text-left leading-tight font-medium text-foreground",
                      // `break-words`: the clamp only ellipsizes where it clamps, so a single word wider
                      // than the column was sliced at the edge. `hyphens-auto` makes that break read as one.
                      useTwoLineTitle ? "line-clamp-2 break-words hyphens-auto" : "truncate"
                    )}
                  >
                    {page.title || "Untitled"}
                  </p>
                )}
                {/* Stays in flow so a long title reserves space and never runs under it. mt-1 plus the
                    row's py-0.5 is 6px, matching the px-1.5 right inset. */}
                {hasRoomForTitle && (
                  <SyncSourceIcon className="mt-1 ml-auto h-3 w-3" syncState={page.syncState} />
                )}
              </div>
            )}
            {showTimeLabel && (
              // Indent matches the title's own left edge: checkbox 3.5 + gap 1
              <p
                className={cn(
                  "type-ui-sm mt-[calc(0.125rem*var(--calendar-zoom,1))] w-full truncate pl-[calc(1.125rem*var(--calendar-zoom,1))] text-left",
                  BLOCK_TIME_TEXT_CLASS
                )}
              >
                {timeLabel}
              </p>
            )}
            {resizeHandle}
          </button>
        )}
      </PopoverTrigger>
      <BlockPopoverContent
        align="start"
        className="w-[calc(20rem*var(--ui-text-scale,1))] p-3"
        side="right"
        sideOffset={8}
      >
        {isVirtual ? (
          <VirtualPageBlockPopover
            onClose={() => setPopoverOpen(false)}
            onDelete={() => {
              setPopoverOpen(false);
              deleteBlock();
            }}
            page={page as VirtualOccurrence}
          />
        ) : (
          <PageBlockPopover
            onClose={() => setPopoverOpen(false)}
            onDelete={() => {
              setPopoverOpen(false);
              deleteBlock();
            }}
            onRemoveDate={() => {
              setPopoverOpen(false);
            }}
            page={page}
          />
        )}
      </BlockPopoverContent>
    </Popover>
  );
}
