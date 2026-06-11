import type { VirtualOccurrence } from "@pikos/core";
import { isDone } from "@pikos/core";
import { Repeat2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import { crossingMidnightsCount } from "../utils/allDayLayout";
import { chipFolderStyle } from "../utils/calendarColors";
import { CHIP_BASE_CLASSES, DEFAULT_EVENT_COLOR } from "../utils/calendarConstants";
import { snapY } from "../utils/calendarGeometry";
import { beginDragThreshold, type CalendarBlock } from "../utils/calendarLayout";
import { formatMultiDayTimeRange, formatTimeRange } from "../utils/calendarTimeFormat";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

/**
 * Bottom-edge handle height (px) for the duration resize gesture. Drops to 3px
 * on short blocks (< 30px) so the handle stays well under a third of block height.
 */
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
  /** When true, dims the block — used while it is being dragged to a new position. */
  isDragging?: boolean;
  /**
   * When true, the block's rendered width has dropped below the
   * "legible-time" threshold (COMPACT_MODE_WIDTH_PX). Renders single-line
   * title only, drops the time row, and hides the checkbox until hover.
   * Independent of the height-driven `isCompact` chip mode.
   */
  isCompactWidth?: boolean;
  /** Called (with initial clientX/Y) when drag threshold is crossed on the block body. */
  onDragStart?: (clientX: number, clientY: number) => void;
  /** Called when the user mousedowns in the bottom resize zone. */
  onResizeStart?: () => void;
  /**
   * When set, overrides the rendered height of the block (px).
   * Used to show the live resize ghost while the user drags the bottom edge.
   */
  resizeHeight?: number;
}

