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
  addClockMinutes,
  type CalendarMetrics,
  clockMinutesBetween,
  collapsedBandInnerOffset,
  type CollapseGeometry,
  DEFAULT_METRICS,
  fallsShortOf,
  mapHourToY,
  timeToY,
} from "./calendarGeometry";

export interface CalendarBlock {
  page: PageSummary;
  startDate: Date;
  endDate: Date;
  /** Pixels from the grid top. */
  top: number;
  height: number;
  /** True when duration < MIN_TIMED_MINUTES or there is no scheduledEnd. */
  isCompact: boolean;
  /** Percent of the day column's width (0..100). */
  leftPct: number;
  widthPct: number;
  /** Cascade column index (0 = host, 1 = first cascade, ...). Beyond `MAX_VISIBLE_CASCADE_DEPTH`
   * a block folds into the "+N more" pill whatever its width. */
  cascadeDepth: number;
  /** The event started before this day. */
  isContinuationBefore?: boolean;
  /** The event extends past the end of this day's grid. */
  isContinuationAfter?: boolean;
  /** Some of the block's time falls inside the compressed top band; drives a square top edge. */
  straddlesTopBand?: boolean;
  /** Same for the bottom band. */
  straddlesBottomBand?: boolean;
}

/**
 * What an overflow pill needs, kept apart from CalendarBlock so the pill isn't a synthetic
 * page. It takes the slot of its cluster's rightmost collapsed event, widened to a floor so
 * "+N more" stays legible on narrow columns, and renders as one chip at the slot's top.
 */
export interface OverflowPill {
  /** Top of the topmost collapsed event, in pixels from the grid top. */
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
  pageIds: string[];
  /** Too narrow for "+N more", so the pill reads "+N". */
  countOnly: boolean;
}

/** Below this, "+N more" wraps or clips. */
const MIN_PILL_HEIGHT_PX = 14;

/** Pill width floor at the default zoom, so "+N more" stays legible in a very narrow slot. */
const PILL_MIN_WIDTH_PX = 64;

/** Share of the column the pill may take, so it doesn't cover the event beside it. Where that
 * is less than the label needs, the pill drops the "more" rather than clipping to "+3 mor". */
const PILL_MAX_WIDTH_PCT = 50;

/**
 * Collapses blocks that would render narrower than OVERFLOW_MIN_WIDTH_PX, or deeper than
 * MAX_VISIBLE_CASCADE_DEPTH, into one "+N more" pill per overlap cluster. Returns the surviving
 * blocks and the pills; with `columnWidth <= 0` (not measured yet) the input comes back
 * unchanged.
 *
 * A cluster's first event never collapses, and each cluster gets its own pill. One pill per day
 * with no survivor let a 50/50 split whose halves both fell under the width floor vanish into a
 * pill beside some other cluster hours away, so a column narrowing by a pixel emptied whole
 * mornings.
 *
 * A first event left alone beside its pill takes the column back, unless the pill would sit on its
 * title. Kept to its half of a split, at a large text size it had room for its checkbox only.
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
  const minWidthPx = OVERFLOW_MIN_WIDTH_PX * zoom;
  const collapsedIds = new Set<string>();
  const widened = new Map<CalendarBlock, CalendarBlock>();
  const pills: OverflowPill[] = [];
  for (const cluster of groupByPixelOverlap(blocks)) {
    const first = cluster.reduce((best, b) =>
      b.leftPct < best.leftPct || (b.leftPct === best.leftPct && b.top < best.top) ? b : best
    );
    const collapsed = cluster.filter(
      (b) =>
        b !== first &&
        (b.cascadeDepth > MAX_VISIBLE_CASCADE_DEPTH ||
          (b.widthPct / 100) * columnWidth < minWidthPx)
    );
    if (collapsed.length === 0) continue;
    let pill = pillFor(collapsed, columnWidth, chipHeight, zoom);
    let covered = coveredTitles(cluster, first, collapsed, pill);
    while (covered.length > 0) {
      collapsed.push(...covered);
      pill = pillFor(sortedLike(cluster, collapsed), columnWidth, chipHeight, zoom);
      covered = coveredTitles(cluster, first, collapsed, pill);
    }
    for (const b of collapsed) collapsedIds.add(b.page.id);
    pills.push(pill);

    const standsAlone = collapsed.length === cluster.length - 1;
    const pillClearsTitle = Math.abs(first.top - pill.top) >= pill.height;
    if (standsAlone && pillClearsTitle) {
      widened.set(first, { ...first, widthPct: 100 - first.leftPct });
    }
  }
  if (pills.length === 0) return { pills, visible: blocks };
  return {
    pills,
    visible: blocks.filter((b) => !collapsedIds.has(b.page.id)).map((b) => widened.get(b) ?? b),
  };
}

/** Blocks whose pixel spans connect, the relation the layout cascades by. Each cluster keeps the
 *  input order, which is the order a pill lists them in. */
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

