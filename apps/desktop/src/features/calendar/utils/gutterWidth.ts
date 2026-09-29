/**
 * The width of the calendar's left gutter, shared by the hour labels and by the
 * spacers standing in for them above the grid.
 *
 * It rides the calendar's text scale because the labels do: at a larger size
 * "10 PM" outgrows a fixed 3.5rem and wraps into the grid. Every row above the
 * grid has to use the same width or its columns sit off the ones below.
 *
 * Whole pixels, and computed once for the whole calendar, because both halves of
 * that matter. A fixed `w-14` beside a scaling gutter put the rows visibly out of
 * step. Replacing it with the same `calc` left them a fraction apart instead: the
 * default scale is 14/13, so the gutter lands on 60.3px, each section divides its
 * own fractional remainder across seven columns, and they round independently.
 * Rounding here gives every section the same integer to subtract.
 */
export const CALENDAR_GUTTER_BASE_PX = 56;

export function calendarGutterPx(textScale: number): number {
  return Math.round(CALENDAR_GUTTER_BASE_PX * textScale);
}

/** The custom property `CalendarView` sets and the three gutter sites read. */
export const CALENDAR_GUTTER_VAR = "--calendar-gutter";

/** Tailwind width bound to that property, so a site cannot drift from the others. */
export const CALENDAR_GUTTER_WIDTH = "w-[var(--calendar-gutter,3.5rem)]";

/** The zoom factor, for the chip heights that have to track it in CSS. Set beside
 *  the gutter on the calendar root, and exactly 1 at the default text size. */
export const CALENDAR_ZOOM_VAR = "--calendar-zoom";
