import * as chrono from "chrono-node";
import { RRule, Weekday } from "rrule";

export type PagePriority = "urgent" | "high" | "medium" | "low";

export interface ParsedInput {
  title: string;
  scheduledStart?: string; // ISO 8601 — date-only ("2026-03-16") or datetime ("2026-03-16T15:00:00")
  scheduledEnd?: string; // ISO 8601 datetime, derived from start + duration
  durationMinutes?: number;
  tags: string[];
  folderQuery?: string;
  priority?: PagePriority;
}

export type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string };

// Day abbreviation map
const DAY_MAP: Record<string, Weekday> = {
  m: RRule.MO,
  mo: RRule.MO,
  mon: RRule.MO,
  monday: RRule.MO,
  t: RRule.TU,
  tu: RRule.TU,
  tue: RRule.TU,
  tues: RRule.TU,
  tuesday: RRule.TU,
  w: RRule.WE,
  we: RRule.WE,
  wed: RRule.WE,
  wednesday: RRule.WE,
  th: RRule.TH,
  thu: RRule.TH,
  thur: RRule.TH,
  thurs: RRule.TH,
  thursday: RRule.TH,
  f: RRule.FR,
  fr: RRule.FR,
  fri: RRule.FR,
  friday: RRule.FR,
  sa: RRule.SA,
  sat: RRule.SA,
  saturday: RRule.SA,
  su: RRule.SU,
  sun: RRule.SU,
  sunday: RRule.SU,
};

