// Timed-block positioning + nested-cascade collision logic. Produces the
// CalendarBlock[] consumed by DayColumn / PageBlock.
//
// The overflow ("+N more" pill) collapse and the collapsed-band remap also
// live here — they're tightly coupled to CalendarBlock and would not gain
// readability by sitting in their own file.

import type { PageSummary } from "@pikos/core";
import { addDays, parseISO, startOfDay } from "date-fns";

import { isAllDayPage } from "./allDayLayout";
import {
  CASCADE_OFFSET_PCT,
  CHIP_STACKED_THRESHOLD,
  COMPACT_BLOCK_HEIGHT,
  DRAG_THRESHOLD,
  MAX_VISIBLE_CASCADE_DEPTH,
  MIN_TIMED_MINUTES,
  OVERFLOW_MIN_WIDTH_PX,
  VISIBLE_HOURS,
} from "./calendarConstants";
import {
  type CalendarMetrics,
  collapsedBandInnerOffset,
  type CollapseGeometry,
  DEFAULT_METRICS,
  mapHourToY,
  timeToY,
} from "./calendarGeometry";

// ─── CalendarBlock ──────────────────────────────────────────────────────────

export interface CalendarBlock {
  page: PageSummary;
  startDate: Date;
  endDate: Date;
  /** Pixel distance from grid top */
  top: number;
  /** Pixel height */
  height: number;
  /** True when duration < MIN_TIMED_MINUTES or there is no scheduledEnd. */
  isCompact: boolean;
  /** Horizontal position as percent of the day column's width (0..100). */
  leftPct: number;
  /** Horizontal extent as percent of the day column's width (0..100). */
  widthPct: number;
  /**
   * Cascade column index (0 = host, 1 = first cascade, …). Drives depth-based
   * collapse in `collapseUnderWidth` — beyond `MAX_VISIBLE_CASCADE_DEPTH` a
   * block folds into the "+N more" pill regardless of its rendered width.
   */
  cascadeDepth: number;
  /** True when this block is a continuation from the previous day (event started before this day). */
  isContinuationBefore?: boolean;
  /** True when this event extends past the end of this day's grid. */
  isContinuationAfter?: boolean;
  /** True when the block straddles the top collapsed band (some of its time
   * falls inside the compressed band). Drives a square top-edge cue. */
  straddlesTopBand?: boolean;
  /** True when the block straddles the bottom collapsed band. Drives a square
   * bottom-edge cue. */
  straddlesBottomBand?: boolean;
}

/**
 * Data the overflow pill needs — separate from CalendarBlock so the pill
 * isn't a synthetic page. The pill replaces the slot of the rightmost
 * cascaded under-width event, with a min-width floor so "+N more" stays
 * legible on narrow columns. Renders as a single chip at the slot's top.
 */
export interface OverflowPill {
  /** y-position (px from grid top) — top of the topmost collapsed event. */
  top: number;
  /** Pixel height (matches a compact chip). */
  height: number;
  /** Horizontal position as percent of the day column's width. */
  leftPct: number;
  /** Horizontal extent as percent of the day column's width. */
  widthPct: number;
  /** Page ids that were collapsed into this pill. */
  pageIds: string[];
}

// ─── Overflow pill ──────────────────────────────────────────────────────────

/** Floor on the pill's chip height — below this, "+N more" wraps or clips. */
const MIN_PILL_HEIGHT_PX = 14;

/** Minimum pixel width for the pill — ensures "+N more" stays legible even
 * when the rightmost-cascaded slot is very narrow. */
const PILL_MIN_WIDTH_PX = 64;

/**
 * Collapses any blocks that would render narrower than OVERFLOW_MIN_WIDTH_PX
 * into a right-edge "+N more" pill. Returns the surviving blocks plus an
 * optional pill describing the collapsed ones. When `columnWidth <= 0` (no
 * measurement yet) returns the input unchanged so first paint isn't lossy.
 *
 * The pill anchors at the topmost collapsed block's `top` so it sits inside
 * the dense cluster rather than floating in empty space.
 */
