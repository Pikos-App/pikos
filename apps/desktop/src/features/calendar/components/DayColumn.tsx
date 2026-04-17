import type { PageSummary } from "@pikos/core";
import { isSameDay } from "date-fns";
import { Check } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  buildDayBlocks,
  chipFolderStyle,
  DRAG_THRESHOLD,
  formatTimeRange,
  GRID_END_HOUR,
  GRID_START_HOUR,
  yToDate,
} from "../utils/calendarUtils";
import type { CalendarBlock } from "../utils/calendarUtils";
import { NowIndicator } from "./NowIndicator";
import { PageBlock } from "./PageBlock";

export interface BlockDragStartInfo {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
  clientY: number;
  folderColor: string | undefined;
}

export interface BlockResizeStartInfo {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
}

export interface DragGhost {
  top: number;
  height: number;
  isCompact: boolean;
  folderColor: string | undefined;
  title?: string | undefined;
  isDone?: boolean | undefined;
}

export interface ResizeGhost {
  pageId: string;
  /** Day column index the resize gesture originated on — scopes the ghost to a single continuation segment of a multi-day block. */
  dayIndex: number;
  /** Absolute Y from grid top — DayColumn converts to height for the matching block. */
  bottom: number;
}

interface DayColumnProps {
  day: Date;
  dayIndex: number;
  dragGhost: DragGhost | null;
  draggingPageId: string | null;
  autoOpenPageId: string | null;
  isCurrentWeek: boolean;
  now: Date;
  onBlockDragStart: (info: BlockDragStartInfo) => void;
  onBlockResizeStart: (info: BlockResizeStartInfo) => void;
  onAutoOpenConsumed: () => void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  pages: PageSummary[];
  resizeGhost: ResizeGhost | null;
}