const WEEKDAY_DAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR];

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function formatDateTime(d: Date): string {
  const base = formatDateOnly(d);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${base}T${h}:${m}:${s}`;
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function parseInput(raw: string, now?: Date): ParseResult {
  const ref = now ?? new Date();

  if (!raw || !raw.trim()) {
    return { type: "single", input: { title: "", tags: [] } };
  }

  let text = raw;

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
  let priority: PagePriority | undefined;
  text = text.replace(/!(urgent|high|medium|low)\b/gi, (_, p: string) => {
    priority = p.toLowerCase() as PagePriority;
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
    windowSpec = { kind: "count", count: parseInt(n, 10) };
    return " ";
  });

  // "for X weeks/days/months"
  text = text.replace(
    /\bfor\s+(\d+)\s*(day|days|week|weeks|month|months)\b/gi,
    (_, n: string, unit: string) => {
      const count = parseInt(n, 10);
      const u = unit.toLowerCase();
      if (u === "day" || u === "days") {
        windowSpec = { kind: "days", count };
      } else if (u === "week" || u === "weeks") {
        windowSpec = { kind: "days", count: count * 7 };
      } else {
        // months: approximate
        windowSpec = { kind: "days", count: count * 30 };
      }
      return " ";
    }
  );

  // "through <date>"
  text = text.replace(/\bthrough\s+([a-z]+\s*\d*(?:st|nd|rd|th)?)/gi, (match, dateStr: string) => {
    const parsed = chrono.parseDate(dateStr, ref);
    if (parsed) {
      windowSpec = { kind: "until", date: parsed };
      return " ";
    }
    return match;
  });

  // --- 6. Recurrence detection ---
  type RecurrenceSpec =
    | { kind: "infinite"; freq: number; byday?: Weekday[] }
    | { kind: "finite-slash"; days: Weekday[] }
    | { kind: "finite-weekdays" };

  let recurrenceSpec: RecurrenceSpec | undefined;

  // "every <day>" or "every weekday" — highest priority, checked first
  text = text.replace(
    /\bevery\s+(weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)\b/gi,
    (_, dayStr: string) => {
      const d = dayStr.toLowerCase();
      if (d === "weekday") {
        recurrenceSpec = { kind: "infinite", freq: RRule.WEEKLY, byday: WEEKDAY_DAYS };
      } else if (DAY_MAP[d]) {
        recurrenceSpec = { kind: "infinite", freq: RRule.WEEKLY, byday: [DAY_MAP[d]] };
      }
      return " ";
    }
  );

  // "daily", "weekly", "monthly" — only consume if no recurrence already found
  // This prevents stripping "daily" from "daily standup every monday" where "every monday" is the specifier
  if (!recurrenceSpec) {
    text = text.replace(/\bdaily\b/gi, () => {
      recurrenceSpec = { kind: "infinite", freq: RRule.DAILY };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bweekly\b/gi, () => {
      recurrenceSpec = { kind: "infinite", freq: RRule.WEEKLY };
      return " ";
    });
  }

  if (!recurrenceSpec) {
    text = text.replace(/\bmonthly\b/gi, () => {
      recurrenceSpec = { kind: "infinite", freq: RRule.MONTHLY };
      return " ";
    });
  }

  // Slash-separated days: m/w/f, mon/wed/fri, t/th/f etc.
  // Must look like word/word patterns — no spaces
  text = text.replace(
    /\b((?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su|m|t|w|f)\/)+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su|m|t|w|f))\b/gi,
    (match) => {
      const parts = match.toLowerCase().split("/");
      const days: Weekday[] = [];
      for (const part of parts) {
        const day = DAY_MAP[part];
        if (day) days.push(day);
      }
      if (days.length > 0) {
        recurrenceSpec = { kind: "finite-slash", days };
      }
      return " ";
    }
  );

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

  // Use chrono to parse any remaining date/time
  const chronoResults = chrono.parse(text, ref, { forwardDate: true });
  if (chronoResults.length > 0) {
    const result = chronoResults[0]!;
    const parsed = result.date();

    // Check if a time component was explicitly set
    hasTime = result.start.isCertain("hour") || result.start.isCertain("minute");

    // Check if date is explicitly set
    const hasDate =
      result.start.isCertain("day") ||
      result.start.isCertain("month") ||
      result.start.isCertain("year");

    if (hasTime && !hasDate) {
      // Time without date: today if future, tomorrow if past
      const todayWithTime = new Date(ref);
      todayWithTime.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0);
      if (todayWithTime <= ref) {
        todayWithTime.setDate(todayWithTime.getDate() + 1);
      }
      scheduledStart = formatDateTime(todayWithTime);
    } else if (hasDate && hasTime) {
      scheduledStart = formatDateTime(parsed);
    } else if (hasDate) {
      scheduledStart = formatDateOnly(parsed);
    }

    // Remove matched text from the string
    text =
      text.substring(0, result.index) + " " + text.substring(result.index + result.text.length);
  }

  // --- 9. Title: remaining text ---
  const title = text.replace(/\s+/g, " ").trim();

  // Build base ParsedInput
  const baseInput: ParsedInput = {
    title,
    tags,
    ...(folderQuery !== undefined && { folderQuery }),
    ...(priority !== undefined && { priority }),
    ...(durationMinutes !== undefined && { durationMinutes }),
  };

  if (scheduledStart !== undefined) {
    baseInput.scheduledStart = scheduledStart;

    if (durationMinutes !== undefined && hasTime) {
      // Compute scheduledEnd only when we have a full datetime
      const startDate = new Date(scheduledStart);
      if (!isNaN(startDate.getTime())) {
        baseInput.scheduledEnd = formatDateTime(addMinutes(startDate, durationMinutes));
      }
    }
  }

  // --- Determine result type ---

  // If "every X" + finite window → treat as finite
  const isInfiniteRec = recurrenceSpec?.kind === "infinite";
  const hasWindow = windowSpec !== undefined;

  if (recurrenceSpec && (!isInfiniteRec || hasWindow)) {
    // Finite recurrence
    let days: Weekday[];
    if (recurrenceSpec.kind === "finite-weekdays") {
      days = WEEKDAY_DAYS;
    } else if (recurrenceSpec.kind === "finite-slash") {
      days = recurrenceSpec.days;
    } else {
      // infinite converted to finite by window
      days = recurrenceSpec.byday ?? WEEKDAY_DAYS;
    }

    // Determine window start: explicit date or now
    const windowStart = scheduledStart
      ? new Date(scheduledStart.length === 10 ? scheduledStart + "T00:00:00" : scheduledStart)
      : ref;

    // Build RRule options
    const rruleOpts: ConstructorParameters<typeof RRule>[0] = {
      freq: RRule.WEEKLY,
      byweekday: days,
      dtstart: windowStart,
    };

    if (windowSpec) {
      if (windowSpec.kind === "count") {
        rruleOpts.count = windowSpec.count;
      } else if (windowSpec.kind === "until") {
        rruleOpts.until = windowSpec.date;
      } else if (windowSpec.kind === "days") {
        const untilDate = new Date(windowStart);
        untilDate.setDate(untilDate.getDate() + windowSpec.count - 1);
        rruleOpts.until = untilDate;
      }
    } else {
      // No window: default behavior
      if (recurrenceSpec.kind === "finite-weekdays") {
        rruleOpts.count = 5; // next 5 weekdays
      } else if (recurrenceSpec.kind === "finite-slash") {
        // Next single occurrence of each day = count of days
        rruleOpts.count = days.length;
      } else {
        // "every X for N weeks" already handled above
        rruleOpts.count = days.length;
      }
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
        const dated = new Date(d);
        dated.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
        inp.scheduledStart = formatDateTime(dated);
        if (durationMinutes !== undefined) {
          inp.scheduledEnd = formatDateTime(addMinutes(dated, durationMinutes));
        }
      } else {
        inp.scheduledStart = formatDateOnly(d);
        delete inp.scheduledEnd;
      }

      return inp;
    });

    return { type: "finite", inputs, count: inputs.length };
  }

  if (isInfiniteRec && !hasWindow) {
    const spec = recurrenceSpec as { kind: "infinite"; freq: number; byday?: Weekday[] };
    const rruleOpts: ConstructorParameters<typeof RRule>[0] = {
      freq: spec.freq,
    };
    if (spec.byday) {
      rruleOpts.byweekday = spec.byday;
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
      type: "recurring",
      input: baseInput,
      rrule: rruleStr,
    };
  }

  // Single
  return { type: "single", input: baseInput };
}