export function collapseUnderWidth(
  blocks: CalendarBlock[],
  columnWidth: number,
  chipHeight: number = COMPACT_BLOCK_HEIGHT
): { visible: CalendarBlock[]; pill: OverflowPill | null } {
  if (columnWidth <= 0) return { pill: null, visible: blocks };
  const collapsed: CalendarBlock[] = [];
  const visible: CalendarBlock[] = [];
  for (const b of blocks) {
    const renderedWidth = (b.widthPct / 100) * columnWidth;
    const tooDeep = b.cascadeDepth > MAX_VISIBLE_CASCADE_DEPTH;
    const tooNarrow = renderedWidth < OVERFLOW_MIN_WIDTH_PX;
    if (tooDeep || tooNarrow) {
      collapsed.push(b);
    } else {
      visible.push(b);
    }
  }
  if (collapsed.length === 0) return { pill: null, visible };

  // Horizontal position: take the slot of the rightmost-cascaded collapsed
  // event. If that slot is too narrow to render "+N more" legibly, expand
  // the pill leftward to a minimum readable width.
  const slotHost = collapsed.reduce(
    (best, b) => (b.leftPct > best.leftPct ? b : best),
    collapsed[0]!
  );
  const minPillPct = Math.min(50, (PILL_MIN_WIDTH_PX / columnWidth) * 100);
  const widthPct = Math.max(slotHost.widthPct, minPillPct);
  const leftPct = Math.min(slotHost.leftPct, 100 - widthPct);

  // Pill is chip-shaped (a "+N more" indicator, not a full block replacement).
  // Height tracks the current density's quarter-hour slot so it scales with
  // hourHeight — a hair smaller in compact, a hair taller in spacious — but
  // never falls below the legible-text floor.
  const height = Math.max(chipHeight, MIN_PILL_HEIGHT_PX);

  const pill: OverflowPill = {
    height,
    leftPct,
    pageIds: collapsed.map((b) => b.page.id),
    top: slotHost.top,
    widthPct,
  };
  return { pill, visible };
}

// ─── Collapsed-band remap ──────────────────────────────────────────────────

/**
 * Result of remapping a day's CalendarBlocks against a collapse geometry.
 * Blocks fully inside a collapsed band drop out of `visible` and their page
 * ids accumulate into one of the *Pill arrays — the renderer emits a single
 * `+N more` chip in that band's pixel range. Blocks straddling a boundary
 * stay in `visible` with their `top` and `height` rewritten through the
 * geometry; visually they grow out of the compressed band into the middle.
 */
export interface RemappedBlocks {
  visible: CalendarBlock[];
  topCollapsedPageIds: string[];
  bottomCollapsedPageIds: string[];
}

export function remapBlocksForCollapse(
  blocks: CalendarBlock[],
  geometry: CollapseGeometry
): RemappedBlocks {
  const { config, hourHeight } = geometry;
  const visible: CalendarBlock[] = [];
  const topCollapsedPageIds: string[] = [];
  const bottomCollapsedPageIds: string[] = [];

  for (const b of blocks) {
    const startHour = b.top / hourHeight;
    const endHour = (b.top + b.height) / hourHeight;

    if (config.topCollapsed && endHour <= config.topHour) {
      topCollapsedPageIds.push(b.page.id);
      continue;
    }
    if (config.bottomCollapsed && startHour >= config.bottomHour) {
      bottomCollapsedPageIds.push(b.page.id);
      continue;
    }

    // Blocks straddling a collapsed boundary slip just past the band's `+N
    // more` pill — same vertical padding the pill uses inside the band — so
    // they all emerge from the same y regardless of start-time-within-band,
    // while still rendering slightly into the collapsed space to signal that
    // they're partially in the compressed range. Without this, blocks would
    // either cascade by start-minute (meaningless on a compressed band) or
    // sit flush at the boundary (no visual cue that they extend into it).
    const rawTop = mapHourToY(startHour, geometry);
    const rawBottom = mapHourToY(endHour, geometry);
    const straddlesTopBand = config.topCollapsed && startHour < config.topHour;
    const straddlesBottomBand = config.bottomCollapsed && endHour > config.bottomHour;
    const newTop = straddlesTopBand
      ? geometry.topBandHeight - collapsedBandInnerOffset(geometry.topBandHeight) + 1
      : rawTop;
    const newBottom = straddlesBottomBand
      ? geometry.middleEnd + collapsedBandInnerOffset(geometry.bottomBandHeight) - 1
      : rawBottom;
    const newHeight = Math.max(newBottom - newTop, 4);
    visible.push({
      ...b,
      height: newHeight,
      top: newTop,
      ...(straddlesTopBand ? { straddlesTopBand: true as const } : {}),
      ...(straddlesBottomBand ? { straddlesBottomBand: true as const } : {}),
    });
  }

  return { bottomCollapsedPageIds, topCollapsedPageIds, visible };
}