export function DayColumn({
  autoOpenPageId,
  day,
  dayIndex,
  dragGhost,
  draggingPageId,
  isCurrentWeek,
  now,
  onAutoOpenConsumed,
  onBlockDragStart,
  onBlockResizeStart,
  onCreatePage,
  onPageDoubleClick,
  pages,
  resizeGhost,
}: DayColumnProps) {
  const { folders } = useWorkspace();
  const { metrics } = useCalendarSettings();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );

  const blocks = buildDayBlocks(pages, day, metrics);
  const showNowIndicator = isCurrentWeek && isSameDay(now, day);
  const weekend = day.getDay() === 0 || day.getDay() === 6;

  // Minimum drag height in px — enforces 15-min minimum on drag-create (scales with density).
  const minDragHeight = metrics.minResizeHeight;

  // Hour and half-hour grid lines
  const hours = Array.from(
    { length: GRID_END_HOUR - GRID_START_HOUR },
    (_, i) => GRID_START_HOUR + i
  );

  // Ref to the absolutely-positioned block container (used for Y offset calculation).
  const containerRef = useRef<HTMLDivElement>(null);

  // Draft ghost block — visible while dragging to set duration before page creation.
  const [draft, setDraft] = useState<{ startY: number; endY: number } | null>(null);

  // Tracks ongoing drag gesture across window events.
  const dragRef = useRef<{ startY: number; isDragging: boolean } | null>(null);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Don't create a block if a context menu is open — the click is targeting the menu.
    if (document.querySelector('[role="menu"]')) return;
    // Commit any open popover's title input: e.preventDefault() below suppresses
    // the default focus/blur behavior, so we must flush it manually before the
    // input unmounts — otherwise the typed title is lost and the auto-created
    // page gets deleted as "empty" by handleAutoOpenConsumed.
    (document.activeElement as HTMLElement | null)?.blur();
    e.preventDefault(); // prevent text selection during drag

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startY = e.clientY - rect.top;
    dragRef.current = { isDragging: false, startY };

    function onMouseMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const currentRect = containerRef.current?.getBoundingClientRect();
      if (!currentRect) return;
      const currentY = ev.clientY - currentRect.top;
      if (
        !dragRef.current.isDragging &&
        Math.abs(currentY - dragRef.current.startY) > DRAG_THRESHOLD
      ) {
        dragRef.current.isDragging = true;
      }
      if (dragRef.current.isDragging) {
        setDraft({
          endY: Math.max(currentY, dragRef.current.startY + minDragHeight),
          startY: dragRef.current.startY,
        });
      }
    }

    function onMouseUp(ev: MouseEvent) {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (!dragRef.current) return;

      const { isDragging, startY: mouseDownY } = dragRef.current;
      dragRef.current = null;
      setDraft(null);

      const currentRect = containerRef.current?.getBoundingClientRect();
      const upY = currentRect ? ev.clientY - currentRect.top : mouseDownY;
      const start = yToDate(mouseDownY, day, metrics.hourHeight);

      if (isDragging) {
        const endY = Math.max(upY, mouseDownY + minDragHeight);
        const end = yToDate(endY, day, metrics.hourHeight);
        void onCreatePage(day, start, end > start ? end : undefined);
      } else {
        void onCreatePage(day, start);
      }
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div
      className={cn(
        "relative min-w-0 flex-1 border-l border-border/50 first:border-l-0",
        weekend ? "bg-white/[0.012]" : ""
      )}
    >
      {/* Hour + half-hour grid lines */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {hours.map((hour) => (
          <div
            className="absolute inset-x-0"
            key={hour}
            style={{ height: metrics.hourHeight, top: hour * metrics.hourHeight }}
          >
            {/* Hour line — skipped for the first row; its top edge is the grid boundary. */}
            {hour !== GRID_START_HOUR && (
              <div className="absolute inset-x-0 top-0 border-t border-border/40" />
            )}
            {/* Half-hour line */}
            <div
              className="absolute inset-x-0 border-t border-border/20"
              style={{ top: metrics.hourHeight / 2 }}
            />
          </div>
        ))}
      </div>

      {/* Relative container for absolutely-positioned blocks */}
      <div
        className="relative cursor-cell"
        onMouseDown={handleMouseDown}
        ref={containerRef}
        style={{ height: metrics.gridHeight }}
      >
        {/* Now indicator */}
        {showNowIndicator && <NowIndicator now={now} />}

        {/* Draft ghost block — shown while dragging to create */}
        {draft && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border-l-2 border-blue-500 bg-blue-500/20 opacity-75"
            style={{
              height: Math.max(draft.endY - draft.startY, metrics.compactBlockHeight),
              left: 2,
              right: 2,
              top: draft.startY,
            }}
          />
        )}

        {/* Drag-to-reschedule ghost — rendered in the target column */}
        {dragGhost && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute overflow-hidden rounded-sm border-l-2 opacity-80",
              dragGhost.isCompact
                ? "flex items-center gap-1 px-1.5"
                : "flex flex-col items-start px-1.5 py-0.5"
            )}
            style={{
              height: dragGhost.isCompact ? metrics.compactBlockHeight : dragGhost.height,
              left: 2,
              right: 2,
              top: dragGhost.top,
              ...(dragGhost.folderColor
                ? chipFolderStyle(dragGhost.folderColor)
                : { backgroundColor: "rgba(59,130,246,0.25)", borderColor: "rgb(59,130,246)" }),
            }}
          >
            {dragGhost.isCompact ? (
              <>
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border",
                    dragGhost.isDone ? "border-foreground/40 bg-foreground/10" : "border-current/30"
                  )}
                >
                  {dragGhost.isDone && <Check size={8} strokeWidth={2.5} />}
                </span>
                <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
                  {dragGhost.title || "Untitled"}
                </span>
              </>
            ) : (
              <>
                <div className="flex w-full min-w-0 items-center gap-1">
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border",
                      dragGhost.isDone
                        ? "border-foreground/40 bg-foreground/10"
                        : "border-current/30"
                    )}
                  >
                    {dragGhost.isDone && <Check size={8} strokeWidth={2.5} />}
                  </span>
                  <p className="type-body-sm min-w-0 truncate font-medium text-foreground">
                    {dragGhost.title || "Untitled"}
                  </p>
                </div>
                {dragGhost.height >= 36 && (
                  <p className="type-ui-sm mt-0.5 truncate text-subtle">
                    {formatTimeRange(
                      yToDate(dragGhost.top, day, metrics.hourHeight),
                      yToDate(dragGhost.top + dragGhost.height, day, metrics.hourHeight)
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Page blocks */}
        {blocks.map((block) => {
          const folderColor = block.page.folderId
            ? folderColorMap.get(block.page.folderId)
            : undefined;
          const autoOpen = autoOpenPageId === block.page.id;
          const isBeingDragged = draggingPageId === block.page.id;

          // Resize ghost: override height for the block being resized.
          const resizeHeight =
            resizeGhost?.pageId === block.page.id && resizeGhost.dayIndex === dayIndex
              ? Math.max(resizeGhost.bottom - block.top, 0)
              : undefined;

          return (
            <PageBlock
              autoOpenPopover={autoOpen}
              block={block}
              folderColor={folderColor}
              isDragging={isBeingDragged}
              key={block.page.id}
              onAutoOpenConsumed={onAutoOpenConsumed}
              onDoubleClick={onPageDoubleClick}
              onDragStart={(_clientX, clientY) => {
                onBlockDragStart({
                  block,
                  clientY,
                  dayIndex,
                  folderColor,
                  pageId: block.page.id,
                });
              }}
              onResizeStart={() => {
                onBlockResizeStart({ block, dayIndex, pageId: block.page.id });
              }}
              {...(resizeHeight !== undefined ? { resizeHeight } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}
