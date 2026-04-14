import type { VirtualOccurrence } from "@pikos/core";
import { Repeat2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

import { useRecurringActions } from "../hooks/useRecurringActions";
import {
  CHIP_BASE_CLASSES,
  CHIP_DEFAULT_COLOR_CLASSES,
  chipFolderStyle,
  CLICK_DELAY,
  DRAG_THRESHOLD,
  formatTimeRange,
  HOUR_HEIGHT,
  snapY,
} from "../utils/calendarUtils";
import type { CalendarBlock } from "../utils/calendarUtils";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

/** Bottom-edge zone height (px) that triggers the resize cursor. */
const RESIZE_ZONE = 8;

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
  const {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  } = useRecurringActions(page);

  const widthPct = 100 / totalColumns;
  const leftPct = column * widthPct;

  const displayHeight = resizeHeight !== undefined ? Math.max(resizeHeight, 0) : height;
  // While being resized, a compact chip grows into a tall block.
  const isRenderingCompact = isCompact && resizeHeight === undefined;
  // During resize, show the live end time (snapped to 15 min to match commit behaviour).
  const liveEndDate =
    resizeHeight !== undefined
      ? new Date(startDate.getTime() + (snapY(Math.max(resizeHeight, 0)) / HOUR_HEIGHT) * 3_600_000)
      : null;
  const timeLabel = formatTimeRange(startDate, liveEndDate ?? endDate);
  const showTimeLabel = !isRenderingCompact && displayHeight >= 36;
  const isDone = page.status === "done";

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

  // Whether the cursor is hovering over the bottom resize zone.
  const [inResizeZone, setInResizeZone] = useState(false);

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
   * Mousedown on the block body.
   * - Bottom RESIZE_ZONE px of non-compact blocks → resize gesture.
   * - Otherwise → detect drag vs click by movement threshold.
   */
  function handleBlockMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // let right-click reach ContextMenuTrigger unmodified
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;

    // Check resize zone: bottom RESIZE_ZONE px of the block.
    const inResize =
      onResizeStart &&
      e.clientY >= (e.currentTarget as HTMLElement).getBoundingClientRect().bottom - RESIZE_ZONE;

    if (!inResize && !onDragStart) return;

    // Capture callbacks to avoid stale closure issues.
    const fireResizeStart = inResize ? onResizeStart : undefined;
    const fireDragStart = !inResize ? onDragStart : undefined;

    function onMove(ev: MouseEvent) {
      if (
        Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
        Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
      ) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // Cancel any pending single-click timer.
        if (clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        setPopoverOpen(false);
        isBlockDraggingRef.current = true;
        if (fireResizeStart) {
          fireResizeStart();
        } else {
          fireDragStart?.(startX, startY);
        }
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleBlockMouseMove(e: React.MouseEvent) {
    if (!onResizeStart) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setInResizeZone(e.clientY >= rect.bottom - RESIZE_ZONE);
  }

  function handleBlockMouseLeave() {
    setInResizeZone(false);
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
    height: isRenderingCompact ? undefined : displayHeight,
    left: `${leftPct}%`,
    top,
    width: `calc(${widthPct}% - 2px)`,
  };

  // Virtual recurring blocks show the recurring icon instead of a checkbox.
  // The head block (real page) keeps the normal checkbox.
  const checkbox = isRecurring ? (
    <Repeat2 aria-label="Recurring" className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
  ) : (
    <TaskCheckbox as="span" checked={isDone} className="mt-1" onChange={handleCheckboxClick} />
  );

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        {isRenderingCompact ? (
          <button
            aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
            className={cn(
              "absolute select-none",
              CHIP_BASE_CLASSES,
              "flex items-center gap-1",
              !folderColor && CHIP_DEFAULT_COLOR_CLASSES,
              isDone && "opacity-50",
              isDragging && "opacity-40",
              inResizeZone ? "cursor-ns-resize" : "cursor-default"
            )}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
            onMouseLeave={handleBlockMouseLeave}
            onMouseMove={handleBlockMouseMove}
            style={sharedStyle}
          >
            {checkbox}
            <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
              {page.title || "Untitled"}
            </span>
          </button>
        ) : (
          <button
            aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
            className={cn(
              "absolute flex flex-col items-start overflow-hidden rounded-sm border-l-2 px-1.5 py-0.5 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              !folderColor && "border-blue-500 bg-blue-500/15",
              isDone ? "opacity-50" : "transition-all hover:opacity-80 hover:shadow-sm",
              isDragging && "opacity-40",
              inResizeZone ? "cursor-ns-resize" : "cursor-default",
              isContinuationBefore && "rounded-t-none",
              isContinuationAfter && "rounded-b-none"
            )}
            onClick={handleClick}
            onMouseDown={handleBlockMouseDown}
            onMouseLeave={handleBlockMouseLeave}
            onMouseMove={handleBlockMouseMove}
            style={sharedStyle}
          >
            <div className="flex w-full min-w-0 items-start gap-1">
              {checkbox}
              <p className="type-body-sm line-clamp-3 min-w-0 text-left font-medium text-foreground">
                {page.title || "Untitled"}
              </p>
            </div>
            {showTimeLabel && (
              <p className="type-ui-sm mt-0.5 truncate pl-[16px] text-subtle">{timeLabel}</p>
            )}
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