// ─── Cascade tuning constants (file-local) ──────────────────────────────────

/**
 * Maximum leftPct a cascading event can reach. Once cascaded past this, deeper
 * events all land at the same indent — they keep stacking in DOM order so each
 * still gets a visible left edge from the host underneath.
 */
const CASCADE_MAX_LEFT_PCT = 60;

/**
 * Minimum vertical separation (px) between two overlapping events' tops for
 * cascade to remain readable. Pairs with tops closer than this are split into
 * equal sub-columns instead — cascading them would put both titles in the
 * same horizontal band. Roughly the height of a 2-line title + time row.
 */
const CASCADE_MIN_TOP_GAP_PX = 40;

/**
 * Tighter threshold used for chip-vs-chip pairs. Chips are short (~19px) and
 * their single-line text doesn't reach into a host's title/time row, so 30
 * min apart already separates them visually — no need to split them into
 * sub-columns when they're not actually stacking on top of each other.
 */
const CHIP_COLLISION_GAP_PX = 20;

// ─── buildDayBlocks ────────────────────────────────────────────────────────

/**
 * Given all pages, returns positioned CalendarBlock[] for `day`.
 * All-day events are excluded (use buildAllDayItems instead).
 *
 * Overlap handling: a **nested cascade** matching Google Calendar's "Russian-
 * doll" look. Each subsequent overlap depth indents right by CASCADE_OFFSET_PCT
 * and renders on top of its host, so the host's title stays visible at the
 * top-left while the guest peeks out on the right.
 *
 * Events whose tops are within CASCADE_MIN_TOP_GAP_PX (e.g. same start time, or
 * very close starts) cannot cascade legibly — both titles would land in the
 * same band — so they're collected into a "text-collision component" and split
 * into equal sub-columns side-by-side instead.
 *
 * Events that span across midnight are shown on each day they touch:
 * - On the start day: renders from event start to bottom of grid (isContinuationAfter)
 * - On middle days: renders full grid height (isContinuationBefore + isContinuationAfter)
 * - On the end day: renders from top of grid to event end (isContinuationBefore)
 */