/** Blocks still showing whose title row the pill would sit on. Three pages at one time share the
 *  right half between the second and third, so the third's pill landed on the second and read
 *  "+1 more" over a page nobody could see. */
function coveredTitles(
  cluster: CalendarBlock[],
  first: CalendarBlock,
  collapsed: CalendarBlock[],
  pill: OverflowPill
): CalendarBlock[] {
  return cluster.filter((b) => {
    if (b === first || collapsed.includes(b)) return false;
    const sharesColumn =
      b.leftPct < pill.leftPct + pill.widthPct && pill.leftPct < b.leftPct + b.widthPct;
    const titleUnderPill = Math.abs(b.top - pill.top) < pill.height;
    return sharesColumn && titleUnderPill;
  });
}

/** `blocks` in the order `cluster` holds them, which is the order a pill lists them in. */
function sortedLike(cluster: CalendarBlock[], blocks: CalendarBlock[]): CalendarBlock[] {
  return cluster.filter((b) => blocks.includes(b));
}

function pillFor(
  collapsed: CalendarBlock[],
  columnWidth: number,
  chipHeight: number,
  zoom: number
): OverflowPill {
  const slotHost = collapsed.reduce(
    (best, b) => (b.leftPct > best.leftPct ? b : best),
    collapsed[0]!
  );
  const labelPx = PILL_MIN_WIDTH_PX * zoom;
  const minPillPct = Math.min(PILL_MAX_WIDTH_PCT, (labelPx / columnWidth) * 100);
  const widthPct = Math.max(slotHost.widthPct, minPillPct);
  const leftPct = Math.min(slotHost.leftPct, 100 - widthPct);

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

/**
 * A day's blocks remapped against a collapse geometry. Blocks fully inside a collapsed band
 * leave `visible` and their ids go to that band's list, for one `+N more` chip. Blocks
 * straddling a boundary stay, with `top` and `height` rewritten through the geometry.
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

    // A straddling block starts just past the band's pill, so all of them emerge at the same y
    // whatever their start within the band, yet still reach into the collapsed space. Otherwise
    // they would cascade by start minute (meaningless on a compressed band) or sit flush at the
    // boundary with no cue that they extend into it.
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

/** Deeper events all land at this indent and keep stacking in DOM order, so each still shows a
 * left edge from the host underneath. */
const CASCADE_MAX_LEFT_PCT = 60;

/** Overlapping events with tops closer than this (px, about a two-line title and time row) are
 * split into equal sub-columns, because cascading them would put both titles in the same band. */
const CASCADE_MIN_TOP_GAP_PX = 40;

/** Tighter threshold for chip pairs: a chip's single line doesn't reach into a host's title and
 * time row, so 30 minutes apart already separates them. */
const CHIP_COLLISION_GAP_PX = 20;

/** Whether a block from `start` to `end` falls in `[from, to)`. A page with no end has no length
 *  and belongs where its start falls; as an overlap test it would land on no day at exactly
 *  midnight. */
function inSpan(start: Date, end: Date, from: Date, to: Date): boolean {
  return end > start ? start < to && end > from : start >= from && start < to;
}

/**
 * Pages with a timed schedule overlapping `[rangeStart, rangeEnd)`. Multi-day timed events stay
 * out of the all-day row and render as one segment per day they touch. A week view filters once
 * and hands each day the result, rather than every day walking the whole workspace.
 */
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
      // Same instant resolution as positioning, so a synced event shifted across midnight
      // (11pm PT to 2am ET) is filtered onto the day it renders.
      const start = resolveBlockInstant(page, page.scheduledStart);
      const end = page.scheduledEnd ? resolveBlockInstant(page, page.scheduledEnd) : start;
      return inSpan(start, end, rangeStart, rangeEnd);
    } catch {
      return false;
    }
  });
}

/** `timedPagesInRange` for each of `days` in one pass, resolving each page's instants once. */
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

/** Resolves the instants of `pages` ahead of a layout that will need them, such as idle work
 *  before a step to a neighbouring week. */
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

