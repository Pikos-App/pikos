import type { PageSummary } from "@pikos/core";
import { isSameDay } from "date-fns";
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  buildDayBlocks,
  chipFolderStyle,
  collapsedBandPillHeight,
  collapseUnderWidth,
  COMPACT_MODE_WIDTH_PX,
  DRAG_THRESHOLD,
  formatTimeRange,
  GRID_END_HOUR,
  GRID_START_HOUR,
  mapHourToY,
  mapYToDate,
  remapBlocksForCollapse,
} from "../utils/calendarUtils";
import type { CalendarBlock, OverflowPill as OverflowPillData } from "../utils/calendarUtils";
import { NowIndicator } from "./NowIndicator";
import { OverflowPill } from "./OverflowPill";
import { PageBlock } from "./PageBlock";

/** Builds an OverflowPill for a collapsed time band. Anchored to
 * leftPct=0/widthPct=100 so "+N more" spans the column's full width inside
 * the squished band. Top-band pills hug the band's top edge; bottom-band
 * pills hug the bottom — leaving the band's inner edge clear so the tops of
 * straddling blocks can intrude visibly without overlapping the pill. */
const PILL_OUTER_EDGE_PAD = 2;

function makeCollapsedBandPill(
  pageIds: string[],
  bandTop: number,
  bandHeight: number,
  edge: "top" | "bottom"
): OverflowPillData {
  const pillHeight = collapsedBandPillHeight(bandHeight);
  const top =
    edge === "top"
      ? bandTop + PILL_OUTER_EDGE_PAD
      : bandTop + bandHeight - pillHeight - PILL_OUTER_EDGE_PAD;
  return { height: pillHeight, leftPct: 0, pageIds, top, widthPct: 100 };
}

export interface BlockDragStartInfo {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
  clientY: number;
  folderColor: string | undefined;
  /** Set when the dragged block is a virtual rrule occurrence — keys the override. */
  originalDate?: string;
}