export function buildDayBlocks(
  pages: PageSummary[],
  day: Date,
  metrics: CalendarMetrics = DEFAULT_METRICS
): CalendarBlock[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  // Filter: must have a timed scheduledStart that overlaps with this day.
  // Multi-day timed events are NOT promoted to the all-day row — they render
  // here as one segment per day they touch (continuation flags on each
  // segment drive the radius + label rules in PageBlock).
  const overlapping = pages.filter((page) => {
    if (!page.scheduledStart) return false;
    if (isAllDayPage(page.scheduledStart)) return false;
    try {
      const start = parseISO(page.scheduledStart);
      const end = page.scheduledEnd ? parseISO(page.scheduledEnd) : start;
      return start < dayEnd && end > dayStart;
    } catch {
      return false;
    }
  });

  if (overlapping.length === 0) return [];

  const raws: RawBlock[] = overlapping.map((page) =>
    buildRawBlock(page, dayStart, dayEnd, metrics)
  );

  // Sort by visual top, then start time, then id — gives identical time ranges
  // a deterministic depth ordering across re-renders.
  raws.sort(
    (a, b) =>
      a.top - b.top ||
      a.startDate.getTime() - b.startDate.getTime() ||
      a.page.id.localeCompare(b.page.id)
  );

  const clusters = groupIntoClusters(raws);
  const blocks: CalendarBlock[] = [];

  for (const cluster of clusters) {
    const assignments = assignColumns(cluster);
    const components = findTextCollisionComponents(cluster);

    for (let i = 0; i < cluster.length; i++) {
      const raw = cluster[i]!;
      const component = components[i]!;
      let leftPct: number;
      let widthPct: number;

      // Cascade depth is always the cluster's sweep-line column. Close-top
      // membership only changes LAYOUT (50/50 split instead of cascade) — it
      // does NOT promote a close-top sub-component to lower depth. Without
      // this, a close-top pair sitting at cluster columns 2+3 would render
      // as host-50%/guest-50% with depth 0/1 and stay visible past the
      // MAX_VISIBLE_CASCADE_DEPTH cap that fires for the surrounding cluster.
      const cascadeDepth = assignments[i]!;

      // Close-top split only applies when the sub-component owns the cluster
      // host (depth 0). A mid-cluster close-top pair (e.g. Peer/Stakeholder
      // sitting at cluster cols 1–2 alongside a separate Workshop host at
      // col 0) would otherwise paint at leftPct=0/widthPct=50 and visually
      // collide with the actual cluster host. Mid-cluster close-top falls
      // back to normal cascade — the cluster host already takes leftPct=0.
      const splitsClusterHost =
        component.length > 1 && component.some((idx) => assignments[idx]! === 0);

      if (splitsClusterHost) {
        const subCol = component.indexOf(i);
        if (subCol === 0) {
          leftPct = 0;
          widthPct = 50;
        } else {
          leftPct = 50;
          widthPct = 50;
        }
      } else {
        // Cascade at the event's sweep-line column. leftPct grows with depth;
        // widthPct fills the remaining column width so the deepest guest still
        // stretches to the right edge.
        leftPct = Math.min(cascadeDepth * CASCADE_OFFSET_PCT, CASCADE_MAX_LEFT_PCT);
        widthPct = 100 - leftPct;
      }

      // Clipping invariant: no block may render past the right edge of its
      // day column. The cluster math should already respect this, but cap
      // defensively so any future edit can't bleed across the column line.
      if (leftPct < 0) leftPct = 0;
      if (leftPct > 100) leftPct = 100;
      if (widthPct < 0) widthPct = 0;
      if (leftPct + widthPct > 100) widthPct = 100 - leftPct;

      blocks.push({
        cascadeDepth,
        endDate: raw.endDate,
        height: raw.height,
        isCompact: raw.isCompact,
        leftPct,
        page: raw.page,
        startDate: raw.startDate,
        top: raw.top,
        widthPct,
        ...(raw.isContinuationAfter ? { isContinuationAfter: true as const } : {}),
        ...(raw.isContinuationBefore ? { isContinuationBefore: true as const } : {}),
      });
    }
  }

  // Emit in leftPct order so deeper-cascade events appear later in the DOM and
  // paint on top of their hosts.
  blocks.sort((a, b) => a.leftPct - b.leftPct || a.top - b.top);

  return blocks;
}

// ─── Text-collision / cluster / column helpers (file-local) ────────────────

/**
 * Connected components of "events whose tops are within CASCADE_MIN_TOP_GAP_PX
 * of each other AND both render with stacked title+time layout." Each event
 * maps to the cluster-indices of its component (including itself), sorted by
 * visual position. Components of size 1 mean "cascade is safe"; size >= 2
 * means "split into host 50% + right-half cascade."
 *
 * Compact (chip) events are excluded from collision detection: their single
 * line of text doesn't clash with a host's title/time row, so they should
 * just cascade like any other nested event. This keeps a 2h block with three
 * point reminders inside it from collapsing every chip into a tiny sub-column
 * — the chips render almost-full-width within their host instead.
 */
