import type { PageSummary } from "@pikos/core";
import { isSameDay } from "date-fns";
import { Check } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  buildDayBlocks,
  chipFolderStyle,
  COMPACT_BLOCK_HEIGHT,
  DRAG_THRESHOLD,
  formatTimeRange,
  GRID_END_HOUR,
  GRID_HEIGHT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
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
  /** Absolute Y from grid top — DayColumn converts to height for the matching block. */
  bottom: number;
}

interface DayColumnProps {
  day: Date;
  dayIndex: number;
  dragGhost: DragGhost | null;
  draggingPageId: string | null;
  editingPageId: string | null;
  isCurrentWeek: boolean;
  now: Date;
  onBlockDragStart: (info: BlockDragStartInfo) => void;
  onBlockResizeStart: (info: BlockResizeStartInfo) => void;
  onCancelCreate: (pageId: string) => void;
  onCommitTitle: (pageId: string, title: string) => void;
  onCreatePage: (day: Date, start: Date, end?: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  pages: PageSummary[];
  resizeGhost: ResizeGhost | null;
}

/** Minimum drag height in px — enforces 15-min minimum on drag-create. */
const MIN_DRAG_HEIGHT = (15 / 60) * HOUR_HEIGHT;

export function DayColumn({
  day,
  dayIndex,
  dragGhost,
  draggingPageId,
  editingPageId,
  isCurrentWeek,
  now,
  onBlockDragStart,
  onBlockResizeStart,
  onCancelCreate,
  onCommitTitle,
  onCreatePage,
  onPageDoubleClick,
  pages,
  resizeGhost,
}: DayColumnProps) {
  const { folders } = useWorkspace();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );

  const blocks = buildDayBlocks(pages, day);
  const showNowIndicator = isCurrentWeek && isSameDay(now, day);
  const weekend = day.getDay() === 0 || day.getDay() === 6;

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
    // Commit any in-progress inline edit. e.preventDefault() below suppresses blur,
    // so we must flush it manually before the old input unmounts without committing.
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
          endY: Math.max(currentY, dragRef.current.startY + MIN_DRAG_HEIGHT),
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
      const start = yToDate(mouseDownY, day);

      if (isDragging) {
        const endY = Math.max(upY, mouseDownY + MIN_DRAG_HEIGHT);
        const end = yToDate(endY, day);
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
            style={{ height: HOUR_HEIGHT, top: (hour - GRID_START_HOUR) * HOUR_HEIGHT }}
          >
            {/* Hour line */}
            <div className="absolute inset-x-0 top-0 border-t border-border/40" />
            {/* Half-hour line */}
            <div
              className="absolute inset-x-0 border-t border-border/20"
              style={{ top: HOUR_HEIGHT / 2 }}
            />
          </div>
        ))}
      </div>

      {/* Relative container for absolutely-positioned blocks */}
      <div
        className="relative cursor-cell"
        onMouseDown={handleMouseDown}
        ref={containerRef}
        style={{ height: GRID_HEIGHT }}
      >
        {/* Now indicator */}
        {showNowIndicator && <NowIndicator />}

        {/* Draft ghost block — shown while dragging to create */}
        {draft && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border-l-2 border-blue-500 bg-blue-500/20 opacity-75"
            style={{
              height: Math.max(draft.endY - draft.startY, COMPACT_BLOCK_HEIGHT),
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
              height: dragGhost.isCompact ? COMPACT_BLOCK_HEIGHT : dragGhost.height,
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
                <span className="min-w-0 truncate text-sm leading-none font-medium text-foreground">
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
                  <p className="min-w-0 truncate text-sm leading-tight font-medium text-foreground">
                    {dragGhost.title || "Untitled"}
                  </p>
                </div>
                {dragGhost.height >= 36 && (
                  <p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">
                    {formatTimeRange(
                      yToDate(dragGhost.top, day),
                      yToDate(dragGhost.top + dragGhost.height, day)
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
          const editing = editingPageId === block.page.id;
          const isBeingDragged = draggingPageId === block.page.id;

          // Resize ghost: override height for the block being resized.
          const resizeHeight =
            resizeGhost?.pageId === block.page.id
              ? Math.max(resizeGhost.bottom - block.top, 0)
              : undefined;

          return (
            <PageBlock
              block={block}
              folderColor={folderColor}
              isDragging={isBeingDragged}
              isEditing={editing}
              key={block.page.id}
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
              {...(editing
                ? {
                    onCancel: () => onCancelCreate(block.page.id),
                    onCommit: (title: string) => onCommitTitle(block.page.id, title),
                  }
                : {})}
            />
          );
        })}
      </div>
    </div>
  );
}
