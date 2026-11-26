/**
 * The width of the calendar's left gutter, shared by the hour labels and the spacers standing
 * in for them above the grid. Every row above the grid must use the same width or its columns
 * sit off the ones below.
 *
 * It rides the calendar's text scale because the labels do: at a larger size "10 PM" outgrows
 * a fixed 3.5rem and wraps. Whole pixels, computed once for the whole calendar: a `calc` left
 * the sections a fraction apart, because the default scale is 14/13, the gutter lands on
 * 60.3px, and each section rounds its own remainder across seven columns independently.
 */
export const CALENDAR_GUTTER_BASE_PX = 56;

export function calendarGutterPx(textScale: number): number {
  return Math.round(CALENDAR_GUTTER_BASE_PX * textScale);
}

export const CALENDAR_GUTTER_VAR = "--calendar-gutter";

export const CALENDAR_GUTTER_WIDTH = "w-[var(--calendar-gutter,3.5rem)]";

/** The zoom factor, for chip heights that must track it in CSS; exactly 1 at the default text size. */
export const CALENDAR_ZOOM_VAR = "--calendar-zoom";
