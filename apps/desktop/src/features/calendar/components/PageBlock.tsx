import type { VirtualOccurrence } from "@pikos/core";
import { Repeat2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

import { useRecurringActions } from "../hooks/useRecurringActions";
import {
  CHIP_BASE_CLASSES,
  CHIP_DEFAULT_COLOR_CLASSES,
  chipFolderStyle,
  CLICK_DELAY,
  DRAG_THRESHOLD,
  formatTimeRange,
  snapY,
} from "../utils/calendarUtils";
import type { CalendarBlock } from "../utils/calendarUtils";
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
  isDragging,
  onAutoOpenConsumed,
  onDoubleClick,
  onDragStart,
  onResizeStart,
  resizeHeight,
}: PageBlockProps) {
  const {
    column,
    endDate,
    height,
    isCompact,
    isContinuationAfter,
    isContinuationBefore,
    page,
    startDate,
    top,
    totalColumns,
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

  const widthPct = 100 / totalColumns;
  const leftPct = column * widthPct;

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
  const timeLabel = formatTimeRange(startDate, liveEndDate ?? endDate);
  // Time label needs a second line of text to fit. Threshold matches a 1-hour
  // block at compact density (40px) — below this the block is too short for
  // stacked title + time without clipping.
  const showTimeLabel = !isRenderingCompact && displayHeight >= 40 && !isContinuationBefore;
  const isDone = page.status === "done";
  // Multi-day events render as one visual bar: only the first day shows the
  // title/checkbox. Continuation days keep the colored bar as a click target.
  const showLabel = !isContinuationBefore;

  // Popover open state. Opens automatically for a freshly-created block so the
  // user lands directly on the metadata editor with no layout shift.
  // The parent may flip autoOpenPopover to true on a later render (the block
  // mounts between scheduleOnce's commit and setAutoOpenPageId's commit), so
  // we latch on the rising edge via the render-time derived-state pattern.
  const [popoverOpen, setPopoverOpen] = useState(autoOpenPopover ?? false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(autoOpenPopover ?? false);
  if (autoOpenPopover && !autoOpenHandled) {
    setAutoOpenHandled(true);
    setPopoverOpen(true);
  }
  function handlePopoverOpenChange(open: boolean) {
    setPopoverOpen(open);
    if (!open && autoOpenHandled) {
      onAutoOpenConsumed?.();
    }
  }

  // Timer ref for single vs double click discrimination.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set when a drag gesture is detected — prevents the subsequent click from
  // opening the popover after the drag is released.
  const isBlockDraggingRef = useRef(false);

  // Resize is disabled on continuation-after segments (the visual bottom is the
  // day boundary, not the real event end) so the handle isn't rendered there.
  const resizeEnabled = !!onResizeStart && !isContinuationAfter;

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  /**
   * Discriminate single click (open popover) from double click (open editor).
   * A double click fires onClick twice quickly; we detect this via a short timer.
   */
  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Swallow the click that fires at the end of a drag gesture.
    if (isBlockDraggingRef.current) {
      setTimeout(() => {
        isBlockDraggingRef.current = false;
      }, 0);
      return;
    }
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onDoubleClick(page.id);
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      setPopoverOpen(true);
    }, CLICK_DELAY);
  }

  /**
   * Mousedown on the block body (drag-to-reschedule). The resize handle is a
   * separate element and does not route through here.
   */
  function handleBlockMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // let right-click reach ContextMenuTrigger unmodified
    e.stopPropagation();
    if (!onDragStart) return;

    const startX = e.clientX;
    const startY = e.clientY;

    // Swap the cursor immediately on mousedown for instant mode feedback, before
    // the drag threshold is crossed. WeekGrid reapplies the same class when the
    // drag actually starts and removes it on its own mouseup — we still clean
    // up here in case the gesture never crosses the threshold.
    document.documentElement.classList.add("dragging-grab");

    function onMove(ev: MouseEvent) {
      if (
        Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
        Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
      ) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        setPopoverOpen(false);
        isBlockDraggingRef.current = true;
        onDragStart?.(startX, startY);
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.documentElement.classList.remove("dragging-grab");
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /**
   * Mousedown on the bottom resize handle. Always starts a resize gesture —
   * even a plain click suppresses the popover (via isBlockDraggingRef).
   */
  function handleResizeHandleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!onResizeStart) return;

    isBlockDraggingRef.current = true;
    document.documentElement.classList.add("dragging-resize");

    const startX = e.clientX;
    const startY = e.clientY;

    function onMove(ev: MouseEvent) {
      if (
        Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
        Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
      ) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        setPopoverOpen(false);
        onResizeStart?.();
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.documentElement.classList.remove("dragging-resize");
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Cancel any pending single-click popover timer so the checkbox click
    // doesn't also open the popover.
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    toggleStatus();
  }

  const sharedStyle = {
    ...(folderColor ? chipFolderStyle(folderColor) : undefined),
    // Height now always proportional to the computed block height, even in chip
    // mode — overrides CHIP_BASE_CLASSES's default h-[19px] via inline style.
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
  const checkbox = isRecurring ? (
    <Repeat2 aria-label="Recurring" className={cn("shrink-0 text-muted-foreground", iconClass)} />
  ) : (
    <TaskCheckbox
      as="span"
      checked={isDone}
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
              !folderColor && CHIP_DEFAULT_COLOR_CLASSES,
              isDone && "opacity-50",
              isHighlighted && "animate-highlight-flash",
              isContinuationBefore && "rounded-tl-none rounded-tr-none",
              isContinuationAfter && "rounded-br-none rounded-bl-none",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!"
            )}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
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
              !folderColor && "border-blue-500 bg-blue-500/15",
              isDone
                ? "opacity-50"
                : "transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm",
              isHighlighted && "animate-highlight-flash",
              isResizing
                ? "cursor-row-resize!"
                : isDragging
                  ? "cursor-grabbing! opacity-40"
                  : "cursor-default!",
              isContinuationBefore && "rounded-tl-none rounded-tr-none",
              isContinuationAfter && "rounded-br-none rounded-bl-none"
            )}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
            style={sharedStyle}
          >
            {showLabel && (
              <div className="flex w-full min-w-0 items-start gap-1">
                {checkbox}
                <p className="type-body-sm line-clamp-3 min-w-0 text-left leading-tight font-medium text-foreground">
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
