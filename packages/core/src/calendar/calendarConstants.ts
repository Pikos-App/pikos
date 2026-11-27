// Everything here is dependency-free so other modules in this folder can
// import freely without cycles.

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
export const CLICK_DELAY = 150;

/** Pixel movement threshold before a mousedown is treated as a drag gesture. */
export const DRAG_THRESHOLD = 4;

export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const VISIBLE_HOURS = 24;

export const HOUR_HEIGHT = 64;
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;

/** Height of a 15-minute block. Every timed event renders at a multiple of it. */
export const COMPACT_BLOCK_HEIGHT = HOUR_HEIGHT / 4;

/**
 * Below this height (px, at default zoom) a block is a single-line chip; above, a stacked
 * title+time block. Read through `CalendarMetrics.stackedBlockMinHeight`.
 */
export const CHIP_STACKED_THRESHOLD = 28;

/** Short event durations round up to this many minutes for visual height. */
export const MIN_TIMED_MINUTES = 15;

/** Tall enough for two stacked hour labels plus a chevron. */
export const COLLAPSED_BAND_HEIGHT = 40;

/** Drag limits for the collapse bounds. The middle region must keep at least one hour. */
export const MIN_TOP_HOUR = 0;
export const MAX_TOP_HOUR = 12;
export const MIN_BOTTOM_HOUR = 12;
export const MAX_BOTTOM_HOUR = 24;
export const MIN_VISIBLE_HOURS = 1;

export interface CalendarCollapseConfig {
  /** Upper bound of the top collapsible band (exclusive). 0..23. */
  topHour: number;
  /** Lower bound of the bottom collapsible band (inclusive). 1..24. */
  bottomHour: number;
  /** When true, hours [0, topHour) render as a fixed-height band. */
  topCollapsed: boolean;
  /** When true, hours [bottomHour, 24) render as a fixed-height band. */
  bottomCollapsed: boolean;
}

export const DEFAULT_COLLAPSE_CONFIG: CalendarCollapseConfig = {
  bottomCollapsed: true,
  bottomHour: 22,
  topCollapsed: true,
  topHour: 6,
};

/**
 * Accent (Tailwind blue-500) for a page with no folder colour. It goes through the same
 * `--event-color` rule as folder colours, so block fills stay opaque when blocks stack.
 */
export const DEFAULT_EVENT_COLOR = "rgb(59 130 246)" as const;

/** Height of a single all-day bar. The chip's own `h-[19px]` class must agree;
 * it lives in the desktop app (see `calendarColors.ts`) because Tailwind only
 * generates utilities it finds while scanning, and it does not scan this package. */
export const ALL_DAY_BAR_HEIGHT = 19;
const ALL_DAY_ROW_GAP = 2;
export const ALL_DAY_ROW_HEIGHT = ALL_DAY_BAR_HEIGHT + ALL_DAY_ROW_GAP;
export const ALL_DAY_TOP_PADDING = 4;

/** Below this rendered width (px) a block shows its title only: no time, checkbox on hover. */
export const COMPACT_MODE_WIDTH_PX = 100;

/**
 * Below this rendered width (px at calendar zoom 1, scaled by the zoom) a block shows its
 * checkbox alone. Past the checkbox there is room for less than two letters and an ellipsis,
 * so the browser cut the ellipsis as well and the title read as a broken "F." rather than a
 * shortened one. The popover and the block's accessible name still carry the title.
 */
export const TITLE_MIN_WIDTH_PX = 54;

/**
 * If any block would render below this rendered width (px at calendar zoom 1, scaled by the
 * zoom), the layout collapses the smallest blocks into a `+N more` pill at the cluster's
 * right edge instead of letting their titles truncate to a single letter. It must scale with
 * the zoom: unscaled, it fell under `TITLE_MIN_WIDTH_PX` once the text grew, and a block
 * between the two showed its checkbox alone.
 */
export const OVERFLOW_MIN_WIDTH_PX = 60;

/**
 * Cascade depth that stays visible: the host (depth 0) plus this many guests. Deeper blocks
 * fold into the "+N more" pill regardless of column width, so narrow and wide layouts show
 * the same thing.
 */
export const MAX_VISIBLE_CASCADE_DEPTH = 1;

/**
 * Horizontal indent (% of day-column width) per cascade depth step, so the host's title
 * stays visible. Tuned for 7-day columns: smaller and depth-3 events become unreadable,
 * larger and the host's title is squeezed at depth 1.
 */
export const CASCADE_OFFSET_PCT = 12;
