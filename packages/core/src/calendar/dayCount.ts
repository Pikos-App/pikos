// Lives in shared/ rather than features/calendar so settings, layout, and
// CalendarSettingsContext can reference these without a cross-feature import.

export type CalendarDensity = "compact" | "normal" | "spacious";

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
