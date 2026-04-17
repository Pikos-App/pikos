import type { VirtualOccurrence } from "@pikos/core";
import { format } from "date-fns";
import { Repeat2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

import { useRecurringActions } from "../hooks/useRecurringActions";
import type { AllDayItem } from "../utils/calendarUtils";
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
  onAutoOpenConsumed: () => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  /** Row-aligned slots across all visible days — null means empty row. */
  slots: (AllDayItem | null)[];
}

interface AllDayChipProps {
  autoOpenPopover?: boolean;
  draggingPageId: string | null;
  folderColor: string | undefined;
  item: AllDayItem;
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
  const { isContinuationBefore, page } = item;
  const { requestDeletePage } = useUndoDelete();
  const {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  } = useRecurringActions(page);
  const showLabel = !isContinuationBefore;
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
      onDoubleClick(page.id);
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
        onDragStart({ folderColor, pageId: page.id });
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

  const isDone = page.status === "done";
  const isBeingDragged = draggingPageId === page.id;
  const chipStyle = folderColor ? chipFolderStyle(folderColor) : undefined;

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={page.title || "Untitled"}
          className={cn(
            "flex w-full cursor-default! items-center gap-1",
            CHIP_BASE_CLASSES,
            !folderColor && CHIP_DEFAULT_COLOR_CLASSES,
            isDone && "opacity-50",
            isBeingDragged && "opacity-40",
            isContinuationBefore && "rounded-l-none border-l-0"
          )}
          onClick={handleClick}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={handleMouseDown}
          style={chipStyle}
        >
          {showLabel &&
            (isRecurring ? (
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
            ))}
          {showLabel && (
            <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
              {page.title || "Untitled"}
            </span>
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

export function AllDayColumn({
  autoOpenPageId,
  day,
  draggingPageId,
  folderColorMap,
  isAllDayDragTarget,
  isTimedDragTarget,
  onAutoOpenConsumed,
  onChipDragStart,
  onCreateAllDay,
  onPageDoubleClick,
  slots,
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
      {/* Row-aligned slots — nulls render as transparent spacers so multi-day chips line up across columns. */}
      <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
        {slots.map((slot, rowIdx) => {
          if (slot === null) {
            return <div aria-hidden className="h-[19px] shrink-0" key={`empty-${rowIdx}`} />;
          }
          const folderColor = slot.page.folderId
            ? folderColorMap.get(slot.page.folderId)
            : undefined;
          return (
            <AllDayChip
              autoOpenPopover={autoOpenPageId === slot.page.id}
              draggingPageId={draggingPageId}
              folderColor={folderColor}
              item={slot}
              key={slot.page.id}
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