/**
 * Positioned blocks for `day`; all-day events are excluded (see `buildAllDayItems`).
 *
 * Overlaps nest as a cascade: each deeper overlap indents right by CASCADE_OFFSET_PCT and paints
 * over its host, so the host's title stays visible. Events whose tops are within
 * CASCADE_MIN_TOP_GAP_PX can't cascade legibly, so they split into equal side-by-side columns.
 *
 * An event spanning midnight appears on each day it touches, with `isContinuationBefore` and
 * `isContinuationAfter` marking the cut edges.
 */
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

      // Depth is always the cluster's sweep-line column: a close-top pair only changes the layout
      // (50/50 split), not the depth. Promoting it would keep a pair at cluster columns 2 and 3
      // visible past the MAX_VISIBLE_CASCADE_DEPTH cap that applies to the rest of the cluster.
      const cascadeDepth = assignments[i]!;

      // The 50/50 split applies only when the pair owns the cluster host (depth 0). A mid-cluster
      // pair would paint at leftPct 0 and collide with the real host, so it cascades normally.
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
        leftPct = Math.min(cascadeDepth * CASCADE_OFFSET_PCT, CASCADE_MAX_LEFT_PCT);
        widthPct = 100 - leftPct;
      }

      // Defensive: no block may render past its day column's edge.
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

  // Deeper cascades come later in the DOM so they paint over their hosts.
  blocks.sort((a, b) => a.leftPct - b.leftPct || a.top - b.top);

  return blocks;
}

/**
 * Connected components of events whose tops are close enough for their headers to collide. Each
 * event maps to its component's cluster indices (itself included), sorted by visual position. A
 * component of one cascades; two or more split into a 50% host and a right-half cascade.
 *
 * A chip clashes with another event only when it lands in that event's header area, and two
 * chips only at near-identical times. This keeps a 2h block with three point reminders inside
 * it from squeezing every chip into a tiny sub-column.
 */
function findTextCollisionComponents(cluster: RawBlock[], zoom: number): number[][] {
  const adj: number[][] = cluster.map(() => []);
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const a = cluster[i]!;
      const b = cluster[j]!;
      const gap = Math.abs(a.top - b.top);
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
 * Groups raws into transitively connected overlap clusters, so A overlapping B and B overlapping
 * C puts all three together even if A and C don't overlap. The input must be sorted by `top`.
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
 * Greedy sweep-line column assignment within one cluster; the result is parallel to `cluster`.
 *
 * A freed column N is not reused while column N+1 is alive. Cascade draws col 0 at full width,
 * so the new event would paint behind the higher cascade as a thin sliver on the left. It takes
 * a column right of every live one so it paints on top.
 */
function assignColumns(cluster: RawBlock[]): number[] {
  const columnOverlapEnds: number[] = [];
  const assignments: number[] = new Array<number>(cluster.length);

  for (let i = 0; i < cluster.length; i++) {
    const raw = cluster[i]!;
    const startMs = raw.visualStart.getTime();
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

interface RawBlock {
  endDate: Date;
  height: number;
  isContinuationAfter: boolean;
  isContinuationBefore: boolean;
  isCompact: boolean;
  /** Visual end, which can differ from endDate for compact blocks; overlap is decided on it. */
  overlapEnd: Date;
  /** Clamped to the day's grid boundary. */
  visualStart: Date;
  page: PageSummary;
  startDate: Date;
  top: number;
}

/**
 * The one visual order for blocks sharing a slot: top, start, title, then id. Cascade depth and
 * the close-top split both read it, so they can't disagree on a tie.
 *
 * Title outranks id because completing an occurrence swaps the page for a done clone with a
 * fresh uuid, and an id-first tiebreak would re-decide which of two same-start events hosts the
 * slot, visibly swapping the pair.
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

/**
 * A timed block's wall-clock string as its grid Date. Native pages float and parse as-is. A
 * synced (locked) event is absolute: its source-zone wall clock resolves to an instant that
 * `timeToY` reads in the viewer's zone, so a 3pm PT event sits at 6pm for an ET viewer. Detached
 * pages float again, so the gate is `scheduleLocked`, not sync provenance.
 */
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

  const durationMinutes = hasExplicitEnd ? clockMinutesBetween(realStart, realEnd) : 0;

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
  // Not `metrics.gridHeight`: that is the collapse-remapped total, which is smaller when bands
  // are collapsed and would clamp end-of-day events above their start, squashing them to the
  // height floor. `startY` is in these raw coordinates; `remapBlocksForCollapse` projects later.
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
  // Overlap is decided in time, so a floored block claims the minutes its height covers, or a
  // 9:00 reminder drawn 24 minutes tall would sit on a 9:15 event.
  const overlapMin = Math.max(visualDurationMin, (height / metrics.hourHeight) * 60);
  const overlapEnd = isContinuationAfter ? visualEnd : addClockMinutes(visualStart, overlapMin);

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
