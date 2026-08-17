import type { RecurrenceFreq, RecurrenceOptions, RecurrenceWeekday } from "@pikos/core";
import { getDaysInMonth } from "date-fns";

export const FREQ_UNIT_LABELS: Record<RecurrenceFreq, { singular: string; plural: string }> = {
  DAILY: { plural: "Days", singular: "Day" },
  MONTHLY: { plural: "Months", singular: "Month" },
  WEEKLY: { plural: "Weeks", singular: "Week" },
  YEARLY: { plural: "Years", singular: "Year" },
};

/** rrule.js convention: 0 = Monday, 6 = Sunday. */
export const WEEKDAYS: {
  value: RecurrenceWeekday;
  short: string;
  full: string;
  abbr: string;
}[] = [
  { abbr: "Mon", full: "Monday", short: "M", value: 0 },
  { abbr: "Tue", full: "Tuesday", short: "T", value: 1 },
  { abbr: "Wed", full: "Wednesday", short: "W", value: 2 },
  { abbr: "Thu", full: "Thursday", short: "T", value: 3 },
  { abbr: "Fri", full: "Friday", short: "F", value: 4 },
  { abbr: "Sat", full: "Saturday", short: "S", value: 5 },
  { abbr: "Sun", full: "Sunday", short: "S", value: 6 },
];

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Convert JS Date.getDay() (0=Sun) to rrule.js index (0=Mon). */
function jsDayToRrule(jsDay: number): RecurrenceWeekday {
  return ((jsDay + 6) % 7) as RecurrenceWeekday;
}

/**
 * The anchor's BYDAY ordinal — `2` for a second Tuesday, `-1` for a last one.
 *
 * An anchor in the final seven days of its month takes `-1` rather than its cardinal
 * position: that late in the month it almost always means "month end", and a
 * 5th-position rule would skip every month holding only four of that weekday. The cost
 * is a genuine "4th Monday" that happens to also be the last one, which the preset
 * can't author — its detail text says which reading it took before it's clicked.
 */
function byweekdayOrdinal(anchor: Date): number {
  const dayOfMonth = anchor.getDate();
  return dayOfMonth + 7 > getDaysInMonth(anchor) ? -1 : Math.ceil(dayOfMonth / 7);
}

function positionLabel(ordinal: number): string {
  return ordinal === -1 ? "last" : `${ordinal}${ordinalSuffix(ordinal)}`;
}

function ordinalSuffix(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return "st";
  if (rem10 === 2 && rem100 !== 12) return "nd";
  if (rem10 === 3 && rem100 !== 13) return "rd";
  return "th";
}

export interface Preset {
  id: string;
  label: string;
  /** Optional parenthetical detail shown muted after the label. */
  detail?: string;
  options: RecurrenceOptions;
  /** True to render with a divider *above* this row. */
  startsGroup?: boolean;
}

/**
 * Every pattern term, normalised for comparison. WKST defaults to Monday so an
 * imported rule that spells it out still matches a preset that omits it.
 */
function shapeKey(o: RecurrenceOptions): string {
  return JSON.stringify([
    o.freq,
    o.interval,
    o.byweekday ?? [],
    o.byweekdayOrdinals ?? [],
    o.bymonthday ?? [],
    o.bymonth ?? [],
    o.bysetpos ?? [],
    o.wkst ?? 0,
  ]);
}

/**
 * Shape-compare two RecurrenceOptions, ignoring end conditions (count/until).
 *
 * Comparing every pattern term, not just freq/interval/byweekday: a partial
 * compare made a richer rule ("monthly on the last day") light up the plain
 * Monthly preset as already-active, and clicking that highlighted row then
 * flattened the rule to the preset.
 */
export function shapesMatch(a: RecurrenceOptions, b: RecurrenceOptions): boolean {
  return shapeKey(a) === shapeKey(b);
}

export function computePresets(anchor: Date): Preset[] {
  const weekday = jsDayToRrule(anchor.getDay());
  const weekdayAbbr = WEEKDAYS[weekday]!.abbr;
  const dayOfMonth = anchor.getDate();
  const position = byweekdayOrdinal(anchor);
  const monthName = MONTH_NAMES_SHORT[anchor.getMonth()]!;
  return [
    { id: "daily", label: "Daily", options: { freq: "DAILY", interval: 1 } },
    {
      detail: `${weekdayAbbr}`,
      id: "weekly",
      label: "Weekly",
      options: { byweekday: [weekday], freq: "WEEKLY", interval: 1 },
    },
    {
      detail: `${weekdayAbbr}`,
      id: "biweekly",
      label: "Every 2 weeks",
      options: { byweekday: [weekday], freq: "WEEKLY", interval: 2 },
    },
    {
      detail: `${dayOfMonth}${ordinalSuffix(dayOfMonth)}`,
      id: "monthly",
      label: "Monthly",
      options: { freq: "MONTHLY", interval: 1 },
    },
    {
      detail: `${positionLabel(position)} ${weekdayAbbr}`,
      id: "monthly-weekday",
      label: "Monthly",
      options: {
        byweekday: [weekday],
        byweekdayOrdinals: [position],
        freq: "MONTHLY",
        interval: 1,
      },
    },
    {
      detail: `${monthName} ${dayOfMonth}`,
      id: "yearly",
      label: "Yearly",
      options: { freq: "YEARLY", interval: 1 },
    },
    {
      detail: "Mon – Fri",
      id: "weekdays",
      label: "Every weekday",
      options: { byweekday: [0, 1, 2, 3, 4], freq: "WEEKLY", interval: 1 },
      startsGroup: true,
    },
  ];
}
