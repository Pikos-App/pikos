import type { AllDayBar as AllDayBarData, VirtualOccurrence } from "@pikos/core";
import { isDone } from "@pikos/core";
import { Repeat2 } from "lucide-react";
import type { CSSProperties } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import { beginDragThreshold } from "../utils/beginDragThreshold";
import { CHIP_BASE_CLASSES, chipFolderStyle } from "../utils/calendarColors";
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
  const { deleteBlock, isVirtual, showsCheckbox, toggleStatus } = useRecurringActions(page);

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

  // Suppress the drag + edge-resize affordances too — the hooks already no-op,
  // this just stops the cursor from advertising a move/resize that can't happen.
  const locked = page.scheduleLocked;

  function handlePointerDown(e: React.PointerEvent) {
    if (!e.isPrimary || e.button !== 0) return;
    // No stopPropagation: nothing above the bars overlay starts a gesture, and
    // pointerdown is what Radix listens on to dismiss another open popover
    // from outside — swallowing it would strand that one open.
    if (locked) return;
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
    return (e: React.PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      // The handle is inside the chip: without this its move drag also arms,
      // and the losing reschedule collapses the span to a single day.
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

  const done = isDone(page);
  const isBeingDragged = draggingPageId === page.id;
  const chipStyle = chipFolderStyle(folderColor);
  // Edge handles only appear on a real (non-continuation) boundary, so a
  // multi-week event that crosses into this view has no left handle here —
  // extending across weeks goes through the popover's date picker.
  const showLeftEdgeHandle = !continuesLeft && !!onEdgeResizeStart && !isVirtual && !locked;
  const showRightEdgeHandle = !continuesRight && !!onEdgeResizeStart && !isVirtual && !locked;

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={page.title || "Untitled"}
          className={cn(
            "pointer-events-auto absolute flex cursor-default! items-center gap-1",
            CHIP_BASE_CLASSES,
            page.syncState === "detached" && !done && "opacity-70",
            done && "opacity-50",
            isBeingDragged && "opacity-40",
            continuesLeft && "rounded-tl-none rounded-bl-none",
            continuesRight && "rounded-tr-none rounded-br-none"
          )}
          onClick={handleClick}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={handlePointerDown}
          style={{ ...chipStyle, ...position }}
        >
          {showsCheckbox ? (
            <TaskCheckbox
              as="span"
              checked={done}
              className="h-3.5 w-3.5 cursor-pointer!"
              onChange={handleCheckboxClick}
            />
          ) : (
            <Repeat2
              aria-label="Recurring"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className="type-body-sm min-w-0 truncate text-left font-medium text-foreground">
            {page.title || "Untitled"}
          </span>
          <SyncSourceIcon className="ml-auto h-3 w-3" syncState={page.syncState} />
          {showLeftEdgeHandle && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1 cursor-ew-resize! touch-none"
              data-resize-edge="start"
              onPointerDown={startEdgeResize("start")}
            />
          )}
          {showRightEdgeHandle && (
            <span
              aria-hidden
              className="absolute inset-y-0 right-0 w-1 cursor-ew-resize! touch-none"
              data-resize-edge="end"
              onPointerDown={startEdgeResize("end")}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onClick={(e) => e.stopPropagation()}
        side="bottom"
        sideOffset={4}
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
            onRemoveDate={() => setPopoverOpen(false)}
            page={page}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
