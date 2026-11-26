import * as chrono from "chrono-node";
import {
  addDays,
  addMinutes,
  addMonths,
  differenceInMinutes,
  format,
  getDaysInMonth,
  isBefore,
  set,
  startOfDay,
} from "date-fns";

import { formatDateOnly, formatLocalISO, isAllDayIso, parseLocalISO } from "../utils/dates";
import { listOccurrences, type RecurrenceFreq } from "../utils/recurrence";

type PagePriority = "urgent" | "high" | "medium" | "low";

/** The `page_reminders.minutes_before` value meaning "the day before, at 09:00 local" and not a
 * lead time: `pikos_db::DAY_BEFORE_MINUTES`, mirrored so the parser returns the row's value. */
export const DAY_BEFORE_MINUTES = -2;

/**
 * What a chrono match must pin to count as the page's date. chrono also matches a bare "morning"
 * or "evening", pinning only a meridiem, and that word belongs to the title ("Evening review
 * today 8pm"), so the date is the first match that pins one of these.
 */
const DATE_OR_TIME_COMPONENTS: readonly chrono.Component[] = [
  "year",
  "month",
  "day",
  "weekday",
  "hour",
  "minute",
];

export interface ParsedInput {
  title: string;
  scheduledStart?: string; // ISO 8601 — date-only ("2026-03-16") or datetime ("2026-03-16T15:00:00")
  scheduledEnd?: string; // ISO 8601 datetime, derived from start + duration
  durationMinutes?: number;
  tags: string[];
  folderQuery?: string;
  priority?: PagePriority | null; // null = explicitly cleared (!0); undefined = not mentioned
  /** Reminder rows to write as `minutes_before` values: ascending, deduped, and resolved against
   * the schedule shape. Absent when nothing was asked, or when there is no schedule to anchor
   * to, in which case the words stay in the title. */
  reminderMinutes?: number[];
  /** Plain text taken verbatim from after the first ` // `; absent when there is no separator or
   * nothing after it. */
  content?: string;
}

export type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string };

/** rrule convention: 0 = Monday ... 6 = Sunday. */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const MO = 0 as Weekday;
const TU = 1 as Weekday;
const WE = 2 as Weekday;
const TH = 3 as Weekday;
const FR = 4 as Weekday;
const SA = 5 as Weekday;
const SU = 6 as Weekday;

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const DAY_MAP: Record<string, Weekday> = {
  f: FR,
  fr: FR,
  fri: FR,
  friday: FR,
  m: MO,
  mo: MO,
  mon: MO,
  monday: MO,
  sa: SA,
  sat: SA,
  saturday: SA,
  su: SU,
  sun: SU,
  sunday: SU,
  t: TU,
  th: TH,
  thu: TH,
  thur: TH,
  thurs: TH,
  thursday: TH,
  tu: TU,
  tue: TU,
  tues: TU,
  tuesday: TU,
  w: WE,
  we: WE,
  wed: WE,
  wednesday: WE,
};

const WEEKDAY_DAYS = [MO, TU, WE, TH, FR];
const WEEKEND_DAYS = [SA, SU];

/** rrule weekday (0 = MO) to JS `Date.getDay()` (0 = SU). */
const RRULE_TO_JS_DAY: Record<number, number> = {
  0: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 0,
};

function nextWeekdayOccurrence(ref: Date, weekday: Weekday): Date {
  const targetJsDay = RRULE_TO_JS_DAY[weekday]!;
  const current = ref.getDay();
  let daysAhead = targetJsDay - current;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0) daysAhead = 7;
  return addDays(ref, daysAhead);
}

/** An RRULE string without "RRULE:" prefix or DTSTART, per the data-model convention. INTERVAL
 * is emitted only above 1. */
function serializeRrule(opts: {
  freq: RecurrenceFreq;
  byweekday?: Weekday[] | undefined;
  interval?: number | undefined;
  count?: number | undefined;
  until?: string | undefined;
}): string {
  let out = `FREQ=${opts.freq}`;
  if (opts.interval && opts.interval > 1) out += `;INTERVAL=${opts.interval}`;
  if (opts.byweekday && opts.byweekday.length > 0) {
    out += `;BYDAY=${opts.byweekday.map((d) => WEEKDAY_CODES[d]).join(",")}`;
  }
  if (opts.count != null) {
    out += `;COUNT=${opts.count}`;
  } else if (opts.until) {
    out += `;UNTIL=${opts.until}`;
  }
  return out;
}

/** Compact UNTIL ("YYYYMMDDTHHMMSS") from local wall-clock fields. Floating, not UTC: the data
 * model is timezone-naive, and RFC 5545 asks for a floating UNTIL beside a floating DTSTART. */