function findTextCollisionComponents(cluster: RawBlock[]): number[][] {
  const adj: number[][] = cluster.map(() => []);
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const a = cluster[i]!;
      const b = cluster[j]!;
      const gap = Math.abs(a.top - b.top);
      // Two non-compact events conflict if either's header would land in the
      // other's title/time row. A chip vs anything else conflicts only when
      // the chip lands in the other's header area. Two chips conflict only at
      // near-identical times — they're short enough that 30 min apart already
      // gives them their own visual row.
      const threshold = a.isCompact && b.isCompact ? CHIP_COLLISION_GAP_PX : CASCADE_MIN_TOP_GAP_PX;
      if (gap < threshold) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }

  const compIdOf = new Array<number>(cluster.length).fill(-1);
  const componentMembers: number[][] = [];
  for (let i = 0; i < cluster.length; i++) {
    if (compIdOf[i] !== -1) continue;
    const id = componentMembers.length;
    const stack = [i];
    const members: number[] = [];
    compIdOf[i] = id;
    while (stack.length > 0) {
      const v = stack.pop()!;
      members.push(v);
      for (const u of adj[v]!) {
        if (compIdOf[u] === -1) {
          compIdOf[u] = id;
          stack.push(u);
        }
      }
    }
    members.sort(
      (a, b) =>
        cluster[a]!.top - cluster[b]!.top ||
        cluster[a]!.startDate.getTime() - cluster[b]!.startDate.getTime() ||
        cluster[a]!.page.id.localeCompare(cluster[b]!.page.id)
    );
    componentMembers.push(members);
  }

  return cluster.map((_, i) => componentMembers[compIdOf[i]!]!);
}

/**
 * Group raws into transitively-connected overlap clusters. Requires the input
 * to be sorted by `top`. Two raws belong to the same cluster iff their visual
 * time ranges form a connected component under the overlap relation (so
 * A-overlaps-B and B-overlaps-C puts A, B, C in one cluster even if A and C
 * don't overlap each other).
 */
