/**
 * Calendar density is the hour height in px at the default text size, picked from unnamed
 * steps: names stop meaning anything once the text size multiplies the hour.
 *
 * The densest step is 30, not the evenly spaced 28: at 28 a block running into the collapsed
 * evening band gains the band's fixed inset, which doesn't scale with the text, and crosses its
 * time-row tier at some text sizes only.
 */
export const CALENDAR_DENSITY_STEPS = [30, 40, 52, 64, 76, 88] as const;

export type CalendarDensity = (typeof CALENDAR_DENSITY_STEPS)[number];

export const DEFAULT_CALENDAR_DENSITY: CalendarDensity = 64;

/** Named presets an older stored density may hold. */
export const LEGACY_CALENDAR_DENSITIES = {
  compact: 40,
  normal: 64,
  spacious: 88,
} as const satisfies Record<string, CalendarDensity>;

/** A stored density as a step; a legacy preset name reads as its height. */
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

/** Numbers are column counts; `"mf"` is the work week: 5 columns anchored to Monday. */
export type CalendarDayCount = 1 | 3 | 5 | "mf" | 7;

export function dayCountColumns(dc: CalendarDayCount): number {
  return dc === "mf" ? 5 : dc;
}

/** Days prev/next advances. "mf" steps a full week, so the next page starts on a Monday. */
export function dayCountNavStep(dc: CalendarDayCount): number {
  return dc === "mf" ? 7 : dc;
}

/** Caps a preferred day count at what the breakpoint can render; "mf" that doesn't fit demotes
 * to the largest number that does. */
export function clampDayCount(preferred: CalendarDayCount, maxColumns: number): CalendarDayCount {
  if (dayCountColumns(preferred) <= maxColumns) return preferred;
  if (maxColumns >= 7) return 7;
  if (maxColumns >= 5) return 5;
  if (maxColumns >= 3) return 3;
  return 1;
}
