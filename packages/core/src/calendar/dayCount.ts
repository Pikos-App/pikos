// Lives in shared/ rather than features/calendar so settings, layout, and
// CalendarSettingsContext can reference these without a cross-feature import.

/**
 * Calendar density is the hour height in px at the default text size, picked from
 * unnamed steps. It was three named presets, and the names stopped meaning
 * anything once the text size multiplies the hour: "compact" at 28px showed fewer
 * hours than the default.
 *
 * The densest step is 30 rather than the evenly spaced 28: at 28 a block running
 * into the collapsed evening band gains the band's fixed inset, which doesn't
 * scale with the text, and crosses its time-row tier at some text sizes only.
 */
export const CALENDAR_DENSITY_STEPS = [30, 40, 52, 64, 76, 88] as const;

export type CalendarDensity = (typeof CALENDAR_DENSITY_STEPS)[number];

export const DEFAULT_CALENDAR_DENSITY: CalendarDensity = 64;

/** The presets a density was stored as before it was a range. */
export const LEGACY_CALENDAR_DENSITIES = {
  compact: 40,
  normal: 64,
  spacious: 88,
} as const satisfies Record<string, CalendarDensity>;

/** A stored density as a step, reading a legacy preset name as its height, so a
 *  preference saved before the range existed keeps its calendar. */
export function toCalendarDensity(stored: unknown): CalendarDensity {
  const legacy = LEGACY_CALENDAR_DENSITIES[stored as keyof typeof LEGACY_CALENDAR_DENSITIES];
  if (legacy !== undefined) return legacy;

  return CALENDAR_DENSITY_STEPS.find((step) => step === stored) ?? DEFAULT_CALENDAR_DENSITY;
}

/** The next step roomier (`1`) or denser (`-1`), or the same step at either end. */
export function stepCalendarDensity(density: CalendarDensity, direction: 1 | -1): CalendarDensity {
  const index = CALENDAR_DENSITY_STEPS.indexOf(density);

  return CALENDAR_DENSITY_STEPS[index + direction] ?? density;
}

/**
 * User-selectable day count for the calendar grid. Numbers are literal column
 * counts; `"mf"` means "work week" — 5 columns anchored to Monday, Sat/Sun hidden.
 */
export type CalendarDayCount = 1 | 3 | 5 | "mf" | 7;

export function dayCountColumns(dc: CalendarDayCount): number {
  return dc === "mf" ? 5 : dc;
}

/**
 * How many days prev/next navigation should advance. M-F steps by a full week
 * so the next page lands on the following Monday, not on a Saturday.
 */
export function dayCountNavStep(dc: CalendarDayCount): number {
  return dc === "mf" ? 7 : dc;
}

/**
 * Cap a user-preferred day count by what the current breakpoint can render.
 * If "mf" doesn't fit, demote to the largest numeric value that does.
 */
export function clampDayCount(preferred: CalendarDayCount, maxColumns: number): CalendarDayCount {
  if (dayCountColumns(preferred) <= maxColumns) return preferred;
  if (maxColumns >= 7) return 7;
  if (maxColumns >= 5) return 5;
  if (maxColumns >= 3) return 3;
  return 1;
}
