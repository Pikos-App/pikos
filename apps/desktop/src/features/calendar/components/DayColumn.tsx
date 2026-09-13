import type { CalendarBlock, OverflowPill as OverflowPillData, PageSummary } from "@pikos/core";
import {
  buildDayBlocks,
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
} from "@pikos/core";
import { isSameDay } from "date-fns";
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { usePages } from "@/shared/context/PagesContext";

import { chipFolderStyle } from "../utils/calendarColors";
import { NowIndicator } from "./NowIndicator";
import { OverflowPill } from "./OverflowPill";
import { PageBlock } from "./PageBlock";

const PILL_OUTER_EDGE_PAD = 2;

/**
 * Anchored to leftPct=0/widthPct=100 so "+N more" spans the column's full
 * width inside the squished band. Top-band pills hug the band's top edge;
 * bottom-band pills hug the bottom — leaving the band's inner edge clear so
 * the tops of straddling blocks can intrude visibly without overlapping the
 * pill.
 */
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
  /** True when any active drag (external page-list or internal block) is over
   * this column — drives the drop-zone tint, mirroring the all-day strip. */
  isDropTarget: boolean;
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
  isDropTarget,
  now,
  onAutoOpenConsumed,
  onBlockDragStart,
  onBlockResizeStart,
  onCreatePage,
  onPageDoubleClick,
  pages,
  resizeGhost,
}: DayColumnProps) {
  const { folders } = usePages();
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

  const minDragHeight = metrics.minResizeHeight;

  // Hour and half-hour grid lines — only the visible (non-collapsed) hour
  // range gets gridlines; the collapsed bands render as solid stripes via
  // the dim overlay below.
  const hourLineFirst = collapse.topCollapsed ? collapse.topHour : GRID_START_HOUR;
  const hourLineLast = collapse.bottomCollapsed ? collapse.bottomHour : GRID_END_HOUR;
  const hours = Array.from({ length: hourLineLast - hourLineFirst }, (_, i) => hourLineFirst + i);

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

  const [draft, setDraft] = useState<{ startY: number; endY: number } | null>(null);

  const dragRef = useRef<{ startY: number; isDragging: boolean } | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || e.button !== 0) return;
    // Don't create a block if a context menu is open — the click is targeting the menu.
    if (document.querySelector('[role="menu"]')) return;
    // Presses that belong to something else: an event block, the overflow pill,
    // a collapsed-band expander — or, since React bubbles portal events through
    // the component tree rather than the DOM one, a popover rendered outside
    // this column entirely.
    //
    // Filtered here rather than by calling stopPropagation() at each of those
    // controls: pointerdown is also how Radix decides an open popover was
    // dismissed from outside, so swallowing it there would strand it open.
    const target = e.target as HTMLElement;
    if (!containerRef.current?.contains(target)) return;
    if (target.closest("[data-cal-page-id],[data-cal-no-create]")) return;
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

    function onPointerMove(ev: PointerEvent) {
      if (!ev.isPrimary || !dragRef.current) return;
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

    function onPointerUp(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      if (!dragRef.current) return;

      const { isDragging, startY: pressY } = dragRef.current;
      dragRef.current = null;
      setDraft(null);

      const currentRect = containerRef.current?.getBoundingClientRect();
      const upY = currentRect ? ev.clientY - currentRect.top : pressY;
      const start = mapYToDate(pressY, day, geometry);

      if (isDragging) {
        const endY = Math.max(upY, pressY + minDragHeight);
        const end = mapYToDate(endY, day, geometry);
        void onCreatePage(day, start, end > start ? end : undefined);
      } else {
        // Single click — only create when the y position is in empty grid.
        // `blocks` includes both visible blocks AND those collapsed into the
        // overflow pill, so clicks above or below the pill (which sit on top
        // of collapsed-event slots) don't fire phantom pages.
        const yOccupied = blocks.some((b) => pressY >= b.top && pressY <= b.top + b.height);
        if (!yOccupied) {
          void onCreatePage(day, start);
        }
      }
    }

    /** Platform-cancelled gesture — drop the draft, create nothing. */
    function onPointerCancel(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      dragRef.current = null;
      setDraft(null);
    }

    function teardown() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
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
                edge is the grid boundary). */}
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

      {/* Relative container for absolutely-positioned blocks. Drag-to-create
          is a pointer-only gesture; the keyboard equivalent is Cmd+N (Quick
          Add). Tab/focus support deferred to the post-launch a11y backlog. Can't use
          role="button" here — it would nest inside the interactive page
          blocks rendered as children. */}
      <div
        className={cn("relative cursor-cell", isDropTarget && "bg-accent/30")}
        onPointerDown={handlePointerDown}
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
            data-cal-no-create
            onClick={(e) => {
              e.stopPropagation();
              setTopCollapsed(false);
            }}
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
            data-cal-no-create
            onClick={(e) => {
              e.stopPropagation();
              setBottomCollapsed(false);
            }}
            onMouseEnter={() => setHoveredBand("bottom")}
            onMouseLeave={() => setHoveredBand(null)}
            style={{ height: geometry.bottomBandHeight, top: geometry.middleEnd }}
            type="button"
          />
        )}

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
            data-drag-ghost
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

        {visibleBlocks.map((block) => {
          const folderColor = block.page.folderId
            ? folderColorMap.get(block.page.folderId)
            : undefined;
          const autoOpen = autoOpenPageId === block.page.id;
          const isBeingDragged = draggingPageId === block.page.id;
          const isCompactWidth =
            columnWidth > 0 && (block.widthPct / 100) * columnWidth < COMPACT_MODE_WIDTH_PX;

          const resizeHeight =
            resizeGhost?.pageId === block.page.id && resizeGhost.dayIndex === dayIndex
              ? Math.max(resizeGhost.bottom - block.top, 0)
              : undefined;

          // Virtual/override occurrences share the series page id, so a moved
          // override and a same-day occurrence of the same series would collide
          // on a bare id key — disambiguate by occurrence date.
          const occDate = (block.page as { originalDate?: string }).originalDate;
          const blockKey = occDate ? `${block.page.id}:${occDate}` : block.page.id;

          return (
            <PageBlock
              autoOpenPopover={autoOpen}
              block={block}
              folderColor={folderColor}
              isCompactWidth={isCompactWidth}
              isDragging={isBeingDragged}
              key={blockKey}
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
            whose entire span sits inside a collapsed time range. */}
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
