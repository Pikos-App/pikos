import type { MonthCellEvent, VirtualOccurrence } from "@pikos/core";
import { DEFAULT_EVENT_COLOR, formatTime12h, isDone } from "@pikos/core";
import { Repeat2 } from "lucide-react";

import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import { CHIP_BASE_CLASSES, chipFolderStyle } from "../utils/calendarColors";
import { BlockPopoverContent } from "./BlockPopoverContent";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

interface MonthEventChipProps {
  event: MonthCellEvent;
  folderColor: string | undefined;
  onDoubleClick: (pageId: string) => void;
  /** Its first day is drawn in an earlier row, whose bar carries the checkbox. */
  startShownAbove: boolean;
  width?: string | undefined;
}

/**
 * One event inside a month cell. Gesture-light next to `PageBlock`/`AllDayBar`: a month cell is too
 * coarse for drag or resize, so the chip only carries click to popover and double-click to open.
 * The popover pair and recurring/synced routing are the week grid's code path.
 */
export function MonthEventChip({
  event,
  folderColor,
  onDoubleClick,
  startShownAbove,
  width,
}: MonthEventChipProps) {
  const { continuesAfter, continuesBefore, isAllDay, page, startDate } = event;
  const { deleteBlock, isVirtual, showsCheckbox, toggleStatus } = useRecurringActions(page);

  const {
    handleClick,
    handlePopoverOpenChange,
    popoverOpen,
    setPopoverOpen,
    suppressPendingClick,
  } = useCalendarBlockPopover({ onDoubleClick: () => onDoubleClick(page.id) });

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    suppressPendingClick();
    toggleStatus();
  }

  const done = isDone(page);
  // Only a timed chip that starts on this very day shows a time — a
  // continuation cell's start time belongs to an earlier day.
  const timeLabel = !isAllDay && !continuesBefore ? formatTime12h(startDate) : null;
  const label = timeLabel ? `${page.title || "Untitled"} ${timeLabel}` : page.title || "Untitled";

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={label}
          className={cn(
            "relative flex w-full cursor-default! items-center gap-1",
            CHIP_BASE_CLASSES,
            done && "opacity-50",
            // Square ends say the event carries on into the previous or next week row.
            continuesBefore && "rounded-tl-none rounded-bl-none border-l-0",
            continuesAfter && "rounded-tr-none rounded-br-none"
          )}
          onClick={handleClick}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ ...chipFolderStyle(folderColor), width }}
        >
          {!showsCheckbox ? (
            <Repeat2 aria-label="Recurring" className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : startShownAbove ? null : (
            <TaskCheckbox
              as="span"
              borderColor={folderColor ?? DEFAULT_EVENT_COLOR}
              checked={done}
              className="cursor-pointer!"
              onChange={handleCheckboxClick}
              size="xs"
            />
          )}
          <span className="min-w-0 truncate text-left">{page.title || "Untitled"}</span>
          <SyncSourceIcon className="ml-auto h-3 w-3 shrink-0" syncState={page.syncState} />
        </button>
      </PopoverTrigger>
      <BlockPopoverContent
        align="start"
        className="w-[calc(20rem*var(--ui-text-scale,1))] p-3"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
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
      </BlockPopoverContent>
    </Popover>
  );
}
