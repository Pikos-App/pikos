// Everything here is dependency-free so other modules in this folder can
// import freely without cycles.

/** Delay (ms) to distinguish single click (popover) from double click (open editor). */
export const CLICK_DELAY = 150;

/** Pixel movement threshold before a mousedown is treated as a drag gesture. */
export const DRAG_THRESHOLD = 4;

/**
 * The calendar grid renders the full 24-hour day. GRID_START_HOUR / GRID_END_HOUR
 * used to clip to "working hours" but are now fixed — scrolling reveals the rest.
 */
export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const VISIBLE_HOURS = 24;

/** Default "normal" density metrics. Tests and legacy callers read these directly. */
export const HOUR_HEIGHT = 64;
export const GRID_HEIGHT = VISIBLE_HOURS * HOUR_HEIGHT;

/**
 * Visual height for a 15-minute ("quarter hour") block. Every timed event renders
 * at a multiple of this — durations are rounded up to the next 15-minute slot so
 * short events remain readable.
 */
export const COMPACT_BLOCK_HEIGHT = HOUR_HEIGHT / 4;

/**
 * Layout threshold (px): below this a block renders as a single-line chip, above
 * this as a stacked title+time block. Density-independent.
 */
export const CHIP_STACKED_THRESHOLD = 28;

/** Slot size (minutes) used to round up short event durations for visual height. */
export const MIN_TIMED_MINUTES = 15;

/** Pixel height of each collapsed band. Matches the screenshot: ~40px so two
 * stacked labels (e.g. "12 AM"/"6 AM") plus a chevron remain comfortably legible. */
export const COLLAPSED_BAND_HEIGHT = 40;

/** Hard limits the user can drag the bounds to. Top must stay below bottom by
 * at least 1 hour so the middle "waking hours" region never disappears. */
export const MIN_TOP_HOUR = 0;
export const MAX_TOP_HOUR = 12;
export const MIN_BOTTOM_HOUR = 12;
export const MAX_BOTTOM_HOUR = 24;
export const MIN_VISIBLE_HOURS = 1;

/** Configurable collapse settings (persisted in CalendarSettingsContext). */
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
 * Shared Tailwind classes for event chips — used by both compact timed blocks and all-day items
 * so they stay visually identical. Import these instead of duplicating the string.
 */
export const CHIP_BASE_CLASSES =
  "type-body-sm h-[19px] overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" as const;

/** Default folder accent (Tailwind blue-500) used when a page has no folder
 * colour. Routed through the same `--event-color` CSS rule as folder colours
 * so every block fill is an opaque `color-mix` with the background — no
 * alpha-blending muddiness when blocks stack. */
export const DEFAULT_EVENT_COLOR = "rgb(59 130 246)" as const;

// All-day layout: bars in the all-day section are absolutely positioned. Row N
// sits at `ALL_DAY_TOP_PADDING + N * ALL_DAY_ROW_HEIGHT`; the container reserves
// `2 * ALL_DAY_TOP_PADDING + rowCount * ALL_DAY_ROW_HEIGHT` so the bottom edge
// gets matching breathing room.

/** Height of a single all-day bar (matches CHIP_BASE_CLASSES h-[19px]). */
export const ALL_DAY_BAR_HEIGHT = 19;
/** Vertical gap between bars on consecutive rows. */
const ALL_DAY_ROW_GAP = 2;
/** Row pitch — how much `top` advances for each row index. */
export const ALL_DAY_ROW_HEIGHT = ALL_DAY_BAR_HEIGHT + ALL_DAY_ROW_GAP;
/** Top/bottom padding on the bar container. */
export const ALL_DAY_TOP_PADDING = 4;

/**
 * Below this rendered width (px) a block switches to single-line "ultra
 * compact" rendering: title only, time hidden, checkbox hidden until hover.
 * Tuned for 7-day-week columns where standard cascade depth-2 events land
 * around 100–120 px and start losing their time row.
 */
export const COMPACT_MODE_WIDTH_PX = 100;

/**
 * If any block would render below this rendered width (px), the layout
 * collapses the smallest blocks into a `+N more` pill at the cluster's
 * right edge instead of letting their titles truncate to a single letter.
 */
export const OVERFLOW_MIN_WIDTH_PX = 60;

/**
 * Maximum cascade depth that stays visible. The host (depth 0) plus this many
 * cascaded guests render normally; anything deeper folds into the "+N more"
 * pill regardless of column width. Depth-based collapse fires before the
 * width rule so dense days look the same in narrow (7-day-with-sidebar) and
 * wide (1-day or sidebar-hidden) layouts — the user always sees host + 1
 * cascade and a pill, never a thicket of 3+-deep cascading slivers where
 * each cascading title bleeds into the next.
 */
export const MAX_VISIBLE_CASCADE_DEPTH = 1;

/**
 * Horizontal indent (% of day-column width) per cascade depth step. Each
 * time-overlapping event gets pushed right by this amount so its host's
 * title/time row stays visible at the top-left. Tuned for 7-day-week columns
 * (~150–180 px wide): smaller and depth-3 events lose readability; larger and
 * the host's title gets squeezed at depth 1.
 */
export const CASCADE_OFFSET_PCT = 12;
