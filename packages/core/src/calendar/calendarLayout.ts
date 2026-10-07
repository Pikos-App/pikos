// Timed-block positioning + nested-cascade collision logic. Produces the
// CalendarBlock[] consumed by DayColumn / PageBlock.
//
// The overflow ("+N more" pill) collapse and the collapsed-band remap also
// live here — they're tightly coupled to CalendarBlock and would not gain
// readability by sitting in their own file.

import { addDays, parseISO, startOfDay } from "date-fns";

import type { PageSummary } from "../types";
import { formatDateOnly, getLocalTimezone } from "../utils/dates";
import { resolveSyncedInstant } from "../utils/syncedTime";
import { isAllDayPage } from "./allDayLayout";
import {
  CASCADE_OFFSET_PCT,
  COMPACT_BLOCK_HEIGHT,
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
  fallsShortOf,
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
 * Data an overflow pill needs — separate from CalendarBlock so the pill
 * isn't a synthetic page. A pill replaces the slot of its cluster's rightmost
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
  /** Too narrow for "+N more", so the pill reads "+N". */
  countOnly: boolean;
}

// ─── Overflow pill ──────────────────────────────────────────────────────────

/** Floor on the pill's chip height — below this, "+N more" wraps or clips. */
const MIN_PILL_HEIGHT_PX = 14;

/** Minimum pixel width for the pill at the default zoom — ensures "+N more"
 * stays legible even when the rightmost-cascaded slot is very narrow. */
const PILL_MIN_WIDTH_PX = 64;

/** Share of the column the pill may take, so it doesn't cover the event that
 * stays visible beside it. Where that leaves less than the label needs, the pill
 * drops the "more" rather than growing or clipping to "+3 mor". */
const PILL_MAX_WIDTH_PCT = 50;

/**
 * Collapses blocks that would render narrower than OVERFLOW_MIN_WIDTH_PX into a
 * "+N more" pill per overlap cluster. Returns the surviving blocks plus the
 * pills. When `columnWidth <= 0` (no measurement yet) returns the input
 * unchanged so first paint isn't lossy.
 *
 * A cluster's first event never collapses, and each cluster gets its own pill at
 * its own rightmost collapsed slot. With one pill per day and no survivor, a
 * 50/50 split whose halves both fell under the width floor vanished entirely,
 * and its count joined a pill beside some other cluster hours away — a column
 * narrowing by a pixel or two, as it does when the calendar text grows and
 * widens the gutter, emptied whole mornings.
 *
 * The pill's width floor scales with the text, because its label does.
 */
export function collapseUnderWidth(
  blocks: CalendarBlock[],
  columnWidth: number,
  chipHeight: number = COMPACT_BLOCK_HEIGHT,
  zoom = 1
): { visible: CalendarBlock[]; pills: OverflowPill[] } {
  if (columnWidth <= 0) return { pills: [], visible: blocks };
  const collapsedIds = new Set<string>();
  const pills: OverflowPill[] = [];
  for (const cluster of groupByPixelOverlap(blocks)) {
    const first = cluster.reduce((best, b) =>
      b.leftPct < best.leftPct || (b.leftPct === best.leftPct && b.top < best.top) ? b : best
    );
    const collapsed = cluster.filter(
      (b) =>
        b !== first &&
        (b.cascadeDepth > MAX_VISIBLE_CASCADE_DEPTH ||
          (b.widthPct / 100) * columnWidth < OVERFLOW_MIN_WIDTH_PX)
    );
    if (collapsed.length === 0) continue;
    for (const b of collapsed) collapsedIds.add(b.page.id);
    pills.push(pillFor(collapsed, columnWidth, chipHeight, zoom));
  }
  if (pills.length === 0) return { pills, visible: blocks };
  return { pills, visible: blocks.filter((b) => !collapsedIds.has(b.page.id)) };
}

/** Blocks whose pixel spans connect, the same relation the layout cascades by.
 *  Each cluster keeps the input order, which is the order a pill lists them in. */
