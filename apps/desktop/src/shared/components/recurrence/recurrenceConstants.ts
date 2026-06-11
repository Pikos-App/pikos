import type { RecurrenceFreq, RecurrenceOptions, RecurrenceWeekday } from "@pikos/core";

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

/** Shape-compare two RecurrenceOptions, ignoring end conditions (count/until). */
export function shapesMatch(a: RecurrenceOptions, b: RecurrenceOptions): boolean {
  if (a.freq !== b.freq) return false;
  if (a.interval !== b.interval) return false;
  const aDays = (a.byweekday ?? []).join(",");
  const bDays = (b.byweekday ?? []).join(",");
  return aDays === bDays;
}

export function computePresets(anchor: Date): Preset[] {
  const weekday = jsDayToRrule(anchor.getDay());
  const weekdayAbbr = WEEKDAYS[weekday]!.abbr;
  const dayOfMonth = anchor.getDate();
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
