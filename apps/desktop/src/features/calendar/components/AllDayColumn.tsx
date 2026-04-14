import type { PageSummary, VirtualOccurrence } from "@pikos/core";
import { format } from "date-fns";
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
} from "../utils/calendarUtils";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

export interface AllDayColumnProps {
  autoOpenPageId: string | null;
  day: Date;
  draggingPageId: string | null;
  folderColorMap: Map<string, string>;
  /** Highlighted when an all-day chip is being dragged over this column. */
  isAllDayDragTarget: boolean;
  /** Highlighted when a timed block is being dragged over this column's all-day zone. */
  isTimedDragTarget: boolean;
  items: PageSummary[];
  onAutoOpenConsumed: () => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
}

interface AllDayChipProps {
  autoOpenPopover?: boolean;
  draggingPageId: string | null;
  folderColor: string | undefined;
  item: PageSummary;
  onAutoOpenConsumed?: () => void;
  onDoubleClick: (pageId: string) => void;
  onDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
}

function AllDayChip({
  autoOpenPopover,
  draggingPageId,
  folderColor,
  item,
  onAutoOpenConsumed,
  onDoubleClick,
  onDragStart,
}: AllDayChipProps) {
  const { requestDeletePage } = useUndoDelete();
  const {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  } = useRecurringActions(item);
  // Popover opens automatically for a freshly-created chip. Parent may flip
  // autoOpenPopover to true on a later render (chip mounts between
  // scheduleOnce's commit and setAutoOpenPageId's commit), so we latch on the
  // rising edge via the render-time derived-state pattern.
  const [popoverOpen, setPopoverOpen] = useState(autoOpenPopover ?? false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(autoOpenPopover ?? false);
  if (autoOpenPopover && !autoOpenHandled) {
    setAutoOpenHandled(true);
    setPopoverOpen(true);
  }
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handlePopoverOpenChange(open: boolean) {
    setPopoverOpen(open);
    if (!open && autoOpenHandled) {
      onAutoOpenConsumed?.();
    }
  }
  // Prevents the post-drag click from opening the popover.
  const isChipDraggingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (isChipDraggingRef.current) {
      setTimeout(() => {
        isChipDraggingRef.current = false;
      }, 0);
      return;
    }
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      onDoubleClick(item.id);
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      setPopoverOpen(true);
    }, CLICK_DELAY);
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault(); // prevent text selection during drag

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
        isChipDraggingRef.current = true;
        onDragStart({ folderColor, pageId: item.id });
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    toggleStatus();
  }

  const isDone = item.status === "done";
  const isBeingDragged = draggingPageId === item.id;
  const chipStyle = folderColor ? chipFolderStyle(folderColor) : undefined;

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={item.title || "Untitled"}
          className={cn(
            "flex w-full items-center gap-1",
            CHIP_BASE_CLASSES,
            !folderColor && CHIP_DEFAULT_COLOR_CLASSES,
            isDone && "opacity-50",
            isBeingDragged && "opacity-40"
          )}
          onClick={handleClick}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={handleMouseDown}
          style={chipStyle}
        >
          {isRecurring ? (
            <Repeat2 aria-label="Recurring" className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <TaskCheckbox as="span" checked={isDone} onChange={handleCheckboxClick} />
          )}
          <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
            {item.title || "Untitled"}
          </span>
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
            onSkip={() => {
              setPopoverOpen(false);
              void handleSkipOccurrence();
            }}
            page={item as VirtualOccurrence}
          />
        ) : (
          <PageBlockPopover
            onClose={() => setPopoverOpen(false)}
            onDelete={() => {
              setPopoverOpen(false);
              requestDeletePage(item);
            }}
            onRemoveDate={() => setPopoverOpen(false)}
            page={item}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AllDayColumn({
  autoOpenPageId,
  day,
  draggingPageId,
  folderColorMap,
  isAllDayDragTarget,
  isTimedDragTarget,
  items,
  onAutoOpenConsumed,
  onChipDragStart,
  onCreateAllDay,
  onPageDoubleClick,
}: AllDayColumnProps) {
  const weekend = day.getDay() === 0 || day.getDay() === 6;

  // Chips call stopPropagation so this only fires on empty-space clicks.
  function handleColumnClick() {
    void onCreateAllDay(day);
  }

  return (
    <div
      aria-label={`All-day events, ${format(day, "EEEE MMMM d")}`}
      className={cn(
        "flex min-w-0 flex-1 cursor-cell flex-col overflow-hidden border-l border-border/40 px-1 py-1 first:border-l-0",
        weekend ? "bg-white/[0.012]" : "",
        (isTimedDragTarget || isAllDayDragTarget) && "bg-accent/30"
      )}
      onClick={handleColumnClick}
    >
      {/* Event chips — full column width minus px-1 margin */}
      <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
        {items.map((item) => {
          const folderColor = item.folderId ? folderColorMap.get(item.folderId) : undefined;
          return (
            <AllDayChip
              autoOpenPopover={autoOpenPageId === item.id}
              draggingPageId={draggingPageId}
              folderColor={folderColor}
              item={item}
              key={item.id}
              onAutoOpenConsumed={onAutoOpenConsumed}
              onDoubleClick={onPageDoubleClick}
              onDragStart={onChipDragStart}
            />
          );
        })}
      </div>
    </div>
  );
}
