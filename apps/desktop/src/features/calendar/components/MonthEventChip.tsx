import type { MonthCellEvent, VirtualOccurrence } from "@pikos/core";
import { formatTime12h, isDone } from "@pikos/core";
import { Repeat2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";

import { useCalendarBlockPopover } from "../hooks/useCalendarBlockPopover";
import { useRecurringActions } from "../hooks/useRecurringActions";
import { CHIP_BASE_CLASSES, chipFolderStyle } from "../utils/calendarColors";
import { PageBlockPopover } from "./PageBlockPopover";
import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

interface MonthEventChipProps {
  event: MonthCellEvent;
  /** Folder/calendar colour, resolved by the grid from the same folder map the
   * week grid's all-day section uses. */
  folderColor: string | undefined;
  onDoubleClick: (pageId: string) => void;
}

/**
 * One event inside a month cell. Deliberately gesture-light compared to
 * `PageBlock`/`AllDayBar`: month view has no drag, resize or drag-to-create
 * (a month cell is far too coarse to express a time), so the chip only carries
 * the click → popover and double-click → open-page behaviours. Everything
 * downstream of the click — the popover pair, the recurring/synced action
 * routing — is the same code path the week grid takes.
 */
export function MonthEventChip({ event, folderColor, onDoubleClick }: MonthEventChipProps) {
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
  const label = timeLabel ? `${timeLabel} ${page.title || "Untitled"}` : page.title || "Untitled";

  return (
    <Popover onOpenChange={handlePopoverOpenChange} open={popoverOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={label}
          className={cn(
            "flex w-full cursor-default! items-center gap-1",
            CHIP_BASE_CLASSES,
            page.syncState === "detached" && !done && "opacity-70",
            done && "opacity-50",
            // A multi-day event is drawn as one chip per covered cell (see
            // core/monthGrid's header note); squaring the shared corners keeps
            // the run reading as a single band across the week row.
            continuesBefore && "rounded-tl-none rounded-bl-none border-l-0",
            continuesAfter && "rounded-tr-none rounded-br-none"
          )}
          onClick={handleClick}
          onMouseDown={(e) => e.stopPropagation()}
          style={chipFolderStyle(folderColor)}
        >
          {showsCheckbox ? (
            <TaskCheckbox
              as="span"
              checked={done}
              className="h-3 w-3 shrink-0 cursor-pointer!"
              onChange={handleCheckboxClick}
            />
          ) : (
            <Repeat2 aria-label="Recurring" className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {timeLabel && <span className="shrink-0 text-subtle tabular-nums">{timeLabel}</span>}
          <span className="min-w-0 truncate text-left">{page.title || "Untitled"}</span>
          <SyncSourceIcon className="ml-auto h-3 w-3 shrink-0" syncState={page.syncState} />
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