export function PageBlock({
  autoOpenPopover,
  block,
  folderColor,
  isCompactWidth,
  isDragging,
  onAutoOpenConsumed,
  onDoubleClick,
  onDragStart,
  onResizeStart,
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
  const { requestDeletePage } = useUndoDelete();
  const { highlightedPageId } = useUI();
  const { metrics } = useCalendarSettings();
  const {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  } = useRecurringActions(page);
  const isHighlighted = highlightedPageId === page.id;

  const isResizing = resizeHeight !== undefined;
  const displayHeight = isResizing ? Math.max(resizeHeight, 0) : height;
  // While being resized, a compact chip grows into a tall block.
  const isRenderingCompact = isCompact && !isResizing;
  // At compact density a 15-min block is ~10px; default type-body-sm is too tall
  // to fit. Below 16px we switch to a tighter micro variant (10px text, 10px checkbox).
  const isMicro = isRenderingCompact && displayHeight < 16;
  // During resize, show the live end time (snapped to 15 min to match commit behaviour).
  const liveEndDate =
    resizeHeight !== undefined
      ? new Date(
          startDate.getTime() +
            (snapY(Math.max(resizeHeight, 0), metrics.hourHeight) / metrics.hourHeight) * 3_600_000
        )
      : null;
  // First segment of a 2+-midnight event shows the full bookend label
  // "9 AM Mon – 5 PM Thu" so both endpoints are visible at a glance.
  const isMultiDayTimed = crossingMidnightsCount(startDate, endDate) >= 2;
  const timeLabel =
    isMultiDayTimed && !isContinuationBefore
      ? formatMultiDayTimeRange(startDate, liveEndDate ?? endDate)
      : formatTimeRange(startDate, liveEndDate ?? endDate);
  // Layout tiers by available height:
  //   < 40px → 1-line title only (no time row — wouldn't fit cleanly)
  //   40-52  → 1-line title + time row
  //   ≥ 52px → 2-line title + time row
  // This keeps short blocks (e.g. 45min, 48px) showing their time, while
  // tall blocks still get a 2-line title for long page names.
  // `isCompactWidth` always forces a 1-line title regardless of height.
  const showTimeLabel = !isRenderingCompact && displayHeight >= 40 && !isContinuationBefore;
  const useTwoLineTitle = !isCompactWidth && displayHeight >= 52;
  const done = isDone(page);
  // Multi-day events render as one visual bar: only the first day shows the
  // title/checkbox. Continuation days keep the colored bar as a click target.
  const showLabel = !isContinuationBefore;

  const {
    handleClick,
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

  // Cross-midnight events render as two segments. Segment A (start day) has
  // isContinuationAfter; segment B (end day) has isContinuationBefore. Per
  // spec, segment B is read-only — drag and resize both come from segment A.
  // Resize on segment A is also disabled because its visual bottom is the day
  // boundary, not the real event end.
  const isSplitSegment = isContinuationBefore || isContinuationAfter;
  const isSegmentB = isContinuationBefore === true;
  const resizeEnabled = !!onResizeStart && !isContinuationAfter && !isSegmentB;

  /**
   * Hover linkage across split segments. Both segments share `page.id`, so
   * toggling a class on every `[data-cal-page-id="…"]` element lights up the
   * partner segment without a context round-trip. The CSS rule lives in
   * app.css and mirrors the `:hover` styling on a single block.
   */
  function applyHoverLink(active: boolean) {
    if (!isSplitSegment) return;
    const els = document.querySelectorAll(`[data-cal-page-id="${page.id}"]`);
    for (const el of els) {
      el.classList.toggle("cal-segment-hover", active);
    }
  }

  /**
   * Drag-to-reschedule. The resize handle is a separate element and does not
   * route through here. Segment B blocks the drag entirely so a two-segment
   * event can only be rescheduled from its start segment.
   */
  function handleBlockMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // let right-click reach ContextMenuTrigger unmodified
    e.stopPropagation();
    if (!onDragStart) return;
    if (isSegmentB) return;
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

  /**
   * Marks the gesture as a drag immediately so a plain click on the handle
   * still suppresses the popover, then waits for the threshold before telling
   * the parent to start resizing.
   */
  function handleResizeHandleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
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
    // Full computed height — adjacent blocks touch directly. The bg-derived
    // outline (see app.css `[data-cal-page-id]`) of A.bottom and B.top
    // coincide at the same pixel and paint as one 1px seam. Cascaded blocks
    // use the same outline so back-to-back and overlapping events share one
    // consistent border treatment — no extra moat or shadow.
    height: displayHeight,
    left: `${leftPct}%`,
    top,
    width: `calc(${widthPct}% - 2px)`,
  };

  // One unified 14px icon size across chip + stacked layouts; only micro shrinks
  // (10px) to fit the compact-density quarter-hour row. Vertical offsets align
  // the hollow-square checkbox with the text's glyph cap-height, not the flex
  // line-box edge (which sits ~2-3px above cap-top for type-body-sm).
  // Micro also tightens the corner radius — --radius-sm on a 10px square reads
  // as fully round, so we drop to 2px to preserve the checkbox silhouette.
  const iconClass = cn(
    isMicro ? "h-2.5 w-2.5 rounded-[3px]" : "h-3.5 w-3.5",
    !isMicro && isRenderingCompact && "mt-px",
    !isMicro && !isRenderingCompact && "mt-[3px]"
  );
  // Checkbox stroke tracks the event's accent (the left-border stripe), not
  // the fill — so it stays legible on muted fills and against any folder
  // color. Same fallback the chip background uses when no folder colour is set.
  const checkbox = isRecurring ? (
    <Repeat2 aria-label="Recurring" className={cn("shrink-0 text-muted-foreground", iconClass)} />
  ) : (
    <TaskCheckbox
      as="span"
      borderColor={folderColor ?? DEFAULT_EVENT_COLOR}
      checked={done}
      className={cn(iconClass, "cursor-pointer!")}
      onChange={handleCheckboxClick}
    />
  );

  const resizeHandle = resizeEnabled ? (
    <div
      aria-hidden
      className="absolute right-0 bottom-0 left-0 cursor-row-resize!"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={handleResizeHandleMouseDown}
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
              (isContinuationBefore || straddlesTopBand) && "rounded-tl-none rounded-tr-none",
              (isContinuationAfter || straddlesBottomBand) && "rounded-br-none rounded-bl-none",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!"
            )}
            data-cal-page-id={page.id}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
            onMouseEnter={() => applyHoverLink(true)}
            onMouseLeave={() => applyHoverLink(false)}
            style={sharedStyle}
          >
            {showLabel && checkbox}
            {showLabel && (
              <span
                className={cn(
                  "min-w-0 truncate font-medium text-foreground",
                  isMicro ? "-mt-px text-[10px] leading-none" : "type-body-sm"
                )}
              >
                {page.title || "Untitled"}
              </span>
            )}
            {resizeHandle}
          </button>
        ) : (
          <button
            aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
            className={cn(
              "absolute flex flex-col items-start overflow-hidden rounded-tl-xs rounded-tr-[3px] rounded-br-[3px] rounded-bl-xs border-l-2 px-1.5 py-0.5 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              done
                ? "opacity-50"
                : "transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm",
              isHighlighted && "animate-highlight-flash",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!",
              (isContinuationBefore || straddlesTopBand) && "rounded-tl-none rounded-tr-none",
              (isContinuationAfter || straddlesBottomBand) && "rounded-br-none rounded-bl-none"
            )}
            data-cal-page-id={page.id}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
            onMouseEnter={() => applyHoverLink(true)}
            onMouseLeave={() => applyHoverLink(false)}
            style={sharedStyle}
          >
            {showLabel && (
              <div className="flex w-full min-w-0 items-start gap-1">
                {checkbox}
                <p
                  className={cn(
                    "type-body-sm min-w-0 text-left leading-tight font-medium text-foreground",
                    useTwoLineTitle ? "line-clamp-2" : "truncate"
                  )}
                >
                  {page.title || "Untitled"}
                </p>
              </div>
            )}
            {showTimeLabel && (
              <p className="type-ui-sm mt-0.5 truncate pl-[18px] text-subtle">{timeLabel}</p>
            )}
            {resizeHandle}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onMouseDown={(e) => e.stopPropagation()}
        side="right"
        sideOffset={8}
      >
        {isRecurring ? (
          <VirtualPageBlockPopover
            onClose={() => setPopoverOpen(false)}
            onSkip={() => {
              setPopoverOpen(false);
              void handleSkipOccurrence();
            }}
            page={page as VirtualOccurrence}
          />
        ) : (
          <PageBlockPopover
            onClose={() => setPopoverOpen(false)}
            onDelete={() => {
              setPopoverOpen(false);
              requestDeletePage(page);
            }}
            onRemoveDate={() => {
              setPopoverOpen(false);
            }}
            page={page}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