function groupByPixelOverlap(blocks: CalendarBlock[]): CalendarBlock[][] {
  const clusterOf = new Map<CalendarBlock, number>();
  let cluster = -1;
  let clusterEnd = Number.NEGATIVE_INFINITY;
  for (const b of [...blocks].sort((x, y) => x.top - y.top)) {
    if (b.top >= clusterEnd) cluster++;
    clusterEnd = Math.max(clusterEnd, b.top + b.height);
    clusterOf.set(b, cluster);
  }
  const clusters: CalendarBlock[][] = Array.from({ length: cluster + 1 }, () => []);
  for (const b of blocks) clusters[clusterOf.get(b)!]!.push(b);
  return clusters;
}

function pillFor(
  collapsed: CalendarBlock[],
  columnWidth: number,
  chipHeight: number,
  zoom: number
): OverflowPill {
  // Horizontal position: take the slot of the rightmost-cascaded collapsed
  // event. If that slot is too narrow to render "+N more" legibly, expand
  // the pill leftward to a minimum readable width.
  const slotHost = collapsed.reduce(
    (best, b) => (b.leftPct > best.leftPct ? b : best),
    collapsed[0]!
  );
  const labelPx = PILL_MIN_WIDTH_PX * zoom;
  const minPillPct = Math.min(PILL_MAX_WIDTH_PCT, (labelPx / columnWidth) * 100);
  const widthPct = Math.max(slotHost.widthPct, minPillPct);
  const leftPct = Math.min(slotHost.leftPct, 100 - widthPct);

  // Pill is chip-shaped (a "+N more" indicator, not a full block replacement).
  // Height tracks the current density's quarter-hour slot so it scales with
  // hourHeight — a hair smaller in compact, a hair taller in spacious — but
  // never falls below the legible-text floor.
  const height = Math.max(chipHeight, MIN_PILL_HEIGHT_PX);

  return {
    countOnly: fallsShortOf((widthPct / 100) * columnWidth, labelPx),
    height,
    leftPct,
    pageIds: collapsed.map((b) => b.page.id),
    top: slotHost.top,
    widthPct,
  };
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
  geometry: CollapseGeometry,
  minHeight = 4
): RemappedBlocks {
  const { config, hourHeight } = geometry;
  const visible: CalendarBlock[] = [];
  const topCollapsedPageIds: string[] = [];
  const bottomCollapsedPageIds: string[] = [];

  for (const b of blocks) {
    const startHour = b.top / hourHeight;
    const endHour = (b.top + b.height) / hourHeight;

    if (config.topCollapsed && !fallsShortOf(config.topHour, endHour)) {
      topCollapsedPageIds.push(b.page.id);
      continue;
    }
    if (config.bottomCollapsed && !fallsShortOf(startHour, config.bottomHour)) {
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
    const straddlesTopBand = config.topCollapsed && fallsShortOf(startHour, config.topHour);
    const straddlesBottomBand = config.bottomCollapsed && fallsShortOf(config.bottomHour, endHour);
    let newTop = straddlesTopBand
      ? geometry.topBandHeight - collapsedBandInnerOffset(geometry.topBandHeight) + 1
      : rawTop;
    let newBottom = straddlesBottomBand
      ? geometry.middleEnd + collapsedBandInnerOffset(geometry.bottomBandHeight) - 1
      : rawBottom;
    // Squeezed against a band, a block grows away from it rather than into the pill.
    if (newBottom - newTop < minHeight) {
      if (straddlesBottomBand && !straddlesTopBand) newTop = newBottom - minHeight;
      else newBottom = newTop + minHeight;
    }
    visible.push({
      ...b,
      height: newBottom - newTop,
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
/**
 * Pages with a timed schedule that overlaps `[rangeStart, rangeEnd)`. Multi-day timed events are
 * NOT promoted to the all-day row: they render as one segment per day they touch (continuation
 * flags on each segment drive the radius and label rules in PageBlock). A week view filters with
 * this once and hands each day the result, rather than every day walking the whole workspace.
 */
/** Whether a block from `start` to `end` falls in `[from, to)`. A page with no end has no length
 *  and belongs where its start falls: as an overlap test it would land on no day at exactly
 *  midnight, starting no earlier than the day before ends and ending no later than its day starts. */
function inSpan(start: Date, end: Date, from: Date, to: Date): boolean {
  return end > start ? start < to && end > from : start >= from && start < to;
}

export function timedPagesInRange(
  pages: PageSummary[],
  rangeStart: Date,
  rangeEnd: Date
): PageSummary[] {
  checkZone();
  return pages.filter((page) => {
    if (!page.scheduledStart) return false;
    if (isAllDayPage(page.scheduledStart)) return false;
    try {
      // Use the same instant resolution as positioning so a synced event shifted
      // across midnight (e.g. 11pm PT → 2am ET) is filtered onto the day it renders.
      const start = resolveBlockInstant(page, page.scheduledStart);
      const end = page.scheduledEnd ? resolveBlockInstant(page, page.scheduledEnd) : start;
      return inSpan(start, end, rangeStart, rangeEnd);
    } catch {
      return false;
    }
  });
}

/** `timedPagesInRange` for each of `days` in one pass: each page's instants resolve once, not
 *  once per day. */
export function timedPagesByDay(pages: PageSummary[], days: Date[]): PageSummary[][] {
  checkZone();
  const bounds = days.map((day) => {
    const start = startOfDay(day);
    return { end: addDays(start, 1), start };
  });
  const byDay: PageSummary[][] = days.map(() => []);
  const first = bounds[0];
  const last = bounds[bounds.length - 1];
  if (!first || !last) return byDay;
  // Dates compare as strings, so a page dated well clear of the days skips the parse. A day of
  // slack each side covers a synced event whose zone moves it across midnight.
  const before = formatDateOnly(addDays(first.start, -1));
  const after = formatDateOnly(addDays(last.end, 1));
  for (const page of pages) {
    if (!page.scheduledStart || isAllDayPage(page.scheduledStart)) continue;
    if (page.scheduledStart.slice(0, 10) >= after) continue;
    if ((page.scheduledEnd ?? page.scheduledStart).slice(0, 10) < before) continue;
    let start: Date;
    let end: Date;
    try {
      start = resolveBlockInstant(page, page.scheduledStart);
      end = page.scheduledEnd ? resolveBlockInstant(page, page.scheduledEnd) : start;
    } catch {
      continue;
    }
    bounds.forEach((day, i) => {
      if (inSpan(start, end, day.start, day.end)) byDay[i]!.push(page);
    });
  }
  return byDay;
}

/** Resolve the instants of `pages` ahead of a layout that will need them, as idle work before a
 *  step to a neighbouring week. */
export function warmBlockInstants(pages: PageSummary[]): void {
  checkZone();
  for (const page of pages) {
    if (!page.scheduledStart || isAllDayPage(page.scheduledStart)) continue;
    try {
      resolveBlockInstant(page, page.scheduledStart);
      if (page.scheduledEnd) resolveBlockInstant(page, page.scheduledEnd);
    } catch {
      // Layout skips a page it can't place; so does this.
    }
  }
}

export function buildDayBlocks(
  pages: PageSummary[],
  day: Date,
  metrics: CalendarMetrics = DEFAULT_METRICS
): CalendarBlock[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  const overlapping = timedPagesInRange(pages, dayStart, dayEnd);

  if (overlapping.length === 0) return [];

  const raws: RawBlock[] = overlapping.map((page) =>
    buildRawBlock(page, dayStart, dayEnd, metrics)
  );

  raws.sort(compareRawOrder);

  const clusters = groupIntoClusters(raws);
  const blocks: CalendarBlock[] = [];

  for (const cluster of clusters) {
    const assignments = assignColumns(cluster);
    const components = findTextCollisionComponents(cluster, metrics.zoom);

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
function findTextCollisionComponents(cluster: RawBlock[], zoom: number): number[][] {
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
      if (fallsShortOf(gap, threshold * zoom)) {
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
    members.sort((a, b) => compareRawOrder(cluster[a]!, cluster[b]!));
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

/**
 * The one visual order for blocks sharing a slot: top, then start, then title,
 * then id. Every layout decision that a tie can flip — cascade depth and the
 * close-top 50/50 split — reads it, so the two can't disagree.
 *
 * Title outranks id because completing an occurrence swaps the page for a done
 * clone carrying a fresh uuid. Under an id-first tiebreak that re-decides which
 * of two same-start events hosts the slot, so the pair visibly swaps sides on a
 * tick. Id stays as the last resort: same time, same title, still deterministic.
 */
function compareRawOrder(a: RawBlock, b: RawBlock): number {
  return (
    a.top - b.top ||
    a.startDate.getTime() - b.startDate.getTime() ||
    a.page.title.localeCompare(b.page.title) ||
    a.page.id.localeCompare(b.page.id)
  );
}

/**
 * Parse a timed block's wall-clock string to its grid Date. Native pages float
 * (parsed as-is). A synced (locked) event is absolute: resolve its source-zone
 * wall-clock to the instant, which `timeToY` then reads in the viewer's zone — so
 * a 3pm PT event positions at 6pm for an ET viewer. Detached pages unlock and
 * float again, so the gate is `scheduleLocked`, not mere sync provenance.
 */
/**
 * Instants by page object. A page's row is replaced when it changes, never edited, so what it
 * parses to holds for the object's life and a week step parses only pages it hasn't drawn. The
 * mapping from wall-clock to instant depends on the local zone, so a zone change drops them all.
 */
let instants = new WeakMap<PageSummary, Map<string, Date>>();
let instantsZone: string | null = null;

/** Called once per layout pass: reading the zone builds a formatter, too slow to do per block. */
function checkZone(): void {
  const zone = getLocalTimezone();
  if (zone === instantsZone) return;
  instants = new WeakMap();
  instantsZone = zone;
}

function resolveBlockInstant(page: PageSummary, iso: string): Date {
  let held = instants.get(page);
  const hit = held?.get(iso);
  if (hit) return hit;
  const at =
    page.scheduleLocked && page.timezone ? resolveSyncedInstant(iso, page.timezone) : parseISO(iso);
  if (!held) {
    held = new Map();
    instants.set(page, held);
  }
  held.set(iso, at);
  return at;
}

function buildRawBlock(
  page: PageSummary,
  dayStart: Date,
  dayEnd: Date,
  metrics: CalendarMetrics
): RawBlock {
  const realStart = resolveBlockInstant(page, page.scheduledStart!);
  const hasExplicitEnd = !!page.scheduledEnd;
  const realEnd = hasExplicitEnd ? resolveBlockInstant(page, page.scheduledEnd!) : realStart;

  const durationMinutes = hasExplicitEnd ? (realEnd.getTime() - realStart.getTime()) / 60_000 : 0;

  const isContinuationBefore = realStart < dayStart;
  const isContinuationAfter = hasExplicitEnd && durationMinutes > 0 && realEnd >= dayEnd;

  const visualStart = isContinuationBefore ? dayStart : realStart;
  const visualEnd = isContinuationAfter ? dayEnd : realEnd;

  const startY = timeToY(visualStart, metrics.hourHeight);
  const visualDurationMin = Math.max(
    MIN_TIMED_MINUTES,
    Math.ceil(Math.max(durationMinutes, 0) / MIN_TIMED_MINUTES) * MIN_TIMED_MINUTES
  );
  const heightFromDuration = (visualDurationMin / 60) * metrics.hourHeight;
  // Raw 24h pixel height — `startY` is computed in this same coord system via
  // `timeToY`. `metrics.gridHeight` is the collapse-remapped total (smaller
  // than raw 24h when bands are collapsed); using it here would clamp end-of-
  // day events to a y above their start and squash them to the height floor.
  // `remapBlocksForCollapse` projects raw → remapped coords downstream.
  const rawGridHeight = metrics.hourHeight * VISIBLE_HOURS;
  let endY: number;
  if (isContinuationAfter) {
    endY = rawGridHeight;
  } else if (isContinuationBefore) {
    endY = timeToY(visualEnd, metrics.hourHeight);
  } else {
    endY = Math.min(rawGridHeight, startY + heightFromDuration);
  }
  const height = Math.max(endY - startY, metrics.compactBlockHeight);
  // A floored block starting in the day's last minutes rises to stay on the grid.
  const top = Math.min(startY, rawGridHeight - height);
  const isCompact = !isContinuationAfter && fallsShortOf(height, metrics.stackedBlockMinHeight);
  // Overlap is decided in time, so a floored block claims the minutes its height
  // covers — or a 9:00 reminder drawn 24 minutes tall would sit on a 9:15 event.
  const overlapMin = Math.max(visualDurationMin, (height / metrics.hourHeight) * 60);
  const overlapEnd = isContinuationAfter
    ? visualEnd
    : new Date(visualStart.getTime() + overlapMin * 60_000);

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
