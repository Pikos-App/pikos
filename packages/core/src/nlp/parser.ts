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

/**
 * The `page_reminders.minutes_before` value that means "the day before, at 09:00
 * local" rather than a lead time in minutes — `pikos_db::DAY_BEFORE_MINUTES`,
 * mirrored here so the parser can hand back the value the row will carry.
 */
export const DAY_BEFORE_MINUTES = -2;

export interface ParsedInput {
  title: string;
  scheduledStart?: string; // ISO 8601 — date-only ("2026-03-16") or datetime ("2026-03-16T15:00:00")
  scheduledEnd?: string; // ISO 8601 datetime, derived from start + duration
  durationMinutes?: number;
  tags: string[];
  folderQuery?: string;
  priority?: PagePriority | null; // null = explicitly cleared (!0); undefined = not mentioned
  /**
   * Reminder rows to write, as `minutes_before` values: ascending, deduped, and
   * already resolved against the schedule shape (see the reminder section of
   * `parseInput`). Absent when nothing was asked for — or when what was asked
   * for has no schedule to anchor to, in which case the words stay in the title.
   */
  reminderMinutes?: number[];
  /**
   * Page body, plain text, taken verbatim from after the first ` // `. Absent
   * when the input carried no separator (or nothing after it).
   */
  content?: string;
}

export type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string };

/** Weekday index in the rrule convention: 0 = Monday … 6 = Sunday. */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const MO = 0 as Weekday;
const TU = 1 as Weekday;
const WE = 2 as Weekday;
const TH = 3 as Weekday;
const FR = 4 as Weekday;
const SA = 5 as Weekday;
const SU = 6 as Weekday;

/** Weekday codes in rrule index order, for RRULE serialization. */
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

/** Map rrule weekday (0=MO … 6=SU) to JS Date.getDay() (0=SU … 6=SA). */
const RRULE_TO_JS_DAY: Record<number, number> = {
  0: 1, // MO
  1: 2, // TU
  2: 3, // WE
  3: 4, // TH
  4: 5, // FR
  5: 6, // SA
  6: 0, // SU
};

function nextWeekdayOccurrence(ref: Date, weekday: Weekday): Date {
  const targetJsDay = RRULE_TO_JS_DAY[weekday]!;
  const current = ref.getDay();
  let daysAhead = targetJsDay - current;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0) daysAhead = 7; // same day → next week (consistent with chrono "monday" behavior)
  return addDays(ref, daysAhead);
}

/**
 * Serializes recurrence parts into an RRULE string (no "RRULE:" prefix, no
 * DTSTART — matching the data-model convention). INTERVAL is emitted only
 * when > 1, mirroring the historical rrule.js serializer on this path.
 */
