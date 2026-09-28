/**
 * The width of the calendar's left gutter, shared by the hour labels and by the
 * spacers that stand in for them above the grid.
 *
 * It rides `--ui-text-scale` because the labels do: at a larger calendar text size
 * "10 PM" outgrows a fixed 3.5rem and would wrap into the grid. Every row above the
 * grid has to use the same expression or its columns sit a few pixels off the ones
 * below — which is what a fixed `w-14` beside a scaling gutter produced, at every
 * calendar text size including the default 14 against a base of 13.
 */
export const CALENDAR_GUTTER_WIDTH = "w-[calc(3.5rem*var(--ui-text-scale,1))]";
