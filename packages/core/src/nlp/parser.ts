import * as chrono from "chrono-node";
import { addDays, addMinutes, differenceInMinutes, set } from "date-fns";
import { RRule, Weekday } from "rrule";

import { formatDateOnly, formatLocalISO } from "../utils/dates";

export type PagePriority = "urgent" | "high" | "medium" | "low";

export interface ParsedInput {
  title: string;
  scheduledStart?: string; // ISO 8601 — date-only ("2026-03-16") or datetime ("2026-03-16T15:00:00")
  scheduledEnd?: string; // ISO 8601 datetime, derived from start + duration
  durationMinutes?: number;
  tags: string[];
  folderQuery?: string;
  priority?: PagePriority | null; // null = explicitly cleared (!0); undefined = not mentioned
}

export type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string };

// Day abbreviation map
const DAY_MAP: Record<string, Weekday> = {
  f: RRule.FR,
  fr: RRule.FR,
  fri: RRule.FR,
  friday: RRule.FR,
  m: RRule.MO,
  mo: RRule.MO,
  mon: RRule.MO,
  monday: RRule.MO,
  sa: RRule.SA,
  sat: RRule.SA,
  saturday: RRule.SA,
  su: RRule.SU,
  sun: RRule.SU,
  sunday: RRule.SU,
  t: RRule.TU,
  th: RRule.TH,
  thu: RRule.TH,
  thur: RRule.TH,
  thurs: RRule.TH,
  thursday: RRule.TH,
  tu: RRule.TU,
  tue: RRule.TU,
  tues: RRule.TU,
  tuesday: RRule.TU,
  w: RRule.WE,
  we: RRule.WE,
  wed: RRule.WE,
  wednesday: RRule.WE,
};

const WEEKDAY_DAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR];
const WEEKEND_DAYS = [RRule.SA, RRule.SU];

/** Map RRule weekday (0=MO … 6=SU) to JS Date.getDay() (0=SU … 6=SA). */
const RRULE_TO_JS_DAY: Record<number, number> = {
  0: 1, // MO
  1: 2, // TU
  2: 3, // WE
  3: 4, // TH
  4: 5, // FR
  5: 6, // SA
  6: 0, // SU
};

/** Returns the next occurrence of an RRule Weekday on or after `ref`. */
function nextWeekdayOccurrence(ref: Date, weekday: Weekday): Date {
  const targetJsDay = RRULE_TO_JS_DAY[weekday.weekday]!;
  const current = ref.getDay();
  let daysAhead = targetJsDay - current;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0) daysAhead = 7; // same day → next week (consistent with chrono "monday" behavior)
  return addDays(ref, daysAhead);
}

