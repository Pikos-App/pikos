// Dependency-free so other modules in this folder can import it without cycles.

/** Delay (ms) to tell a single click (popover) from a double click (open editor). */
export const CLICK_DELAY = 150;

/** Pixel movement before a mousedown counts as a drag. */
export const DRAG_THRESHOLD = 4;

export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const VISIBLE_HOURS = 24;

/** The default density's metrics. */
export const HOUR_HEIGHT = 64;
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;

/** Height of a 15-minute block. Every timed event renders at a multiple of it, because
 * durations round up to the next 15-minute slot so short events stay readable. */
export const COMPACT_BLOCK_HEIGHT = HOUR_HEIGHT / 4;

/** Below this height (px) a block renders as a single-line chip, above it as a stacked
 * title and time. Measured at the default zoom; read through
 * `CalendarMetrics.stackedBlockMinHeight`. */
export const CHIP_STACKED_THRESHOLD = 28;

/** Slot size (minutes) short durations round up to. */
export const MIN_TIMED_MINUTES = 15;

/** Tall enough for two stacked hour labels and a chevron to stay legible. */
export const COLLAPSED_BAND_HEIGHT = 40;

/** Limits the user can drag the bounds to. Top stays at least an hour above bottom so the
 * middle region never disappears. */
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

/** Tailwind blue-500, for a page with no folder colour. It goes through the same
 * `--event-color` CSS rule as folder colours, so every block fill is an opaque `color-mix`
 * with the background and stacked blocks don't alpha-blend. */
export const DEFAULT_EVENT_COLOR = "rgb(59 130 246)" as const;

/** Height of an all-day bar. The chip's own `h-[19px]` class must agree; it lives in the
 * desktop app (`calendarColors.ts`) because Tailwind does not scan this package. */
export const ALL_DAY_BAR_HEIGHT = 19;
const ALL_DAY_ROW_GAP = 2;
export const ALL_DAY_ROW_HEIGHT = ALL_DAY_BAR_HEIGHT + ALL_DAY_ROW_GAP;
/** The container reserves this above and below the bars. */
export const ALL_DAY_TOP_PADDING = 4;

/** Below this width (px) a block renders title only, with the checkbox hidden until hover.
 * Tuned for 7-day columns, where depth-2 cascaded events land around 100-120 px and start
 * losing their time row. */
export const COMPACT_MODE_WIDTH_PX = 100;

/** A block that would render narrower than this (px) folds into the cluster's `+N more` pill
 * instead of truncating its title to a single letter. */
export const OVERFLOW_MIN_WIDTH_PX = 60;

/** Deepest cascade that stays visible: the host (depth 0) plus this many guests. Anything
 * deeper folds into the "+N more" pill whatever the column width, so a dense day looks the
 * same in narrow and wide layouts instead of showing slivers whose titles bleed together. */
export const MAX_VISIBLE_CASCADE_DEPTH = 1;

/** Horizontal indent (% of column width) per cascade depth, so the host's title and time row
 * stay visible. Tuned for 7-day columns (~150-180 px): smaller and depth-3 events lose
 * readability, larger and the host's title is squeezed at depth 1. */
export const CASCADE_OFFSET_PCT = 12;