function untilFromLocalDate(d: Date, endOfDay: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = endOfDay
    ? "235959"
    : `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}T${time}`;
}

/** Date phrases chrono misreads or can't read, rewritten into forms it can. */
function rewriteDatePhrases(input: string, ref: Date): string {
  let text = input;

  // chrono sets a meridiem for "morning"/"evening" but not hour-certainty, so the hasTime branch
  // (gated on isCertain) skips them. Rewriting to explicit times (morning 9am, afternoon 3pm,
  // evening 6pm, night 8pm, productivity defaults) yields a timed event.
  const CASUAL_TIME_OF_DAY: Record<string, { time: string; hour: number }> = {
    afternoon: { hour: 15, time: "3pm" },
    evening: { hour: 18, time: "6pm" },
    morning: { hour: 9, time: "9am" },
    night: { hour: 20, time: "8pm" },
  };
  // "tonight" is today 8pm if still future, else tomorrow, so a late-night quick-add doesn't
  // schedule into the past.
  text = text.replace(/\btonight\b/gi, () => {
    return ref.getHours() < 20 ? "today at 8pm" : "tomorrow at 8pm";
  });
  // With "this" or "today" the parser shifts to tomorrow when the implied hour has passed in
  // `ref`; chrono can't make that call because it doesn't know our defaults.
  const PREFIX_DAY =
    "(?:today|tomorrow|this|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)";
  text = text.replace(
    new RegExp(`\\b(${PREFIX_DAY})\\s+(morning|afternoon|evening|night)\\b`, "gi"),
    (_, prefix: string, period: string) => {
      const cfg = CASUAL_TIME_OF_DAY[period.toLowerCase()]!;
      const p = prefix.toLowerCase();
      if (p === "this" || p === "today") {
        return ref.getHours() < cfg.hour ? `today at ${cfg.time}` : `tomorrow at ${cfg.time}`;
      }
      return `${prefix} at ${cfg.time}`;
    }
  );

  // forwardDate: true is right for "monday" but turns "last monday" into "next monday", so the
  // previous occurrence is resolved here and substituted as a concrete date.
  text = text.replace(
    /\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    (_, weekday: string) => {
      const day = DAY_MAP[weekday.toLowerCase()];
      if (day === undefined) return _;
      const targetJsDay = RRULE_TO_JS_DAY[day]!;
      const current = ref.getDay();
      let daysBack = current - targetJsDay;
      if (daysBack <= 0) daysBack += 7;
      const target = addDays(ref, -daysBack);
      return formatDateOnly(target);
    }
  );

  // chrono reads "end of next month" as one month from today and leaves "by the end of" in the
  // title. Months only: where a week ends depends on a week-start setting the parser doesn't know.
  text = text.replace(
    /\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:(the|this|next)\s+)?month\b/gi,
    (_, which: string | undefined) => {
      const month = which?.toLowerCase() === "next" ? addMonths(ref, 1) : ref;
      return ` ${format(set(month, { date: getDaysInMonth(month) }), "MMM d yyyy")} `;
    }
  );

  // chrono parses "May 24" but not "on the 24th" or "Sat 24". Each resolves to a concrete forward
  // date (this month, else the next with that day) so chrono can attach a trailing time and the
  // title-strip removes the whole phrase, connector included.
  //
  // The day number wins over a disagreeing weekday ("Sat 24" on a Sunday): it is the specific
  // signal. Bare ordinals without a connector ("3rd draft") are left alone as too overloaded.
  const resolveDayOfMonth = (n: number): Date | null => {
    for (let offset = 0; offset <= 2; offset++) {
      const month = addMonths(ref, offset);
      if (n > getDaysInMonth(month)) continue;
      const candidate = set(month, {
        date: n,
        hours: 0,
        milliseconds: 0,
        minutes: 0,
        seconds: 0,
      });
      if (offset > 0 || !isBefore(candidate, startOfDay(ref))) return candidate;
    }
    return null;
  };
  // "of" goes with it when a cadence follows ("on the 1st of every month"), or the cadence strip
  // strands it in the title.
  text = text.replace(
    /\b(?:on|by)\s+(?:the\s+)?(3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)(?:\s+of(?=\s+(?:every|each)\b))?\b/gi,
    (match, dayStr: string) => {
      const target = resolveDayOfMonth(parseInt(dayStr, 10));
      return target ? ` ${format(target, "MMM d yyyy")} ` : match;
    }
  );
  // Guarded against a leading "every" so "every friday ..." isn't consumed here.
  text = text.replace(
    /(?<!\bevery\s)\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?\b/gi,
    (match, dayStr: string) => {
      const target = resolveDayOfMonth(parseInt(dayStr, 10));
      return target ? ` ${format(target, "MMM d yyyy")} ` : match;
    }
  );

  // chrono reads "May 2 through 10" as the time range 2-10 am. The window parser consumes
  // "through <word>" for bounded recurrence but bare "through <digit>" falls to chrono, so it
  // becomes "to", leaving cadence uses ("every monday through april 30") alone.
  text = text.replace(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(st|nd|rd|th)?\s+(?:through|thru)\s+((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{1,2})(st|nd|rd|th)?\b/gi,
    (_, m1: string, d1: string, _s1: string | undefined, m2: string | undefined, d2: string) =>
      m2 ? `${m1} ${d1} to ${m2}${d2}` : `${m1} ${d1} to ${d2}`
  );

  return text;
}