export function parseInput(raw: string, now?: Date): ParseResult {
  const ref = now ?? new Date();

  if (!raw || !raw.trim()) {
    return { input: { tags: [], title: "" }, type: "single" };
  }

  let text = raw;

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

  // --- 2. Folder: ~word ---
  let folderQuery: string | undefined;
  text = text.replace(/~(\w+)/g, (_, folder: string) => {
    if (folderQuery === undefined) folderQuery = folder;
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
    | { kind: "infinite"; freq: number; byday?: Weekday[]; interval?: number }
    | { kind: "finite-slash"; days: Weekday[] }
    | { kind: "finite-weekdays" };

  let recurrenceSpec: RecurrenceSpec | undefined;

  // "every N <unit>" or "every other <unit>" — interval-based cadence.
  // Checked before "every <day>" so "every 2 weeks" / "every other day" match
  // here instead of falling through to the day-word regex.
  const INTERVAL_UNIT_FREQ: Record<string, number> = {
    day: RRule.DAILY,
    month: RRule.MONTHLY,
    week: RRule.WEEKLY,
    year: RRule.YEARLY,
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

  // "every <day>" or "every weekday/weekend/day/week/month/year" — handles
  // comma, "and", and Oxford comma separators:
  //   "every monday and wednesday", "every mon, wed, and fri"
  const DAY_WORD =
    "(?:weekday|weekend|day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)";
  const SEP = "(?:\\s*,\\s*|\\s+and\\s+|\\s*,\\s*and\\s+)"; // comma, "and", or ", and"
  const everyDayRe = new RegExp(`\\bevery\\s+(${DAY_WORD}(?:${SEP}${DAY_WORD})*)\\b`, "gi");
  text = text.replace(everyDayRe, (_, dayStr: string) => {
    const parts = dayStr.toLowerCase().split(/\s*,?\s*and\s+|\s*,\s*/);
    const allDays: Weekday[] = [];
    let freq: number | undefined;
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      if (p === "day") {
        freq = RRule.DAILY;
      } else if (p === "week") {
        freq = RRule.WEEKLY;
      } else if (p === "month") {
        freq = RRule.MONTHLY;
      } else if (p === "year") {
        freq = RRule.YEARLY;
      } else if (p === "weekday") {
        allDays.push(...WEEKDAY_DAYS);
      } else if (p === "weekend") {
        allDays.push(...WEEKEND_DAYS);
      } else if (DAY_MAP[p]) {
        allDays.push(DAY_MAP[p]);
      }
    }
    if (freq !== undefined) {
      recurrenceSpec = { freq, kind: "infinite" };
    } else if (allDays.length > 0) {
      recurrenceSpec = { byday: allDays, freq: RRule.WEEKLY, kind: "infinite" };
    }
    return " ";
  });

  // "biweekly" / "fortnightly" → every 2 weeks. Must run before "weekly" so
  // the longer match wins.
  if (!recurrenceSpec) {
    text = text.replace(/\b(?:biweekly|fortnightly)\b/gi, () => {
      recurrenceSpec = { freq: RRule.WEEKLY, interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // "bimonthly" → every 2 months. Must run before "monthly".
  if (!recurrenceSpec) {
    text = text.replace(/\bbimonthly\b/gi, () => {
      recurrenceSpec = { freq: RRule.MONTHLY, interval: 2, kind: "infinite" };
      return " ";
    });
  }

  // "daily", "weekly", "monthly", "yearly", "annually" — only consume if no
  // recurrence already found. Prevents stripping "daily" from
  // "daily standup every monday" where "every monday" is the specifier.
  if (!recurrenceSpec) {
    text = text.replace(/\bdaily\b/gi, () => {
      recurrenceSpec = { freq: RRule.DAILY, kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bweekly\b/gi, () => {
      recurrenceSpec = { freq: RRule.WEEKLY, kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bmonthly\b/gi, () => {
      recurrenceSpec = { freq: RRule.MONTHLY, kind: "infinite" };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\b(?:yearly|annually)\b/gi, () => {
      recurrenceSpec = { freq: RRule.YEARLY, kind: "infinite" };
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
      if (day) days.push(day);
    }
    if (days.length === 0) return " ";

    const isInfiniteWeeklyNoByday =
      recurrenceSpec?.kind === "infinite" &&
      recurrenceSpec.freq === (RRule.WEEKLY as number) &&
      !recurrenceSpec.byday;

    if (everyPrefix || isInfiniteWeeklyNoByday) {
      recurrenceSpec = { byday: days, freq: RRule.WEEKLY, kind: "infinite" };
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
        if (singular && DAY_MAP[singular]) {
          days.push(DAY_MAP[singular]);
        }
      }
      if (days.length === 0) return match;

      const isInfiniteWeeklyNoByday =
        recurrenceSpec?.kind === "infinite" &&
        recurrenceSpec.freq === (RRule.WEEKLY as number) &&
        !recurrenceSpec.byday;

      if (!recurrenceSpec || isInfiniteWeeklyNoByday) {
        recurrenceSpec = { byday: days, freq: RRule.WEEKLY, kind: "infinite" };
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

  // Use chrono to parse any remaining date/time
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

    // Check if a time component was explicitly set
    hasTime = result.start.isCertain("hour") || result.start.isCertain("minute");

    // Check if date is explicitly set.
    // bare weekday names ("monday", "this wednesday") are certain on "weekday" but not "day"
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

    // Remove matched text from the string
    text =
      text.substring(0, result.index) + " " + text.substring(result.index + result.text.length);
  }

  // When "every week" is used (FREQ=WEEKLY, no BYDAY) and chrono parsed a weekday,
  // inject BYDAY so the rrule is self-documenting ("every week on Monday" vs bare "every week").
  if (
    recurrenceSpec?.kind === "infinite" &&
    recurrenceSpec.freq === (RRule.WEEKLY as number) &&
    !recurrenceSpec.byday &&
    chronoResults.length > 0 &&
    chronoResults[0]!.start.isCertain("weekday")
  ) {
    const jsDay = chronoResults[0]!.start.get("weekday");
    // chrono weekday: 0=Sun … 6=Sat → map to RRule Weekday
    const JS_TO_RRULE: Record<number, Weekday> = {
      0: RRule.SU,
      1: RRule.MO,
      2: RRule.TU,
      3: RRule.WE,
      4: RRule.TH,
      5: RRule.FR,
      6: RRule.SA,
    };
    if (jsDay !== undefined && jsDay !== null && JS_TO_RRULE[jsDay]) {
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

  // --- 9. Title: remaining text ---
  const title = text.replace(/\s+/g, " ").trim();

  // Build base ParsedInput
  const baseInput: ParsedInput = {
    tags,
    title,
    ...(folderQuery !== undefined && { folderQuery }),
    ...(priority !== undefined && { priority }),
    ...(durationMinutes !== undefined && { durationMinutes }),
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
      const startDate = new Date(scheduledStart);
      if (!isNaN(startDate.getTime())) {
        const endDate = set(startDate, {
          hours: chronoEnd.getHours(),
          milliseconds: 0,
          minutes: chronoEnd.getMinutes(),
          seconds: 0,
        });
        baseInput.scheduledEnd = formatLocalISO(endDate);
        const derivedMinutes = differenceInMinutes(endDate, startDate);
        if (derivedMinutes > 0) {
          baseInput.durationMinutes = derivedMinutes;
        }
      }
    } else if (chronoEndDate && !hasTime && !scheduledStart.includes("T")) {
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
    recurrenceSpec = { freq: RRule.DAILY, kind: "infinite" };
  }

  const isInfiniteRec = recurrenceSpec?.kind === "infinite";
  const hasWindow = windowSpec !== undefined;

  // Bounded recurrence: "every X" + window → ONE recurring page with an RRULE
  // containing COUNT or UNTIL. Expansion happens virtually at render time.
  if (isInfiniteRec && hasWindow) {
    const spec = recurrenceSpec as {
      kind: "infinite";
      freq: number;
      byday?: Weekday[];
      interval?: number;
    };
    const rruleOpts: ConstructorParameters<typeof RRule>[0] = { freq: spec.freq };
    if (spec.byday) rruleOpts.byweekday = spec.byday;
    if (spec.interval && spec.interval > 1) rruleOpts.interval = spec.interval;

    if (windowSpec!.kind === "count") {
      rruleOpts.count = windowSpec!.count;
    } else {
      // UNTIL at end-of-day UTC of the boundary date — matches buildRrule()
      // convention so parse→expand round-trips through the same rrule the
      // editor produces.
      let boundary: Date;
      if (windowSpec!.kind === "until") {
        boundary = windowSpec!.date;
      } else {
        const dtstart = scheduledStart
          ? new Date(scheduledStart.length === 10 ? scheduledStart + "T00:00:00" : scheduledStart)
          : ref;
        boundary = addDays(dtstart, windowSpec!.count - 1);
      }
      rruleOpts.until = new Date(
        Date.UTC(boundary.getFullYear(), boundary.getMonth(), boundary.getDate(), 23, 59, 59)
      );
    }

    const rule = new RRule(rruleOpts);
    const rruleStr = rule
      .toString()
      .split("\n")
      .filter((line) => !line.startsWith("DTSTART"))
      .join("\n")
      .replace(/^RRULE:/, "");

    return { input: baseInput, rrule: rruleStr, type: "recurring" };
  }

  if (recurrenceSpec && recurrenceSpec.kind !== "infinite") {
    // Finite recurrence (finite-slash or finite-weekdays): emits N concrete
    // pages, one per expanded date. Only reached when the user didn't use
    // "every" — bare "m/w/f" or bare "weekdays".
    const days = recurrenceSpec.kind === "finite-weekdays" ? WEEKDAY_DAYS : recurrenceSpec.days;

    const windowStart = scheduledStart
      ? new Date(scheduledStart.length === 10 ? scheduledStart + "T00:00:00" : scheduledStart)
      : ref;

    const rruleOpts: ConstructorParameters<typeof RRule>[0] = {
      byweekday: days,
      dtstart: windowStart,
      freq: RRule.WEEKLY,
    };

    if (windowSpec) {
      if (windowSpec.kind === "count") {
        rruleOpts.count = windowSpec.count;
      } else if (windowSpec.kind === "until") {
        rruleOpts.until = windowSpec.date;
      } else {
        rruleOpts.until = addDays(windowStart, windowSpec.count - 1);
      }
    } else if (recurrenceSpec.kind === "finite-weekdays") {
      rruleOpts.count = 5;
    } else {
      rruleOpts.count = days.length;
    }

    const rule = new RRule(rruleOpts);
    const dates = rule.all();

    const inputs: ParsedInput[] = dates.map((d) => {
      const inp: ParsedInput = {
        ...baseInput,
        tags: [...tags],
      };

      if (hasTime && scheduledStart) {
        // Preserve the time component from scheduledStart
        const startDate = new Date(
          scheduledStart.length === 10 ? scheduledStart + "T00:00:00" : scheduledStart
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

  if (isInfiniteRec && !hasWindow) {
    const spec = recurrenceSpec as {
      kind: "infinite";
      freq: number;
      byday?: Weekday[];
      interval?: number;
    };
    const rruleOpts: ConstructorParameters<typeof RRule>[0] = {
      freq: spec.freq,
    };
    if (spec.byday) {
      rruleOpts.byweekday = spec.byday;
    }
    if (spec.interval && spec.interval > 1) {
      rruleOpts.interval = spec.interval;
    }

    const rule = new RRule(rruleOpts);
    // Remove DTSTART from the string
    const rruleStr = rule
      .toString()
      .split("\n")
      .filter((line) => !line.startsWith("DTSTART"))
      .join("\n")
      .replace(/^RRULE:/, "");

    return {
      input: baseInput,
      rrule: rruleStr,
      type: "recurring",
    };
  }

  // Single
  return { input: baseInput, type: "single" };
}
