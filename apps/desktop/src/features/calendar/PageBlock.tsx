import type { PageStatus } from "@pikos/core";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { nowLocalISO } from "@/shared/utils/dates";

import {
  CHIP_BASE_CLASSES,
  CHIP_DEFAULT_COLOR_CLASSES,
  chipFolderStyle,
  DRAG_THRESHOLD,
  formatTimeRange,
  HOUR_HEIGHT,
  snapY,
} from "./calendarUtils";
import type { CalendarBlock } from "./calendarUtils";
import { PageBlockPopover } from "./PageBlockPopover";

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
const CLICK_DELAY = 200;

/** Bottom-edge zone height (px) that triggers the resize cursor. */
const RESIZE_ZONE = 8;

interface PageBlockProps {
  block: CalendarBlock;
  folderColor: string | undefined;
  /** When true, renders an inline title input for immediate editing of a newly created page. */
  isEditing?: boolean;
  /** Called with the committed title (may be empty → caller should delete the page). */
  onCommit?: (title: string) => void;
  /** Called when the user presses Escape — caller should delete the page. */
  onCancel?: () => void;
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
  block,
  folderColor,
  isDragging,
  isEditing,
  onCancel,
  onCommit,
  onDoubleClick,
  onDragStart,
  onResizeStart,
  resizeHeight,
}: PageBlockProps) {
  const { column, endDate, height, isCompact, page, startDate, top, totalColumns } = block;
  const { clearSchedule, deletePage, updatePage } = useWorkspace();

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

  // Inline editing state — only used when isEditing=true.
  const [inputValue, setInputValue] = useState(page.title);
  const committedRef = useRef(false);

  // Popover open state — only used in the non-editing path.
  const [popoverOpen, setPopoverOpen] = useState(false);

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

  function handleCommit(value: string) {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit?.(value);
  }

  function handleCancel() {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel?.();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCommit(e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    handleCommit(e.currentTarget.value);
  }

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
    if (isEditing) return;

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
    const newStatus: PageStatus = isDone ? "not_started" : "done";
    updatePage(page.id, {
      completedAt: newStatus === "done" ? nowLocalISO() : null,
      status: newStatus,
    });
  }

  const sharedStyle = {
    ...(folderColor ? chipFolderStyle(folderColor) : undefined),
    height: isRenderingCompact ? undefined : displayHeight,
    left: `${leftPct}%`,
    top,
    width: `calc(${widthPct}% - 2px)`,
  };

  // Checkbox — rendered as a span to avoid invalid nested <button> HTML.
  const checkbox = (
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
  );

  if (isEditing) {
    return (
      <div
        className={cn(
          "absolute",
          isRenderingCompact
            ? [CHIP_BASE_CLASSES, "flex items-center", !folderColor && CHIP_DEFAULT_COLOR_CLASSES]
            : [
                "flex flex-col items-start overflow-hidden rounded-sm border-l-2 px-1.5 py-0.5",
                !folderColor && "border-blue-500 bg-blue-500/15",
              ]
        )}
        style={sharedStyle}
      >
        <input
          autoFocus
          className={cn(
            "w-full border-0 bg-transparent font-medium text-foreground outline-none placeholder:text-muted-foreground/60",
            isRenderingCompact ? "text-sm leading-none" : "text-sm leading-tight"
          )}
          onBlur={handleBlur}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="Untitled"
          value={inputValue}
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <Popover onOpenChange={setPopoverOpen} open={popoverOpen}>
        <PopoverTrigger asChild>
          <ContextMenuTrigger asChild>
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
                  inResizeZone ? "cursor-ns-resize" : undefined
                )}
                onClick={handleClick}
                onMouseDown={handleBlockMouseDown}
                onMouseLeave={handleBlockMouseLeave}
                onMouseMove={handleBlockMouseMove}
                style={sharedStyle}
              >
                {checkbox}
                <span className="min-w-0 truncate">{page.title || "Untitled"}</span>
              </button>
            ) : (
              <button
                aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
                className={cn(
                  "absolute flex flex-col items-start overflow-hidden rounded-sm border-l-2 px-1.5 py-0.5 select-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                  !folderColor && "border-blue-500 bg-blue-500/15",
                  isDone ? "opacity-50" : "transition-opacity hover:opacity-75",
                  isDragging && "opacity-40",
                  inResizeZone ? "cursor-ns-resize" : "cursor-default"
                )}
                onClick={handleClick}
                onMouseDown={handleBlockMouseDown}
                onMouseLeave={handleBlockMouseLeave}
                onMouseMove={handleBlockMouseMove}
                style={sharedStyle}
              >
                <div className="flex w-full min-w-0 items-center gap-1">
                  {checkbox}
                  <p className="min-w-0 truncate text-sm leading-tight font-medium text-foreground">
                    {page.title || "Untitled"}
                  </p>
                </div>
                {showTimeLabel && (
                  <p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">
                    {timeLabel}
                  </p>
                )}
              </button>
            )}
          </ContextMenuTrigger>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[280px] p-3"
          onMouseDown={(e) => e.stopPropagation()}
          side="right"
          sideOffset={8}
        >
          <PageBlockPopover page={page} />
        </PopoverContent>
      </Popover>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void clearSchedule(page.id)}>Remove date</ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => void deletePage(page.id)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