function serializeRrule(opts: {
  freq: RecurrenceFreq;
  byweekday?: Weekday[] | undefined;
  interval?: number | undefined;
  count?: number | undefined;
  /** Compact UNTIL value, e.g. "20260628T235959". */
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

/**
 * Compact UNTIL value ("YYYYMMDDTHHMMSS") from a Date's local wall-clock fields.
 * Floating, not UTC: the data model is timezone-naive, and RFC 5545 asks for a
 * floating UNTIL beside the floating DTSTART these rules anchor to.
 */
function untilFromLocalDate(d: Date, endOfDay: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = endOfDay
    ? "235959"
    : `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}T${time}`;
}

export function parseInput(raw: string, now?: Date): ParseResult {
  const ref = now ?? new Date();

  if (!raw || !raw.trim()) {
    return { input: { tags: [], title: "" }, type: "single" };
  }

  // --- -2. Body split: "buy a gift // she likes the blue one" ────────────────
  // Everything after the FIRST whitespace-delimited "//" is the page body, kept
  // verbatim: no tag, folder, date or cadence is read out of it, so a "#word" in
  // a note stays literal text. The separator has to sit on a whitespace boundary
  // (or a string edge) on both sides, which is what keeps "https://example.com"
  // a URL and a later "//" part of the body it belongs to.
  let content: string | undefined;
  let text = raw;
  const bodySplit = /(?:^|\s)\/\/(?:\s|$)/.exec(raw);
  if (bodySplit) {
    text = raw.slice(0, bodySplit.index);
    const body = raw.slice(bodySplit.index + bodySplit[0].length).trim();
    if (body) content = body;
  }

  // --- -1. Casual time-of-day mapping ───────────────────────────────────────
  // chrono sets a meridiem for "morning" / "afternoon" / "evening" / "night"
  // but not hour-certainty, so the parser's hasTime branch (which gates on
  // isCertain) skips them. Pre-rewrite to explicit clock times so chrono
  // reports certain hours and the parser produces a timed event. Times are
  // chosen for productivity defaults: morning=9am, afternoon=3pm, evening=6pm,
  // night=8pm. "tonight" maps to today 8pm.
  const CASUAL_TIME_OF_DAY: Record<string, { time: string; hour: number }> = {
    afternoon: { hour: 15, time: "3pm" },
    evening: { hour: 18, time: "6pm" },
    morning: { hour: 9, time: "9am" },
    night: { hour: 20, time: "8pm" },
  };
  // "tonight" → "today at 8pm" if still future, else "tomorrow at 8pm" so a
  // late-night quick-add doesn't schedule into the past.
  text = text.replace(/\btonight\b/gi, () => {
    return ref.getHours() < 20 ? "today at 8pm" : "tomorrow at 8pm";
  });
  // "<prefix> <period>" → "<prefix> at <time>" where prefix ∈ {today, tomorrow,
  // this, <weekday>}. For "this" / "today" the parser shifts to tomorrow when
  // the implied hour has already passed in `ref`; chrono can't make that call
  // because it doesn't know our productivity defaults.
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

  // --- -0.5. "last <weekday>" → concrete past date ───────────────────────────
  // chrono is invoked with forwardDate: true, which forces parsing into the
  // future. That's correct for "monday" / "next monday" but wrong for
  // "last monday", which becomes "next monday" without intervention. Resolve
  // the previous occurrence ourselves and substitute a concrete date string.
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

  // --- -0.4. Day-of-month phrases chrono can't parse on its own ──────────────
  // chrono parses "May 24" but not bare day-of-month forms: "on the 24th" /
  // "by the 1st", or weekday+number like "Sat 24". Resolve each to a concrete
  // "MMM d yyyy" date (forward-dated: this month, else the next month that has
  // the day) and substitute it so chrono can attach any trailing time and the
  // title-strip removes the whole phrase — connector word included.
  //
  // Day-of-month wins when a weekday name disagrees ("Sat 24" while the 24th is
  // a Sunday): the number is the specific signal, the weekday a loose hint, so
  // the weekday is dropped. Bare ordinals without a connector ("3rd draft",
  // "the 1st time") are intentionally left alone — too overloaded to treat as
  // dates safely.
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
  // "on/by [the] Nth" — calendar prepositions disambiguate the ordinal as a date.
  text = text.replace(
    /\b(?:on|by)\s+(?:the\s+)?(3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)\b/gi,
    (match, dayStr: string) => {
      const target = resolveDayOfMonth(parseInt(dayStr, 10));
      return target ? ` ${format(target, "MMM d yyyy")} ` : match;
    }
  );
  // "<weekday> N[th]" — e.g. "Sat 24", "fri 13th". Guard against a leading
  // "every" so recurrence phrases ("every friday …") aren't consumed here.
  text = text.replace(
    /(?<!\bevery\s)\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?\b/gi,
    (match, dayStr: string) => {
      const target = resolveDayOfMonth(parseInt(dayStr, 10));
      return target ? ` ${format(target, "MMM d yyyy")} ` : match;
    }
  );

  // --- 0. Normalize "<Month> <day> through/thru [<Month>] <day>" to "... to ...".
  // chrono handles "May 2 to 10" as a date range but mis-parses "May 2 through 10"
  // as the time range 2–10 (am). The window parser below consumes "through <word>"
  // for bounded recurrence, but bare "through <digit>" falls through to chrono.
  // Rewriting to "to" lets chrono emit the span we want, and leaves cadence uses
  // like "practice piano through june" / "every monday through april 30" alone.
  text = text.replace(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(st|nd|rd|th)?\s+(?:through|thru)\s+((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{1,2})(st|nd|rd|th)?\b/gi,
    (_, m1: string, d1: string, _s1: string | undefined, m2: string | undefined, d2: string) =>
      m2 ? `${m1} ${d1} to ${m2}${d2}` : `${m1} ${d1} to ${d2}`
  );

  // --- 1. Tags: #word ---
  const tags: string[] = [];
  text = text.replace(/#(\w+)/g, (_, tag: string) => {
    tags.push(tag);
    return " ";
  });

  // --- 2. Folder: ~word (last wins, mirrors priority semantics) ---
  let folderQuery: string | undefined;
  text = text.replace(/~(\w+)/g, (_, folder: string) => {
    folderQuery = folder;
    return " ";
  });

  // --- 3. Priority: !urgent !high !medium !low ---
  let priority: PagePriority | null | undefined;
  text = text.replace(/!(urgent|high|medium|low)\b/gi, (_, p: string) => {
    priority = p.toLowerCase() as PagePriority;
    return " ";
  });

  // Numeric priority: !0 (none/clear) through !4 (low)
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

  // --- 3.5. Reminders: "remind 30m before", "remind me the day before", "!r1h" ---
  // Extracted before chrono so a lead ("1d before") is never mistaken for the
  // event's own date, and stashed behind a placeholder rather than removed: a
  // reminder needs a schedule to anchor to, and whether one exists isn't known
  // until chrono has run. The placeholder is control characters only, so no rule
  // between here and the restore can match inside it.
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
    // A bare unit means one of it: "remind day before" is a one-day lead, which
    // the resolution step below turns into the all-day anchor when it can.
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
  // Phrase: "remind"/"reminder" + generous filler + a strict unit, with the
  // trailing "before" optional. Filler deliberately excludes "in", so
  // "remind me in 2 days" stays a date for chrono rather than becoming a lead.
  text = text.replace(
    new RegExp(
      `\\bremind(?:er)?s?\\b(?:\\s+(?:please|about|one|the|an|us|me|at|a))*\\s*(\\d+(?:\\.\\d+)?)?\\s*${REMINDER_UNIT}\\b(?:\\s+(?:beforehand|before|ahead|prior|early|in\\s+advance)\\b)?`,
      "gi"
    ),
    (match, num: string | undefined, unit: string) => stashReminder(match, num, unit)
  );

  // --- 4. Duration: for Xh, for Xmin, for X hours, for X minutes ---
  let durationMinutes: number | undefined;
  text = text.replace(
    /\bfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi,
    (_, num: string, unit: string) => {
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

  // --- 5. Finite window: for X weeks/days/months, X times, through <date> ---
  type WindowSpec =
    | { kind: "count"; count: number }
    | { kind: "until"; date: Date }
    | { kind: "days"; count: number };

  let windowSpec: WindowSpec | undefined;

  // "X times"
  text = text.replace(/\b(\d+)\s+times\b/gi, (_, n: string) => {
    windowSpec = { count: parseInt(n, 10), kind: "count" };
    return " ";
  });

  // "for X weeks/days/months"
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
        // months: approximate
        windowSpec = { count: count * 30, kind: "days" };
      }
      return " ";
    }
  );

  // "through <date>" / "until <date>" / "till <date>"
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

  // --- 6. Recurrence detection ---
  type RecurrenceSpec =
    | { kind: "infinite"; freq: RecurrenceFreq; byday?: Weekday[]; interval?: number }
    | { kind: "finite-slash"; days: Weekday[] }
    | { kind: "finite-weekdays" };

  let recurrenceSpec: RecurrenceSpec | undefined;

  // "every N <unit>" or "every other <unit>" — interval-based cadence.
  // Checked before "every <day>" so "every 2 weeks" / "every other day" match
  // here instead of falling through to the day-word regex.
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

  // "every other <weekday>" / "every N <weekday>(s)" — interval cadence
  // anchored to a specific weekday. Emits FREQ=WEEKLY;INTERVAL=N;BYDAY=...
  // Must run before the bare "every <weekday>" regex so "every other tuesday"
  // doesn't fall through and lose the interval.
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

  // "every <day>" or "every weekday/weekend/day/week/month/year" — handles
  // comma, "and", and Oxford comma separators:
  //   "every monday and wednesday", "every mon, wed, and fri"
  const DAY_WORD =
    "(?:weekday|weekend|day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)";
  const SEP = "(?:\\s*,\\s*|\\s+and\\s+|\\s*,\\s*and\\s+)"; // comma, "and", or ", and"
  // Negative lookahead (?!\/) so a slash-separated day list ("every mon/wed/fri")
  // is left intact for the slash-days rule below — otherwise this regex eats
  // "every mon" and strands "/wed/fri", collapsing an intended infinite rule
  // into a finite [Wed, Fri] series. Single-letter forms (m/w/f) never reach
  // here (DAY_WORD has no single letters), so this only matters for full/short
  // day names written with slashes.
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

  // "biweekly" / "fortnightly" → every 2 weeks. Must run before "weekly" so
  // the longer match wins.
  if (!recurrenceSpec) {
    text = text.replace(/\b(?:biweekly|fortnightly)\b/gi, () => {
      recurrenceSpec = { freq: "WEEKLY", interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // "bimonthly" → every 2 months. Must run before "monthly".
  if (!recurrenceSpec) {
    text = text.replace(/\bbimonthly\b/gi, () => {
      recurrenceSpec = { freq: "MONTHLY", interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // "daily", "weekly", "monthly", "yearly", "annually" — only consume if no
  // recurrence already found. Prevents stripping "daily" from
  // "daily standup every monday" where "every monday" is the specifier.
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

  // Slash-separated days: m/w/f, mon/wed/fri, t/th/f etc.
  // Must look like word/word patterns — no spaces.
  // A leading "every " OR a pre-existing infinite-weekly recurrenceSpec
  // promotes the day-list to BYDAY on an infinite rule; otherwise it's finite.
  const SLASH_DAY =
    "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su|m|t|w|f)";
  const slashDaysRe = new RegExp(`(\\bevery\\s+)?\\b((?:${SLASH_DAY}\\/)+${SLASH_DAY})\\b`, "gi");
  text = text.replace(slashDaysRe, (_, everyPrefix: string | undefined, slashStr: string) => {
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
    } else {
      recurrenceSpec = { days, kind: "finite-slash" };
    }
    return " ";
  });

  // Plural day names imply recurrence: "mondays", "on tuesdays and thursdays".
  // Augments an existing infinite-weekly-no-byday spec (e.g. "every week mondays").
  // Must run before bare "weekdays" and before chrono to avoid false date parsing.
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
      // Another recurrenceSpec already set (e.g. finite-slash); leave plural in title.
      return match;
    });
  }

  // bare "weekdays" (without "every")
  text = text.replace(/\bweekdays\b/gi, () => {
    if (!recurrenceSpec) {
      recurrenceSpec = { kind: "finite-weekdays" };
    }
    return " ";
  });

  // --- 7 & 8. Date and time (combined via chrono-node) ---
  // Replace @ prefix markers for chrono
  text = text.replace(/@(\S+)/g, (_, token: string) => token);

  let scheduledStart: string | undefined;
  let hasTime = false;
  // Captured from chrono's end component when a time range is parsed
  // (e.g. "3pm to 5pm"). Applied to scheduledEnd below.
  let chronoEnd: Date | undefined;
  // Captured when chrono parses a multi-day date range (e.g. "April 18-25",
  // "from Mon to Fri"). Applied to scheduledEnd as a date-only string. Only
  // used when the start is also date-only — multi-day timed ranges are
  // intentionally not supported (ambiguous semantics).
  let chronoEndDate: Date | undefined;

  const chronoResults = chrono.parse(text, ref, { forwardDate: true });
  if (chronoResults.length > 0) {
    const result = chronoResults[0]!;
    const parsed = result.date();

    if (result.end) {
      if (result.end.isCertain("hour") || result.end.isCertain("minute")) {
        chronoEnd = result.end.date();
      } else if (result.end.isCertain("day")) {
        chronoEndDate = result.end.date();
      }
    }

    hasTime = result.start.isCertain("hour") || result.start.isCertain("minute");

    // Bare weekday names ("monday", "this wednesday") are certain on "weekday" but not "day".
    const hasDate =
      result.start.isCertain("day") ||
      result.start.isCertain("month") ||
      result.start.isCertain("year") ||
      result.start.isCertain("weekday");

    if (hasTime && !hasDate) {
      // When recurrence specifies a weekday, anchor to the next occurrence of that
      // day instead of defaulting to today/tomorrow.
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
        // Time without date: today if future, tomorrow if past
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

    // Remove matched text from the string. chrono inconsistently includes a
    // leading connector in its match ("on friday" / "at 9am" get absorbed, but
    // "on May 24" / "by May 1" / "for tomorrow" / "from <date>" do not), so
    // extend the strip backward to swallow a dangling connector — otherwise it
    // leaks into the title.
    let consumeStart = result.index;
    const connectorPrefix = text.substring(0, result.index).match(/\b(?:from|on|at|by|for)\s+$/i);
    if (connectorPrefix) consumeStart -= connectorPrefix[0].length;
    text =
      text.substring(0, consumeStart) + " " + text.substring(result.index + result.text.length);
  }

  // When "every week" is used (FREQ=WEEKLY, no BYDAY) and chrono parsed a weekday,
  // inject BYDAY so the rrule is self-documenting ("every week on Monday" vs bare "every week").
  // Hoist into a local so noUncheckedIndexedAccess narrowing applies — the
  // length check alone doesn't narrow the element type.
  const firstChrono = chronoResults[0];
  if (
    recurrenceSpec?.kind === "infinite" &&
    recurrenceSpec.freq === "WEEKLY" &&
    !recurrenceSpec.byday &&
    firstChrono &&
    firstChrono.start.isCertain("weekday")
  ) {
    const jsDay = firstChrono.start.get("weekday");
    // chrono weekday: 0=Sun … 6=Sat → map to the rrule 0=Mon … 6=Sun index.
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

  // When recurrence has a byday but chrono found no date at all, anchor scheduledStart
  // to the next occurrence of the first specified weekday.
  if (
    !scheduledStart &&
    recurrenceSpec?.kind === "infinite" &&
    recurrenceSpec.byday &&
    recurrenceSpec.byday.length > 0
  ) {
    const target = nextWeekdayOccurrence(ref, recurrenceSpec.byday[0]!);
    scheduledStart = formatDateOnly(target);
  }

  // --- 8.5. Reminder resolution ---
  // Every reminder arm of the scheduler joins `page_schedules`, so a lead on an
  // unscheduled page could never fire: without a parsed schedule the words go
  // back into the title verbatim rather than turning into a row that never
  // rings. With one, the schedule's own shape decides what the row holds —
  // resolved here, not by the consumer, because this is where the shape is known:
  //   • all-day  → every lead collapses onto DAY_BEFORE_MINUTES, the single
  //     anchor such a page can carry (an all-day page has no start time to count
  //     minutes back from, which is why the reminder dropdown offers it one
  //     option too);
  //   • timed    → the minutes as typed, so "1d before" is a 1440-minute lead.
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

  // --- 9. Title: remaining text ---
  // Collapse runs of whitespace, then clean up punctuation orphans left
  // behind when inline tokens (#tag, !urgent, ~folder) were stripped:
  //   - sentence punct (".", "!", "?") at end-of-string keeps the punctuation
  //     but drops the whitespace gap before it: "call ." → "call.";
  //   - separator punct (",", ";", ":") at end-of-string is dropped entirely
  //     since it was acting as a token separator: "note ," → "note";
  //   - mid-string separator punct surrounded by whitespace is dropped too:
  //     "x , y" → "x y" (handles tag-list commas left over after strip).
  // Mid-word punctuation like "!5" stays — only whitespace-isolated orphans
  // are touched.
  const title = text
    .replace(/\s+/g, " ")
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
      // Compute scheduledEnd from explicit "for Xh" duration.
      const startDate = new Date(scheduledStart);
      if (!isNaN(startDate.getTime())) {
        baseInput.scheduledEnd = formatLocalISO(addMinutes(startDate, durationMinutes));
      }
    } else if (chronoEnd && hasTime) {
      // Time range ("3pm to 5pm") — apply end-time to the same date as start.
      // For ranges that cross midnight (e.g. "9pm to 5am"), the naive
      // same-day end is before the start; push it to the next day so the
      // duration is positive and the event reads correctly.
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
      // Multi-day all-day range ("April 18-25", "from Mon to Fri").
      // Only when start is date-only — multi-day timed events aren't supported.
      const endDateStr = formatDateOnly(chronoEndDate);
      if (endDateStr > scheduledStart) {
        baseInput.scheduledEnd = endDateStr;
      }
    }
  }

  // --- Determine result type ---

  // A window ("10 times", "for N weeks", "through <date>") without an explicit
  // cadence defaults to daily recurrence. Keeps the count/boundary signal the
  // user typed instead of silently stripping it from the title.
  if (windowSpec && !recurrenceSpec) {
    recurrenceSpec = { freq: "DAILY", kind: "infinite" };
  }

  const isInfiniteRec = recurrenceSpec?.kind === "infinite";

  // Bounded recurrence: "every X" + window → ONE recurring page with an RRULE
  // containing COUNT or UNTIL. Expansion happens virtually at render time.
  if (isInfiniteRec && windowSpec) {
    // `windowSpec` is narrowed by the if; alias keeps the inner branches readable.
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
      // UNTIL at end-of-day of the boundary date — matches buildRrule()
      // convention so parse→expand round-trips through the same rrule the
      // editor produces.
      let boundary: Date;
      if (win.kind === "until") {
        boundary = win.date;
      } else {
        const dtstart = scheduledStart
          ? new Date(isAllDayIso(scheduledStart) ? scheduledStart + "T00:00:00" : scheduledStart)
          : ref;
        boundary = addDays(dtstart, win.count - 1);
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
    // Finite recurrence (finite-slash or finite-weekdays): emits N concrete
    // pages, one per expanded date. Only reached when the user didn't use
    // "every" — bare "m/w/f" or bare "weekdays".
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
      // Arrays are copied, not shared: each page owns its own tags and reminders,
      // so a later per-page edit can't reach into its siblings.
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
    // No DTSTART — the data model stores RRULE without it (the anchor lives
    // on the page), matching buildRrule()'s convention.
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

  // Single
  return { input: baseInput, type: "single" };
}