export interface ParseOptions {
  /**
   * The input renames a page that already has its date and body (a block dragged onto the
   * calendar), whose slot wins over a date typed in its title. Only tags, folder, priority and a
   * repeat are read; date, time, duration, reminder and body words stay in the title so a rename
   * can't lose a word. A repeat anchors on the page's slot.
   */
  rename?: boolean;
}

export function parseInput(raw: string, now?: Date, options: ParseOptions = {}): ParseResult {
  const ref = now ?? new Date();
  const { rename = false } = options;

  if (!raw || !raw.trim()) {
    return { input: { tags: [], title: "" }, type: "single" };
  }

  // Everything after the first whitespace-delimited "//" is the body, verbatim: no tag, folder,
  // date or cadence is read from it, so "#word" in a note stays text. Whitespace on both sides
  // keeps "https://example.com" a URL and a later "//" part of the body.
  let content: string | undefined;
  let text = raw;
  const bodySplit = rename ? null : /(?:^|\s)\/\/(?:\s|$)/.exec(raw);
  if (bodySplit) {
    text = raw.slice(0, bodySplit.index);
    const body = raw.slice(bodySplit.index + bodySplit[0].length).trim();
    if (body) content = body;
  }

  if (!rename) text = rewriteDatePhrases(text, ref);

  const tags: string[] = [];
  text = text.replace(/#(\w+)/g, (_, tag: string) => {
    tags.push(tag);
    return " ";
  });

  let folderQuery: string | undefined;
  text = text.replace(/~(\w+)/g, (_, folder: string) => {
    folderQuery = folder;
    return " ";
  });

  let priority: PagePriority | null | undefined;
  text = text.replace(/!(urgent|high|medium|low)\b/gi, (_, p: string) => {
    priority = p.toLowerCase() as PagePriority;
    return " ";
  });

  const NUMERIC_PRIORITY_MAP: Record<string, PagePriority | null> = {
    "0": null,
    "1": "urgent",
    "2": "high",
    "3": "medium",
    "4": "low",
  };
  text = text.replace(/!([0-4])\b/g, (_, n: string) => {
    const mapped = NUMERIC_PRIORITY_MAP[n];
    if (mapped !== undefined) {
      priority = mapped; // null means explicitly cleared (!0)
    }
    return " ";
  });

  // Extracted before chrono so a lead ("1d before") isn't mistaken for the event's date, and
  // stashed behind a placeholder, since whether a schedule exists to anchor it isn't known until
  // chrono has run. The placeholder is control characters only, so no rule before the restore can
  // match inside it.
  const REMINDER_UNIT_MINUTES: Record<string, number> = {
    d: 1440,
    day: 1440,
    days: 1440,
    h: 60,
    hour: 60,
    hours: 60,
    hr: 60,
    hrs: 60,
    m: 1,
    min: 1,
    mins: 1,
    minute: 1,
    minutes: 1,
  };
  // Longest-first so "minutes" can't be consumed as a bare "m".
  const REMINDER_UNIT = "(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)";
  const reminderLeads: number[] = [];
  const reminderTokens: string[] = [];
  const reminderPlaceholder = (index: number) => `\u0000${"\u0001".repeat(index + 1)}\u0000`;
  function stashReminder(match: string, num: string | undefined, unit: string): string {
    const per = REMINDER_UNIT_MINUTES[unit.toLowerCase()];
    if (per === undefined) return match;
    // A bare unit means one of it: "remind day before" is a one-day lead.
    const count = num === undefined ? 1 : parseFloat(num);
    reminderLeads.push(Math.max(0, Math.round(count * per)));
    reminderTokens.push(match.trim());
    return ` ${reminderPlaceholder(reminderTokens.length - 1)} `;
  }
  // Shorthand: "!r30" (minutes by default), "!r1h", "!r1d".
  text = text.replace(
    new RegExp(`!r(\\d+(?:\\.\\d+)?)\\s*${REMINDER_UNIT}?\\b`, "gi"),
    (match, num: string, unit: string | undefined) => stashReminder(match, num, unit ?? "m")
  );
  // The filler excludes "in", so "remind me in 2 days" stays a date for chrono, not a lead.
  text = text.replace(
    new RegExp(
      `\\bremind(?:er)?s?\\b(?:\\s+(?:please|about|one|the|an|us|me|at|a))*\\s*(\\d+(?:\\.\\d+)?)?\\s*${REMINDER_UNIT}\\b(?:\\s+(?:beforehand|before|ahead|prior|early|in\\s+advance)\\b)?`,
      "gi"
    ),
    (match, num: string | undefined, unit: string) => stashReminder(match, num, unit)
  );

  let durationMinutes: number | undefined;
  text = text.replace(
    /\bfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi,
    (match, num: string, unit: string) => {
      if (rename) return match;
      const n = parseFloat(num);
      const u = unit.toLowerCase();
      if (u === "h" || u === "hr" || u === "hrs" || u === "hour" || u === "hours") {
        durationMinutes = Math.round(n * 60);
      } else {
        durationMinutes = Math.round(n);
      }
      return " ";
    }
  );

  type WindowSpec =
    | { kind: "count"; count: number }
    | { kind: "until"; date: Date }
    | { kind: "days"; count: number };

  let windowSpec: WindowSpec | undefined;

  text = text.replace(/\b(\d+)\s+times\b/gi, (_, n: string) => {
    windowSpec = { count: parseInt(n, 10), kind: "count" };
    return " ";
  });

  text = text.replace(
    /\bfor\s+(\d+)\s*(day|days|week|weeks|month|months)\b/gi,
    (_, n: string, unit: string) => {
      const count = parseInt(n, 10);
      const u = unit.toLowerCase();
      if (u === "day" || u === "days") {
        windowSpec = { count, kind: "days" };
      } else if (u === "week" || u === "weeks") {
        windowSpec = { count: count * 7, kind: "days" };
      } else {
        // Approximate.
        windowSpec = { count: count * 30, kind: "days" };
      }
      return " ";
    }
  );

  text = text.replace(
    /\b(?:through|until|till)\s+([a-z]+\s*\d*(?:st|nd|rd|th)?)/gi,
    (match, dateStr: string) => {
      const parsed = chrono.parseDate(dateStr, ref);
      if (parsed) {
        windowSpec = { date: parsed, kind: "until" };
        return " ";
      }
      return match;
    }
  );

  type RecurrenceSpec =
    | { kind: "infinite"; freq: RecurrenceFreq; byday?: Weekday[]; interval?: number }
    | { kind: "finite-slash"; days: Weekday[] }
    | { kind: "finite-weekdays" };

  let recurrenceSpec: RecurrenceSpec | undefined;

  // Before "every <day>", so "every 2 weeks" and "every other day" match here.
  const INTERVAL_UNIT_FREQ: Record<string, RecurrenceFreq> = {
    day: "DAILY",
    month: "MONTHLY",
    week: "WEEKLY",
    year: "YEARLY",
  };
  text = text.replace(
    /\bevery\s+(other|\d+)\s+(day|week|month|year)s?\b/gi,
    (_, intervalStr: string, unit: string) => {
      const interval = intervalStr.toLowerCase() === "other" ? 2 : parseInt(intervalStr, 10);
      const freq = INTERVAL_UNIT_FREQ[unit.toLowerCase()]!;
      recurrenceSpec = { freq, interval, kind: "infinite" };
      return " ";
    }
  );

  // Interval cadence on a weekday. Before bare "every <weekday>", or "every other tuesday" loses
  // its interval.
  text = text.replace(
    /\bevery\s+(other|\d+)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
    (_, intervalStr: string, weekday: string) => {
      const interval = intervalStr.toLowerCase() === "other" ? 2 : parseInt(intervalStr, 10);
      const day = DAY_MAP[weekday.toLowerCase()];
      if (day === undefined) return " ";
      recurrenceSpec = { byday: [day], freq: "WEEKLY", interval, kind: "infinite" };
      return " ";
    }
  );

  // "every <day>" with comma, "and" and Oxford-comma separators.
  const DAY_WORD =
    "(?:weekday|weekend|day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)";
  const SEP = "(?:\\s*,\\s*|\\s+and\\s+|\\s*,\\s*and\\s+)"; // comma, "and", or ", and"
  // The lookahead (?!\/) leaves a slash list ("every mon/wed/fri") to the slash-days rule; else
  // this eats "every mon" and strands "/wed/fri", turning an infinite rule into a finite series.
  const everyDayRe = new RegExp(`\\bevery\\s+(${DAY_WORD}(?:${SEP}${DAY_WORD})*)\\b(?!\\/)`, "gi");
  text = text.replace(everyDayRe, (_, dayStr: string) => {
    const parts = dayStr.toLowerCase().split(/\s*,?\s*and\s+|\s*,\s*/);
    const allDays: Weekday[] = [];
    let freq: RecurrenceFreq | undefined;
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      if (p === "day") {
        freq = "DAILY";
      } else if (p === "week") {
        freq = "WEEKLY";
      } else if (p === "month") {
        freq = "MONTHLY";
      } else if (p === "year") {
        freq = "YEARLY";
      } else if (p === "weekday") {
        allDays.push(...WEEKDAY_DAYS);
      } else if (p === "weekend") {
        allDays.push(...WEEKEND_DAYS);
      } else if (DAY_MAP[p] !== undefined) {
        allDays.push(DAY_MAP[p]);
      }
    }
    if (freq !== undefined) {
      recurrenceSpec = { freq, kind: "infinite" };
    } else if (allDays.length > 0) {
      recurrenceSpec = { byday: allDays, freq: "WEEKLY", kind: "infinite" };
    }
    return " ";
  });

  // Before "weekly", so the longer match wins.
  if (!recurrenceSpec) {
    text = text.replace(/\b(?:biweekly|fortnightly)\b/gi, () => {
      recurrenceSpec = { freq: "WEEKLY", interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // Before "monthly".
  if (!recurrenceSpec) {
    text = text.replace(/\bbimonthly\b/gi, () => {
      recurrenceSpec = { freq: "MONTHLY", interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // Only when no recurrence was found, so "daily standup every monday" keeps "every monday" as the
  // specifier.
  if (!recurrenceSpec) {
    text = text.replace(/\bdaily\b/gi, () => {
      recurrenceSpec = { freq: "DAILY", kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bweekly\b/gi, () => {
      recurrenceSpec = { freq: "WEEKLY", kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bmonthly\b/gi, () => {
      recurrenceSpec = { freq: "MONTHLY", kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\b(?:yearly|annually)\b/gi, () => {
      recurrenceSpec = { freq: "YEARLY", kind: "infinite" };
      return " ";
    });
  }

  // Slash-separated days (m/w/f, mon/wed/fri), word/word with no spaces. A leading "every " or an
  // existing infinite-weekly spec makes the list BYDAY on an infinite rule; otherwise it's finite.
  const SLASH_DAY =
    "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su|m|t|w|f)";
  const slashDaysRe = new RegExp(`(\\bevery\\s+)?\\b((?:${SLASH_DAY}\\/)+${SLASH_DAY})\\b`, "gi");
  text = text.replace(slashDaysRe, (match, everyPrefix: string | undefined, slashStr: string) => {
    const parts = slashStr.toLowerCase().split("/");
    const days: Weekday[] = [];
    for (const part of parts) {
      const day = DAY_MAP[part];
      if (day !== undefined) days.push(day);
    }
    if (days.length === 0) return " ";

    const isInfiniteWeeklyNoByday =
      recurrenceSpec?.kind === "infinite" &&
      recurrenceSpec.freq === "WEEKLY" &&
      !recurrenceSpec.byday;

    if (everyPrefix || isInfiniteWeeklyNoByday) {
      recurrenceSpec = { byday: days, freq: "WEEKLY", kind: "infinite" };
    } else if (rename) {
      return match;
    } else {
      recurrenceSpec = { days, kind: "finite-slash" };
    }
    return " ";
  });

  // Plural day names imply recurrence and augment an infinite-weekly spec with no byday. Before
  // bare "weekdays" and chrono, to avoid false date parsing.
  {
    const PLURAL_DAY = "(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)";
    const pluralDayRe = new RegExp(
      `(?:\\bon\\s+)?(${PLURAL_DAY}(?:${SEP}${PLURAL_DAY})*)\\b`,
      "gi"
    );
    text = text.replace(pluralDayRe, (match, dayStr: string) => {
      const parts = dayStr.toLowerCase().split(/\s*,?\s*and\s+|\s*,\s*/);
      const days: Weekday[] = [];
      for (const part of parts) {
        const singular = part.trim().replace(/s$/, "");
        if (singular && DAY_MAP[singular] !== undefined) {
          days.push(DAY_MAP[singular]);
        }
      }
      if (days.length === 0) return match;

      const isInfiniteWeeklyNoByday =
        recurrenceSpec?.kind === "infinite" &&
        recurrenceSpec.freq === "WEEKLY" &&
        !recurrenceSpec.byday;

      if (!recurrenceSpec || isInfiniteWeeklyNoByday) {
        recurrenceSpec = { byday: days, freq: "WEEKLY", kind: "infinite" };
        return " ";
      }
      // A spec is already set: leave the plural in the title.
      return match;
    });
  }

  if (!rename) {
    text = text.replace(/\bweekdays\b/gi, () => {
      if (!recurrenceSpec) {
        recurrenceSpec = { kind: "finite-weekdays" };
      }
      return " ";
    });
  }

  if (!rename) text = text.replace(/@(\S+)/g, (_, token: string) => token);

  let scheduledStart: string | undefined;
  let hasTime = false;
  // From chrono's end component when a time range is parsed.
  let chronoEnd: Date | undefined;
  // A multi-day date range, applied to scheduledEnd date-only. Only when the start is date-only:
  // multi-day timed ranges are ambiguous and unsupported.
  let chronoEndDate: Date | undefined;

  const result = rename
    ? undefined
    : chrono
        .parse(text, ref, { forwardDate: true })
        .find((r) => DATE_OR_TIME_COMPONENTS.some((c) => r.start.isCertain(c)));
  if (result) {
    const parsed = result.date();

    if (result.end) {
      if (result.end.isCertain("hour") || result.end.isCertain("minute")) {
        chronoEnd = result.end.date();
      } else if (result.end.isCertain("day") || result.end.isCertain("weekday")) {
        chronoEndDate = result.end.date();
      }
    }

    hasTime = result.start.isCertain("hour") || result.start.isCertain("minute");

    // Bare weekday names are certain on "weekday" but not "day".
    const hasDate =
      result.start.isCertain("day") ||
      result.start.isCertain("month") ||
      result.start.isCertain("year") ||
      result.start.isCertain("weekday");

    if (hasTime && !hasDate) {
      // A recurrence weekday anchors to that day's next occurrence, not today or tomorrow.
      if (
        recurrenceSpec?.kind === "infinite" &&
        recurrenceSpec.byday &&
        recurrenceSpec.byday.length > 0
      ) {
        const target = set(nextWeekdayOccurrence(ref, recurrenceSpec.byday[0]!), {
          hours: parsed.getHours(),
          milliseconds: 0,
          minutes: parsed.getMinutes(),
          seconds: 0,
        });
        scheduledStart = formatLocalISO(target);
      } else {
        // A time without a date is today if future, else tomorrow.
        const todayWithTime = set(ref, {
          hours: parsed.getHours(),
          milliseconds: 0,
          minutes: parsed.getMinutes(),
          seconds: 0,
        });
        if (todayWithTime <= ref) {
          scheduledStart = formatLocalISO(addDays(todayWithTime, 1));
        } else {
          scheduledStart = formatLocalISO(todayWithTime);
        }
      }
    } else if (hasDate && hasTime) {
      scheduledStart = formatLocalISO(parsed);
    } else if (hasDate) {
      scheduledStart = formatDateOnly(parsed);
    }

    // chrono includes a leading connector inconsistently ("on friday" yes, "on May 24" no), so the
    // strip extends back over a dangling one, or it leaks into the title.
    let consumeStart = result.index;
    const connectorPrefix = text.substring(0, result.index).match(/\b(?:from|on|at|by|for)\s+$/i);
    if (connectorPrefix) consumeStart -= connectorPrefix[0].length;
    text =
      text.substring(0, consumeStart) + " " + text.substring(result.index + result.text.length);
  }

  // "every week" plus a parsed weekday gets BYDAY, so the rrule says "every week on Monday".
  if (
    recurrenceSpec?.kind === "infinite" &&
    recurrenceSpec.freq === "WEEKLY" &&
    !recurrenceSpec.byday &&
    result &&
    result.start.isCertain("weekday")
  ) {
    const jsDay = result.start.get("weekday");
    // chrono's 0 = Sun maps to the rrule 0 = Mon index.
    const JS_TO_RRULE: Record<number, Weekday> = {
      0: SU,
      1: MO,
      2: TU,
      3: WE,
      4: TH,
      5: FR,
      6: SA,
    };
    if (jsDay !== undefined && jsDay !== null && JS_TO_RRULE[jsDay] !== undefined) {
      recurrenceSpec = { ...recurrenceSpec, byday: [JS_TO_RRULE[jsDay]] };
    }
  }

  // A byday with no chrono date anchors to the next occurrence of the first weekday.
  if (
    !rename &&
    !scheduledStart &&
    recurrenceSpec?.kind === "infinite" &&
    recurrenceSpec.byday &&
    recurrenceSpec.byday.length > 0
  ) {
    const target = nextWeekdayOccurrence(ref, recurrenceSpec.byday[0]!);
    scheduledStart = formatDateOnly(target);
  }

  // Every reminder arm of the scheduler joins `page_schedules`, so a lead on an unscheduled page
  // could never fire: without a schedule the words go back into the title. With one, its shape
  // decides what the row holds, resolved here because this is where the shape is known:
  //   - all-day: every lead collapses onto DAY_BEFORE_MINUTES, the only anchor such a page can
  //     carry, since it has no start time to count back from;
  //   - timed: the minutes as typed, so "1d before" is a 1440-minute lead.
  let reminderMinutes: number[] | undefined;
  if (reminderTokens.length > 0) {
    if (scheduledStart !== undefined) {
      const leads = isAllDayIso(scheduledStart) ? [DAY_BEFORE_MINUTES] : reminderLeads;
      reminderMinutes = [...new Set(leads)].sort((a, b) => a - b);
    }
    for (let i = 0; i < reminderTokens.length; i++) {
      text = text.replace(
        reminderPlaceholder(i),
        reminderMinutes ? " " : ` ${reminderTokens[i]!} `
      );
    }
  }

  // Collapse whitespace and clean punctuation orphaned by stripped tokens:
  //   - a trailing "." ended the sentence the tokens were in, not the title, so it goes
  //     ("call ." to "call"), while one the title ends with itself ("Call mum.") stays;
  //   - a trailing "!" or "?" carries meaning, so it stays and loses its gap ("ship it !");
  //   - separator punctuation (",", ";", ":") at the end goes, and mid-string when
  //     whitespace-isolated ("x , y" to "x y"), as leftover tag-list commas.
  // Mid-word punctuation like "!5" stays.
  const title = text
    .replace(/\s+/g, " ")
    .replace(/\s+\.\s*$/, "")
    .replace(/\s+([.!?])(?=\s|$)/g, "$1")
    .replace(/\s+[,;:]+(?=\s|$)/g, "")
    .replace(/^[\s,;:]+/, "")
    .trim();

  const baseInput: ParsedInput = {
    tags,
    title,
    ...(folderQuery !== undefined && { folderQuery }),
    ...(priority !== undefined && { priority }),
    ...(durationMinutes !== undefined && { durationMinutes }),
    ...(reminderMinutes !== undefined && { reminderMinutes }),
    ...(content !== undefined && { content }),
  };

  if (scheduledStart !== undefined) {
    baseInput.scheduledStart = scheduledStart;

    if (durationMinutes !== undefined && hasTime) {
      const startDate = new Date(scheduledStart);
      if (!isNaN(startDate.getTime())) {
        baseInput.scheduledEnd = formatLocalISO(addMinutes(startDate, durationMinutes));
      }
    } else if (chronoEnd && hasTime) {
      // A range crossing midnight ("9pm to 5am") would end before it starts on the same day, so it
      // moves to the next.
      const startDate = new Date(scheduledStart);
      if (!isNaN(startDate.getTime())) {
        let endDate = set(startDate, {
          hours: chronoEnd.getHours(),
          milliseconds: 0,
          minutes: chronoEnd.getMinutes(),
          seconds: 0,
        });
        let derivedMinutes = differenceInMinutes(endDate, startDate);
        if (derivedMinutes < 0) {
          endDate = addDays(endDate, 1);
          derivedMinutes += 24 * 60;
        }
        baseInput.scheduledEnd = formatLocalISO(endDate);
        if (derivedMinutes > 0) {
          baseInput.durationMinutes = derivedMinutes;
        }
      }
    } else if (chronoEndDate && !hasTime && isAllDayIso(scheduledStart)) {
      // Only when the start is date-only.
      const endDateStr = formatDateOnly(chronoEndDate);
      if (endDateStr > scheduledStart) {
        baseInput.scheduledEnd = endDateStr;
      }
    }
  }

  // A window ("10 times", "for N weeks", "through <date>") with no cadence defaults to daily, which
  // keeps the count or boundary the user typed instead of stripping it from the title.
  if (windowSpec && !recurrenceSpec) {
    recurrenceSpec = { freq: "DAILY", kind: "infinite" };
  }

  const isInfiniteRec = recurrenceSpec?.kind === "infinite";

  // "every X" plus a window is one recurring page with COUNT or UNTIL, expanded at render time.
  if (isInfiniteRec && windowSpec) {
    // `windowSpec` is narrowed by the if; the alias keeps the inner branches readable.
    const win = windowSpec;
    const spec = recurrenceSpec as {
      kind: "infinite";
      freq: RecurrenceFreq;
      byday?: Weekday[];
      interval?: number;
    };

    let count: number | undefined;
    let until: string | undefined;
    if (win.kind === "count") {
      count = win.count;
    } else {
      // End of the boundary day, as `buildRrule()`, so parse and expand round-trip.
      let boundary: Date;
      if (win.kind === "until") {
        boundary = win.date;
      } else {
        const dtstart = scheduledStart
          ? new Date(isAllDayIso(scheduledStart) ? scheduledStart + "T00:00:00" : scheduledStart)
          : ref;
        const windowEnd = addDays(dtstart, win.count - 1);
        // Ends on the last occurrence inside the window, not the window's last day, so
        // "every saturday for 8 weeks" reads as ending on a Saturday. A rule here fires at
        // most daily, so the window's day count bounds the expansion.
        const inWindow = listOccurrences(
          serializeRrule({
            byweekday: spec.byday,
            freq: spec.freq,
            interval: spec.interval,
            until: untilFromLocalDate(windowEnd, true),
          }),
          formatLocalISO(dtstart),
          win.count
        );
        const lastInWindow = inWindow[inWindow.length - 1];

        boundary = lastInWindow ? parseLocalISO(lastInWindow) : windowEnd;
      }
      until = untilFromLocalDate(boundary, true);
    }

    const rruleStr = serializeRrule({
      byweekday: spec.byday,
      count,
      freq: spec.freq,
      interval: spec.interval,
      until,
    });

    return { input: baseInput, rrule: rruleStr, type: "recurring" };
  }

  if (recurrenceSpec && recurrenceSpec.kind !== "infinite") {
    // Finite recurrence emits one page per expanded date; reached only without "every" (bare
    // "m/w/f" or "weekdays").
    const days = recurrenceSpec.kind === "finite-weekdays" ? WEEKDAY_DAYS : recurrenceSpec.days;

    const windowStart = scheduledStart
      ? new Date(isAllDayIso(scheduledStart) ? scheduledStart + "T00:00:00" : scheduledStart)
      : ref;

    let count: number | undefined;
    let until: string | undefined;
    if (windowSpec) {
      if (windowSpec.kind === "count") {
        count = windowSpec.count;
      } else if (windowSpec.kind === "until") {
        until = untilFromLocalDate(windowSpec.date, false);
      } else {
        until = untilFromLocalDate(addDays(windowStart, windowSpec.count - 1), false);
      }
    } else if (recurrenceSpec.kind === "finite-weekdays") {
      count = 5;
    } else {
      count = days.length;
    }

    const dates = listOccurrences(
      serializeRrule({ byweekday: days, count, freq: "WEEKLY", until }),
      formatLocalISO(windowStart),
      1000
    ).map(parseLocalISO);

    const inputs: ParsedInput[] = dates.map((d) => {
      // Copied, so a later edit to one page can't reach its siblings.
      const inp: ParsedInput = {
        ...baseInput,
        tags: [...tags],
        ...(reminderMinutes !== undefined && { reminderMinutes: [...reminderMinutes] }),
      };

      if (hasTime && scheduledStart) {
        const startDate = new Date(
          isAllDayIso(scheduledStart) ? scheduledStart + "T00:00:00" : scheduledStart
        );
        const dated = set(new Date(d), {
          hours: startDate.getHours(),
          milliseconds: 0,
          minutes: startDate.getMinutes(),
          seconds: 0,
        });
        inp.scheduledStart = formatLocalISO(dated);
        if (durationMinutes !== undefined) {
          inp.scheduledEnd = formatLocalISO(addMinutes(dated, durationMinutes));
        }
      } else {
        inp.scheduledStart = formatDateOnly(d);
        delete inp.scheduledEnd;
      }

      return inp;
    });

    return { count: inputs.length, inputs, type: "finite" };
  }

  if (isInfiniteRec && !windowSpec) {
    const spec = recurrenceSpec as {
      kind: "infinite";
      freq: RecurrenceFreq;
      byday?: Weekday[];
      interval?: number;
    };
    // No DTSTART: the anchor lives on the page, as in `buildRrule()`.
    const rruleStr = serializeRrule({
      byweekday: spec.byday,
      freq: spec.freq,
      interval: spec.interval,
    });

    return {
      input: baseInput,
      rrule: rruleStr,
      type: "recurring",
    };
  }

  return { input: baseInput, type: "single" };
}