export interface BlockResizeStartInfo {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
  /** Set when the resized block is a virtual rrule occurrence — keys the override. */
  originalDate?: string;
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
  const {
    collapse,
    geometry,
    hoveredBand,
    metrics,
    setBottomCollapsed,
    setHoveredBand,
    setTopCollapsed,
  } = useCalendarSettings();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );

  const rawBlocks = buildDayBlocks(pages, day, metrics);
  const {
    bottomCollapsedPageIds,
    topCollapsedPageIds,
    visible: blocks,
  } = remapBlocksForCollapse(rawBlocks, geometry);
  const showNowIndicator = isCurrentWeek && isSameDay(now, day);
  const weekend = day.getDay() === 0 || day.getDay() === 6;

  // Minimum drag height in px — enforces 15-min minimum on drag-create (scales with density).
  const minDragHeight = metrics.minResizeHeight;

  // Hour and half-hour grid lines — only the visible (non-collapsed) hour
  // range gets gridlines; the collapsed bands render as solid stripes via
  // the dim overlay below.
  const hourLineFirst = collapse.topCollapsed ? collapse.topHour : GRID_START_HOUR;
  const hourLineLast = collapse.bottomCollapsed ? collapse.bottomHour : GRID_END_HOUR;
  const hours = Array.from({ length: hourLineLast - hourLineFirst }, (_, i) => hourLineFirst + i);

  // Ref to the absolutely-positioned block container (used for Y offset calculation).
  const containerRef = useRef<HTMLDivElement>(null);

  // Column width drives the dense-day overflow + compact-mode rules. Sync
  // first read via useLayoutEffect to avoid a frame of "wide" rendering
  // before ResizeObserver fires; then RO for live width changes.
  const [columnWidth, setColumnWidth] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const next = el.getBoundingClientRect().width;
      setColumnWidth((prev) => (prev === next ? prev : next));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { pill, visible: visibleBlocks } = collapseUnderWidth(
    blocks,
    columnWidth,
    metrics.compactBlockHeight
  );
  const pagesById = new Map(pages.map((p) => [p.id, p]));

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
      const start = mapYToDate(mouseDownY, day, geometry);

      if (isDragging) {
        const endY = Math.max(upY, mouseDownY + minDragHeight);
        const end = mapYToDate(endY, day, geometry);
        void onCreatePage(day, start, end > start ? end : undefined);
      } else {
        // Single click — only create when the y position is in empty grid.
        // `blocks` includes both visible blocks AND those collapsed into the
        // overflow pill, so clicks above or below the pill (which sit on top
        // of collapsed-event slots) don't fire phantom pages.
        const yOccupied = blocks.some((b) => mouseDownY >= b.top && mouseDownY <= b.top + b.height);
        if (!yOccupied) {
          void onCreatePage(day, start);
        }
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
      {/* Hour + half-hour grid lines — only emitted for the visible (non-
          collapsed) hour range. Each collapsed band gets a 1px divider at
          the band/middle boundary so straddling blocks visibly poke through
          into compressed time, but no separate background tint (the band
          shares the column's surface). */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {collapse.topCollapsed && (
          <div
            className="absolute inset-x-0 top-0 border-b border-border/60"
            style={{ height: geometry.topBandHeight }}
          />
        )}
        {collapse.bottomCollapsed && (
          <div
            className="absolute inset-x-0 border-t border-border/60"
            style={{ height: geometry.bottomBandHeight, top: geometry.middleEnd }}
          />
        )}
        {hours.map((hour) => (
          <div
            className="absolute inset-x-0"
            key={hour}
            style={{ height: metrics.hourHeight, top: mapHourToY(hour, geometry) }}
          >
            {/* Hour line — skipped for the very first row of the grid (its top
                edge is the grid boundary). Always drawn at internal hours. */}
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
        {/* Click-to-expand overlays for collapsed bands. Sit at the bottom of
            the stacking order so straddling blocks and the band's `+N more`
            pill stay clickable; absorb clicks on the empty band area and
            expand the band rather than create a hidden-time event. Hover
            state is synced via context so hovering any column lights up the
            entire band — gutter included — as a single click target. */}
        {collapse.topCollapsed && (
          <button
            aria-label="Expand collapsed early-morning hours"
            className={cn(
              "absolute inset-x-0 top-0 cursor-pointer",
              hoveredBand === "top" && "bg-foreground/[0.04]"
            )}
            onClick={(e) => {
              e.stopPropagation();
              setTopCollapsed(false);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredBand("top")}
            onMouseLeave={() => setHoveredBand(null)}
            style={{ height: geometry.topBandHeight }}
            type="button"
          />
        )}
        {collapse.bottomCollapsed && (
          <button
            aria-label="Expand collapsed late-evening hours"
            className={cn(
              "absolute inset-x-0 cursor-pointer",
              hoveredBand === "bottom" && "bg-foreground/[0.04]"
            )}
            onClick={(e) => {
              e.stopPropagation();
              setBottomCollapsed(false);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredBand("bottom")}
            onMouseLeave={() => setHoveredBand(null)}
            style={{ height: geometry.bottomBandHeight, top: geometry.middleEnd }}
            type="button"
          />
        )}

        {/* Now indicator */}
        {showNowIndicator && <NowIndicator now={now} />}

        {/* Draft ghost block — shown while dragging to create */}
        {draft && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border-l-2 opacity-75"
            style={{
              ...chipFolderStyle(),
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
              height: dragGhost.height,
              left: 2,
              right: 2,
              top: dragGhost.top,
              ...chipFolderStyle(dragGhost.folderColor),
            }}
          >
            {dragGhost.isCompact ? (
              <>
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-[2px] border",
                    dragGhost.height < 16 ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
                    dragGhost.isDone ? "border-foreground/40 bg-foreground/10" : "border-current/30"
                  )}
                >
                  {dragGhost.isDone && <Check size={8} strokeWidth={2.5} />}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate font-medium text-foreground",
                    dragGhost.height < 16 ? "-mt-px text-[10px] leading-none" : "type-body-sm"
                  )}
                >
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
                {dragGhost.height >= 40 && (
                  <p className="type-ui-sm mt-0.5 truncate text-subtle">
                    {formatTimeRange(
                      mapYToDate(dragGhost.top, day, geometry),
                      mapYToDate(dragGhost.top + dragGhost.height, day, geometry)
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Page blocks */}
        {visibleBlocks.map((block) => {
          const folderColor = block.page.folderId
            ? folderColorMap.get(block.page.folderId)
            : undefined;
          const autoOpen = autoOpenPageId === block.page.id;
          const isBeingDragged = draggingPageId === block.page.id;
          // Compact mode: the block's rendered width has dropped below the
          // legible-time threshold. PageBlock collapses to a single-line
          // title-only render and hides the checkbox until hover.
          const isCompactWidth =
            columnWidth > 0 && (block.widthPct / 100) * columnWidth < COMPACT_MODE_WIDTH_PX;

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
              isCompactWidth={isCompactWidth}
              isDragging={isBeingDragged}
              key={block.page.id}
              onAutoOpenConsumed={onAutoOpenConsumed}
              onDoubleClick={onPageDoubleClick}
              onDragStart={(_clientX, clientY) => {
                const virtual = block.page as { originalDate?: string };
                onBlockDragStart({
                  block,
                  clientY,
                  dayIndex,
                  folderColor,
                  pageId: block.page.id,
                  ...(virtual.originalDate && { originalDate: virtual.originalDate }),
                });
              }}
              onResizeStart={() => {
                const virtual = block.page as { originalDate?: string };
                onBlockResizeStart({
                  block,
                  dayIndex,
                  pageId: block.page.id,
                  ...(virtual.originalDate && { originalDate: virtual.originalDate }),
                });
              }}
              {...(resizeHeight !== undefined ? { resizeHeight } : {})}
            />
          );
        })}
        {pill && <OverflowPill onOpen={onPageDoubleClick} pagesById={pagesById} pill={pill} />}

        {/* Collapsed-band overflow pills — one per band when there are pages
            whose entire span sits inside a collapsed time range. Anchored to
            the band's pixel slice so the chip is centered vertically inside
            the compressed band. */}
        {topCollapsedPageIds.length > 0 && (
          <OverflowPill
            onOpen={onPageDoubleClick}
            pagesById={pagesById}
            pill={makeCollapsedBandPill(topCollapsedPageIds, 0, geometry.topBandHeight, "top")}
          />
        )}
        {bottomCollapsedPageIds.length > 0 && (
          <OverflowPill
            onOpen={onPageDoubleClick}
            pagesById={pagesById}
            pill={makeCollapsedBandPill(
              bottomCollapsedPageIds,
              geometry.middleEnd,
              geometry.bottomBandHeight,
              "bottom"
            )}
          />
        )}
      </div>
    </div>
  );
}
