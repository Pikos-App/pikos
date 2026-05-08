import type { VirtualOccurrence } from "@pikos/core";
import { Repeat2 } from "lucide-react";
import type { CSSProperties } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import {
  type AllDayBar as AllDayBarData,
  beginDragThreshold,
  CHIP_BASE_CLASSES,
  chipFolderStyle,
} from "../utils/calendarUtils";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

export interface AllDayBarProps {
  autoOpenPopover?: boolean;
  bar: AllDayBarData;
  draggingPageId: string | null;
  folderColor: string | undefined;
  onAutoOpenConsumed?: () => void;
  onDoubleClick: (pageId: string) => void;
  onDragStart: (info: {
    folderColor: string | undefined;
    pageId: string;
    /** Set when dragging a virtual rrule occurrence — keys the override. */
    originalDate?: string;
  }) => void;
  onEdgeResizeStart?: (info: {
    clientX: number;
    clientY: number;
    edge: "start" | "end";
    pageId: string;
    /** Set when resizing a virtual rrule occurrence — keys the override. */
    originalDate?: string;
  }) => void;
  /** Absolute-positioning style (left/top/width) computed by the parent so
   * the bar stays ignorant of column-count math. */
  position: CSSProperties;
}

/**
 * Single absolute-positioned bar for one all-day event segment. A 4-day event
 * is one element spanning 4 columns — cross-segment hover is a native CSS
 * `:hover`, the title flows naturally across the bar's width, and only one
 * popover exists per event.
 */
export function AllDayBar({
  autoOpenPopover,
  bar,
  draggingPageId,
  folderColor,
  onAutoOpenConsumed,
  onDoubleClick,
  onDragStart,
  onEdgeResizeStart,
  position,
}: AllDayBarProps) {
  const { continuesLeft, continuesRight, page } = bar;
  const { requestDeletePage } = useUndoDelete();
  const {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  } = useRecurringActions(page);

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

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Prevent native text selection — the bar's content is mostly text and
    // dragging across it would otherwise highlight it.
    e.preventDefault();
    const virtual = page as { originalDate?: string };
    beginDragThreshold(e.clientX, e.clientY, {
      onCrossed: () => {
        suppressPendingClick();
        setPopoverOpen(false);
        markDragging();
        onDragStart({
          folderColor,
          pageId: page.id,
          ...(virtual.originalDate && { originalDate: virtual.originalDate }),
        });
      },
    });
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    suppressPendingClick();
    toggleStatus();
  }

  function startEdgeResize(edge: "start" | "end") {
    return (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      setPopoverOpen(false);
      suppressPendingClick();
      markDragging();
      const virtual = page as { originalDate?: string };
      onEdgeResizeStart?.({
        clientX: e.clientX,
        clientY: e.clientY,
        edge,
        pageId: page.id,
        ...(virtual.originalDate && { originalDate: virtual.originalDate }),
      });
    };
  }

  const isDone = page.status === "done";
  const isBeingDragged = draggingPageId === page.id;
  const chipStyle = chipFolderStyle(folderColor);
  // Edge handles only appear on a real (non-continuation) boundary, so a
  // multi-week event that crosses into this view has no left handle here —
  // extending across weeks goes through the popover's date picker.
  const showLeftEdgeHandle = !continuesLeft && !!onEdgeResizeStart && !isRecurring;
  const showRightEdgeHandle = !continuesRight && !!onEdgeResizeStart && !isRecurring;

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={page.title || "Untitled"}
          className={cn(
            "pointer-events-auto absolute flex cursor-default! items-center gap-1",
            CHIP_BASE_CLASSES,
            isDone && "opacity-50",
            isBeingDragged && "opacity-40",
            continuesLeft && "rounded-tl-none rounded-bl-none",
            continuesRight && "rounded-tr-none rounded-br-none"
          )}
          onClick={handleClick}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={handleMouseDown}
          style={{ ...chipStyle, ...position }}
        >
          {isRecurring ? (
            <Repeat2
              aria-label="Recurring"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
          ) : (
            <TaskCheckbox
              as="span"
              checked={isDone}
              className="h-3.5 w-3.5 cursor-pointer!"
              onChange={handleCheckboxClick}
            />
          )}
          <span className="type-body-sm min-w-0 truncate text-left font-medium text-foreground">
            {page.title || "Untitled"}
          </span>
          {showLeftEdgeHandle && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1 cursor-ew-resize!"
              data-resize-edge="start"
              onMouseDown={startEdgeResize("start")}
            />
          )}
          {showRightEdgeHandle && (
            <span
              aria-hidden
              className="absolute inset-y-0 right-0 w-1 cursor-ew-resize!"
              data-resize-edge="end"
              onMouseDown={startEdgeResize("end")}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        side="bottom"
        sideOffset={4}
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
            onRemoveDate={() => setPopoverOpen(false)}
            page={page}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