function groupIntoClusters(raws: RawBlock[]): RawBlock[][] {
  const clusters: RawBlock[][] = [];
  let current: RawBlock[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;

  for (const raw of raws) {
    const start = raw.visualStart.getTime();
    const end = raw.overlapEnd.getTime();
    if (start >= currentEnd && current.length > 0) {
      clusters.push(current);
      current = [];
      currentEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(raw);
    if (end > currentEnd) currentEnd = end;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Greedy sweep-line column assignment within a single cluster. Returns an
 * array parallel to `cluster` holding the column index assigned to each raw.
 *
 * Cascade-aware fallback: when col N is freed but col N+1 is still alive,
 * we DON'T fall back to col N. Cascade renders col 0 at full width
 * (`widthPct = 100 - leftPct`), so reusing a low column under an alive
 * higher one would paint the new event behind the higher cascade and
 * render it as a thin sliver on the left. Always allocate a new column to
 * the right of every still-alive column so the new event paints on top.
 */
function assignColumns(cluster: RawBlock[]): number[] {
  const columnOverlapEnds: number[] = [];
  const assignments: number[] = new Array<number>(cluster.length);

  for (let i = 0; i < cluster.length; i++) {
    const raw = cluster[i]!;
    const startMs = raw.visualStart.getTime();
    // Walk from highest column down. Reuse a free col only if every column
    // above it is also free for this event — otherwise the new event would
    // be hidden by an alive cascade above.
    let assigned = -1;
    for (let col = columnOverlapEnds.length - 1; col >= 0; col--) {
      if (columnOverlapEnds[col]! > startMs) break; // alive — block fallback
      assigned = col;
    }
    if (assigned === -1) {
      assigned = columnOverlapEnds.length;
      columnOverlapEnds.push(raw.overlapEnd.getTime());
    } else {
      columnOverlapEnds[assigned] = raw.overlapEnd.getTime();
    }
    assignments[i] = assigned;
  }
  return assignments;
}

// ─── Raw block construction (file-local) ────────────────────────────────────

/** Intermediate representation used by the layout pass — not exported. */
interface RawBlock {
  endDate: Date;
  height: number;
  isContinuationAfter: boolean;
  isContinuationBefore: boolean;
  isCompact: boolean;
  /** Visual end (may differ from endDate for compact blocks) — used for overlap math. */
  overlapEnd: Date;
  /** Visual start clamped to the day's grid boundary. */
  visualStart: Date;
  page: PageSummary;
  startDate: Date;
  top: number;
}

function buildRawBlock(
  page: PageSummary,
  dayStart: Date,
  dayEnd: Date,
  metrics: CalendarMetrics
): RawBlock {
  const realStart = parseISO(page.scheduledStart!);
  const hasExplicitEnd = !!page.scheduledEnd;
  const realEnd = hasExplicitEnd ? parseISO(page.scheduledEnd!) : realStart;

  const durationMinutes = hasExplicitEnd ? (realEnd.getTime() - realStart.getTime()) / 60_000 : 0;

  const isContinuationBefore = realStart < dayStart;
  const isContinuationAfter = hasExplicitEnd && durationMinutes > 0 && realEnd >= dayEnd;

  const visualStart = isContinuationBefore ? dayStart : realStart;
  const visualEnd = isContinuationAfter ? dayEnd : realEnd;

  const top = timeToY(visualStart, metrics.hourHeight);
  const visualDurationMin = Math.max(
    MIN_TIMED_MINUTES,
    Math.ceil(Math.max(durationMinutes, 0) / MIN_TIMED_MINUTES) * MIN_TIMED_MINUTES
  );
  const heightFromDuration = (visualDurationMin / 60) * metrics.hourHeight;
  // Raw 24h pixel height — `top` is computed in this same coord system via
  // `timeToY`. `metrics.gridHeight` is the collapse-remapped total (smaller
  // than raw 24h when bands are collapsed); using it here would clamp end-of-
  // day events to a y above their `top` and squash them to the 4px floor.
  // `remapBlocksForCollapse` projects raw → remapped coords downstream.
  const rawGridHeight = metrics.hourHeight * VISIBLE_HOURS;
  let endY: number;
  if (isContinuationAfter) {
    endY = rawGridHeight;
  } else if (isContinuationBefore) {
    endY = timeToY(visualEnd, metrics.hourHeight);
  } else {
    endY = Math.min(rawGridHeight, top + heightFromDuration);
  }
  const height = Math.max(endY - top, 4);
  const isCompact = !isContinuationAfter && height < CHIP_STACKED_THRESHOLD;
  const overlapEnd = isContinuationAfter
    ? visualEnd
    : new Date(visualStart.getTime() + visualDurationMin * 60_000);

  return {
    endDate: realEnd,
    height,
    isCompact,
    isContinuationAfter,
    isContinuationBefore,
    overlapEnd,
    page,
    startDate: realStart,
    top,
    visualStart,
  };
}

// ─── Gesture helpers ────────────────────────────────────────────────────────

/**
 * Wires up a mousedown→mousemove drag-threshold detector. Fires `onCrossed`
 * the first time the cursor moves more than `DRAG_THRESHOLD` px from its
 * starting coordinates and then disconnects — downstream drag state is the
 * caller's responsibility. A release before the threshold (a "click", not a
 * drag) just tears the listeners down.
 *
 * `bodyCursor` is optional: when set, the class is added to <html> on
 * mousedown for instant feedback and removed on a click-release. After the
 * threshold is crossed, the caller (usually the drag handler on the parent
 * grid) owns class management — the helper leaves it set.
 */
export function beginDragThreshold(
  startX: number,
  startY: number,
  opts: {
    onCrossed: () => void;
    bodyCursor?: "dragging-grab" | "dragging-resize";
  }
): void {
  if (opts.bodyCursor) {
    document.documentElement.classList.add(opts.bodyCursor);
  }
  let crossed = false;

  function onMove(ev: MouseEvent) {
    if (
      Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
    ) {
      crossed = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      opts.onCrossed();
    }
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!crossed && opts.bodyCursor) {
      document.documentElement.classList.remove(opts.bodyCursor);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
