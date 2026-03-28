import type { PageStatus, PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";
import { format } from "date-fns";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  CHIP_BASE_CLASSES,
  CHIP_DEFAULT_COLOR_CLASSES,
  chipFolderStyle,
  DRAG_THRESHOLD,
} from "../utils/calendarUtils";
import { PageBlockPopover } from "./PageBlockPopover";

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
const CLICK_DELAY = 200;

export interface AllDayColumnProps {
  day: Date;
  draggingPageId: string | null;
  editingPageId: string | null;
  folderColorMap: Map<string, string>;
  /** Highlighted when an all-day chip is being dragged over this column. */
  isAllDayDragTarget: boolean;
  /** Highlighted when a timed block is being dragged over this column's all-day zone. */
  isTimedDragTarget: boolean;
  items: PageSummary[];
  onCancelCreate: (pageId: string) => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  onCommitTitle: (pageId: string, title: string) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
}

interface AllDayChipProps {
  draggingPageId: string | null;
  folderColor: string | undefined;
  item: PageSummary;
  onDoubleClick: (pageId: string) => void;
  onDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
}

function AllDayChip({
  draggingPageId,
  folderColor,
  item,
  onDoubleClick,
  onDragStart,
}: AllDayChipProps) {
  const { updatePage } = useWorkspace();
  const { requestDeletePage } = useUndoDelete();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    const newStatus: PageStatus = item.status === "done" ? "not_started" : "done";
    updatePage(item.id, {
      completedAt: newStatus === "done" ? nowLocalISO() : null,
      status: newStatus,
    });
  }

  const isDone = item.status === "done";
  const isBeingDragged = draggingPageId === item.id;
  const chipStyle = folderColor ? chipFolderStyle(folderColor) : undefined;

  return (
    <Popover onOpenChange={setPopoverOpen} open={popoverOpen}>
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
          <span
            aria-checked={isDone}
            aria-label={isDone ? "Mark not done" : "Mark done"}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-[2px] border transition-colors",
              "h-3.5 w-3.5",
              isDone
                ? "border-foreground/40 bg-foreground/10"
                : "border-current/30 hover:border-current/70"
            )}
            onClick={handleCheckboxClick}
            onMouseDown={(e) => e.stopPropagation()}
            role="checkbox"
            tabIndex={-1}
          >
            {isDone && <Check size={8} strokeWidth={2.5} />}
          </span>
          <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[280px] p-3"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        side="bottom"
        sideOffset={4}
      >
        <PageBlockPopover
          onDelete={() => {
            setPopoverOpen(false);
            requestDeletePage(item);
          }}
          onRemoveDate={() => setPopoverOpen(false)}
          page={item}
        />
      </PopoverContent>
    </Popover>
  );
}

export function AllDayColumn({
  day,
  draggingPageId,
  editingPageId,
  folderColorMap,
  isAllDayDragTarget,
  isTimedDragTarget,
  items,
  onCancelCreate,
  onChipDragStart,
  onCommitTitle,
  onCreateAllDay,
  onPageDoubleClick,
}: AllDayColumnProps) {
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const [inputValue, setInputValue] = useState("");
  const committedRef = useRef(false);

  // The page currently being inline-edited in this column (if any).
  const editingItem = items.find((it) => it.id === editingPageId) ?? null;

  function handleCommit(pageId: string, value: string) {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommitTitle(pageId, value);
  }

  function handleCancel(pageId: string) {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancelCreate(pageId);
  }

  // Chips call stopPropagation so this only fires on empty-space clicks.
  function handleColumnClick() {
    committedRef.current = false;
    setInputValue("");
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
          const chipStyle = folderColor ? chipFolderStyle(folderColor) : undefined;

          if (item.id === editingItem?.id) {
            return (
              <div
                className={cn(
                  "flex w-full items-center gap-1",
                  CHIP_BASE_CLASSES,
                  !folderColor && CHIP_DEFAULT_COLOR_CLASSES
                )}
                key={item.id}
                style={chipStyle}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border border-current/30" />
                <input
                  autoFocus
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm leading-none font-medium text-foreground outline-none placeholder:text-muted-foreground/60"
                  onBlur={(e) => handleCommit(item.id, e.currentTarget.value)}
                  onChange={(e) => setInputValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCommit(item.id, e.currentTarget.value);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      handleCancel(item.id);
                    }
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  placeholder="Untitled"
                  value={inputValue}
                />
              </div>
            );
          }

          return (
            <AllDayChip
              draggingPageId={draggingPageId}
              folderColor={folderColor}
              item={item}
              key={item.id}
              onDoubleClick={onPageDoubleClick}
              onDragStart={onChipDragStart}
            />
          );
        })}
      </div>
    </div>
  );
}
