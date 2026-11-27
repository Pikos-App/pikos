import { describe, expect, it } from "vitest";

import { parseRrule, rruleToShortLabel } from "../utils/recurrence";
import { parseInput } from "./parser";
import { assertCase, forAll, type ParserCase } from "./parser.testHelpers";

const NOW = new Date("2026-03-15T12:00:00");

/** Tabular runner that fixes the suite NOW. Use as `runCase({...})` inside an it.each. */
const runCase = (c: ParserCase) => assertCase(c, NOW);

describe("NL Page Creation Parser", () => {
  describe("single page creation", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 60,
            folderQuery: "Projects",
            scheduledEnd: "2026-03-16T15:00:00",
            scheduledStart: "2026-03-16T14:00:00",
            tags: ["work"],
            title: "team meeting",
          },
          type: "single",
        },
        input: "team meeting @tomorrow at 2pm for 1h #work ~Projects",
      },
      { expected: { input: { title: "" }, type: "single" }, input: "" },
      { expected: { input: { title: "" }, type: "single" }, input: "   " },
      {
        expected: {
          input: {
            priority: "high",
            tags: ["design", "ux"],
            title: "brainstorm",
          },
          type: "single",
        },
        input: "brainstorm !high #design #ux",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00", title: "standup" },
          type: "single",
        },
        input: "standup @monday 9am",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15" }, type: "single" },
        input: "lunch @today",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20T15:30:00" }, type: "single" },
        input: "call @march20 at 3:30pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T15:30:00" }, type: "single" },
        input: "meeting at 3:30pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 14:00",
      },
      {
        expected: {
          input: { tags: [], title: "quick note" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "quick note",
      },
      // chrono-node may or may not parse "march5" without a space.
      // Known limitation: prefer "@march 5" or "@mar 5".
      {
        expected: {
          custom: (r) => {
            if (r.input.scheduledStart !== undefined) {
              expect(r.input.scheduledStart).toContain("03-05");
            } else {
              expect(r.input.title).toContain("march5");
            }
          },
          type: "single",
        },
        input: "call @march5",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("priority and folder edge cases", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { priority: "low" }, type: "single" },
        input: "task !urgent !low",
      },
      {
        expected: { input: { folderQuery: "Archive" }, type: "single" },
        input: "task ~Projects ~Archive",
      },
      {
        expected: { input: { folderQuery: "C" }, type: "single" },
        input: "task ~A ~B ~C",
      },
      {
        expected: { input: { priority: "high", title: "" }, type: "single" },
        input: "!high",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("numeric priority shortcuts (!0-4)", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { priority: "urgent", title: "task" }, type: "single" },
        input: "task !1",
      },
      { expected: { input: { priority: "high" }, type: "single" }, input: "task !2" },
      { expected: { input: { priority: "medium" }, type: "single" }, input: "task !3" },
      { expected: { input: { priority: "low" }, type: "single" }, input: "task !4" },
      { expected: { input: { priority: null }, type: "single" }, input: "task !0" },
      { expected: { input: { priority: "medium" }, type: "single" }, input: "task !1 !3" },
      // "!5" stays in the title: toMatchObject can't assert "priority absent".
      { expected: { input: { title: "task !5" }, type: "single" }, input: "task !5" },
      { expected: { input: { priority: "urgent" }, type: "single" }, input: "task !urgent" },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("time without date", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 2pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T08:00:00" }, type: "single" },
        input: "meeting 8am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("duration parsing", () => {
    const cases: ParserCase[] = [
      { expected: { input: { durationMinutes: 120 }, type: "single" }, input: "focus for 2h" },
      { expected: { input: { durationMinutes: 15 }, type: "single" }, input: "break for 15min" },
      {
        expected: { input: { durationMinutes: 90 }, type: "single" },
        input: "deep work for 1.5 hours",
      },
      { expected: { input: { durationMinutes: 30 }, type: "single" }, input: "task for 30m" },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("finite recurrence", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          count: 3,
          inputs: [
            { durationMinutes: 45, scheduledStart: "2026-03-16T15:00:00" },
            { scheduledStart: "2026-03-18T15:00:00" },
            { scheduledStart: "2026-03-20T15:00:00" },
          ],
          type: "finite",
        },
        input: "run m/w/f at 3pm for 45m",
      },
      {
        expected: {
          count: 7,
          inputs: [
            { scheduledStart: "2026-03-16" },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { scheduledStart: "2026-03-30" },
          ],
          type: "finite",
        },
        input: "gym m/w/f for 1h through march 31",
      },
      {
        expected: {
          count: 3,
          inputs: [
            { scheduledStart: "2026-03-16T09:00:00" }, // Mon
            { scheduledStart: "2026-03-17T09:00:00" }, // Tue
            { scheduledStart: "2026-03-18T09:00:00" }, // Wed
          ],
          type: "finite",
        },
        input: "review sprint weekdays at 9am 3 times",
      },
      {
        expected: {
          count: 5,
          inputs: [
            { scheduledStart: "2026-03-16" },
            undefined,
            undefined,
            undefined,
            { scheduledStart: "2026-03-20" },
          ],
          type: "finite",
        },
        input: "standup weekdays",
      },
      {
        expected: {
          count: 3,
          inputs: [
            { scheduledStart: "2026-03-17T15:00:00" },
            { scheduledStart: "2026-03-19T15:00:00" },
            { scheduledStart: "2026-03-20T15:00:00" },
          ],
          type: "finite",
        },
        input: "run t/th/f at 3pm",
      },
      {
        expected: {
          count: 2,
          inputs: [{ scheduledStart: "2026-03-16" }, { scheduledStart: "2026-03-18" }],
          type: "finite",
        },
        input: "task m/w/f through march 19",
      },
      {
        expected: {
          count: 3,
          custom: (r) => {
            for (const inp of r.inputs) {
              expect(inp.scheduledEnd).toBeDefined();
              expect(inp.scheduledEnd).toContain("16:30");
            }
          },
          eachInput: { durationMinutes: 90 },
          type: "finite",
        },
        input: "run m/w/f at 3pm for 1.5 hours",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("finite recurrence shared properties", () => {
    it.each<ParserCase>([
      {
        expected: {
          count: 3,
          eachInput: {
            durationMinutes: 45,
            folderQuery: "Health",
            tags: ["fitness"],
            title: "run",
          },
          type: "finite",
        },
        input: "run m/w/f at 3pm for 45m #fitness ~Health",
      },
    ])("$input", runCase);
  });

  describe("infinite recurrence", () => {
    const WED = new Date("2026-03-18T12:00:00");
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 15,
            scheduledStart: "2026-03-16T13:00:00",
            title: "daily standup",
          },
          rrule: ["FREQ=WEEKLY", "BYDAY=MO"],
          type: "recurring",
        },
        input: "daily standup every monday 1pm for 15m",
      },
      {
        expected: { rrule: ["FREQ=DAILY"], type: "recurring" },
        input: "morning run daily at 7am for 30m",
      },
      {
        expected: { rrule: ["BYDAY=MO,TU,WE,TH,FR"], type: "recurring" },
        input: "every weekday",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "BYDAY=FR"], type: "recurring" },
        input: "sync every friday at 4pm",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "standup every monday at 9am",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-23T09:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am",
        now: WED,
      },
      {
        expected: { rrule: ["FREQ=DAILY"], type: "recurring" },
        input: "standup every day at 9am",
      },
      {
        expected: { rrule: ["BYDAY=SA,SU"], type: "recurring" },
        input: "relax every weekend",
      },
      {
        expected: { rrule: ["BYDAY=MO,WE,FR"], type: "recurring" },
        input: "standup every monday, wednesday, friday at 9am",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["FREQ=WEEKLY", "BYDAY=MO"],
          type: "recurring",
        },
        input: "standup monday 9am every week",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "run every monday",
      },
      {
        expected: { rrule: ["FREQ=MONTHLY"], type: "recurring" },
        input: "report every month",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring word order variations", () => {
    // Every variation yields the same recurring WEEKLY;BYDAY=MO rule, whatever case the title keeps.
    const cases: ParserCase[] = [
      "standup every monday at 9am",
      "standup at 9am every monday",
      "every monday standup at 9am",
      "every monday at 9am standup",
      "standup every mon at 9am",
      "standup every Monday at 9am",
      "STANDUP EVERY MONDAY AT 9AM",
    ].map((input) => ({
      expected: {
        input: { scheduledStart: "2026-03-16T09:00:00" },
        inputMatches: { title: /^standup$/i },
        rrule: ["FREQ=WEEKLY", "BYDAY=MO"],
        type: "recurring",
      },
      input,
    }));
    it.each(cases)("$input", runCase);
  });

  describe("recurring with 'and' separator", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "gym" },
          rrule: ["BYDAY=TU,TH"],
          type: "recurring",
        },
        input: "gym every tuesday and thursday at 6pm",
      },
      {
        expected: { rrule: ["BYDAY=TU,TH"], type: "recurring" },
        input: "gym every tue and thu at 6pm",
      },
      {
        expected: { rrule: ["BYDAY=MO,WE,FR"], type: "recurring" },
        input: "standup every mon, wed, and fri at 9am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring via plural day names", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "standup mondays at 9am",
      },
      {
        expected: { rrule: ["BYDAY=TU,TH"], type: "recurring" },
        input: "gym tuesdays and thursdays at 6pm",
      },
      {
        expected: { rrule: ["BYDAY=MO"], type: "recurring" },
        input: "standup on mondays at 9am",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-20" },
          rrule: ["BYDAY=FR"],
          type: "recurring",
        },
        input: "review fridays",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring with duration", () => {
    const TUE_MORN = new Date("2026-03-16T08:00:00");
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 30,
            scheduledEnd: "2026-03-16T09:30:00",
          },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am for 30m",
      },
      {
        expected: {
          input: { durationMinutes: 15 },
          rrule: ["FREQ=DAILY"],
          type: "recurring",
        },
        input: "daily standup at 9am for 15m",
        now: TUE_MORN,
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring with metadata", () => {
    it.each<ParserCase>([
      {
        expected: {
          input: {
            folderQuery: "Engineering",
            priority: "high",
            tags: ["work"],
            title: "standup",
          },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am #work !high ~Engineering",
      },
    ])("$input", runCase);
  });

  describe("recurring title cleanliness", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "daily standup" },
          rrule: [],
          type: "recurring",
        },
        input: "daily standup every monday at 9am",
      },
      {
        expected: {
          input: { title: "team sync" },
          rrule: [],
          type: "recurring",
        },
        input: "team sync every friday at 4pm",
      },
      {
        expected: {
          input: { title: "standup" },
          rrule: [],
          type: "recurring",
        },
        input: "every monday standup",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("bare day names stay single (not recurring)", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "standup monday at 9am",
      },
      { expected: { type: "single" }, input: "call next monday" },
      { expected: { type: "single" }, input: "meeting on monday at 2pm" },
    ];
    it.each(cases)("$input", runCase);
  });

  // "every X for N weeks/days/months", "N times" or "through <date>" yields one recurring page
  // with a bounded RRULE (COUNT or UNTIL), expanded virtually, not N pages.

  describe("bounded recurrence — every X + window", () => {
    const cases: ParserCase[] = [
      // Regression: ~folder must not turn the bounded recurring page into a finite list.
      {
        expected: {
          input: { folderQuery: "dog", title: "run" },
          rrule: [],
          type: "recurring",
        },
        input: "run ~dog every monday at 3pm for 10 weeks",
      },
      {
        expected: {
          rrule: ["COUNT=10", "BYDAY=MO"],
          rruleAbsent: ["UNTIL="],
          type: "recurring",
        },
        input: "standup every monday at 9am 10 times",
      },
      {
        expected: {
          input: {
            folderQuery: "Engineering",
            priority: "high",
            tags: ["work"],
            title: "standup",
          },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am for 4 weeks #work !high ~Engineering",
      },
      {
        expected: { rrule: [], rruleAbsent: ["DTSTART"], type: "recurring" },
        input: "every monday for 4 weeks",
      },
      {
        expected: {
          expansion: { count: 10, dtstart: "20260316T150000Z" },
          input: { scheduledStart: "2026-03-16T15:00:00", title: "run" },
          rrule: ["FREQ=WEEKLY", "BYDAY=MO", "UNTIL="],
          rruleAbsent: ["COUNT="],
          type: "recurring",
        },
        input: "run every monday at 3pm for 10 weeks",
      },
      {
        expected: {
          expansion: { count: 2, dtstart: "20260316T000000Z" },
          input: { scheduledStart: "2026-03-16" },
          rrule: ["BYDAY=MO", "UNTIL="],
          type: "recurring",
        },
        input: "every monday for 2 weeks",
      },
      {
        expected: {
          expansion: { count: 5, dtstart: "20260316T070000Z" },
          input: { scheduledStart: "2026-03-16T07:00:00" },
          rrule: ["FREQ=DAILY", "UNTIL="],
          type: "recurring",
        },
        input: "water plant every day at 7am for 5 days",
      },
      {
        expected: {
          expansion: { count: 3, dtstart: "20260315T000000Z" },
          rrule: ["FREQ=MONTHLY", "UNTIL="],
          type: "recurring",
        },
        input: "pay rent every month for 3 months",
      },
      {
        expected: {
          expansion: { count: 7, dtstart: "20260316T000000Z" },
          rrule: ["UNTIL=2026043", "BYDAY=MO"],
          type: "recurring",
        },
        input: "standup every monday through april 30",
      },
      {
        expected: {
          expansion: { count: 4, dtstart: "20260317T180000Z" },
          rrule: ["BYDAY=TU,TH", "UNTIL="],
          type: "recurring",
        },
        input: "gym every tuesday and thursday at 6pm for 2 weeks",
      },
      {
        expected: {
          expansion: { count: 10, dtstart: "20260316T090000Z" },
          rrule: ["BYDAY=MO,TU,WE,TH,FR", "UNTIL="],
          type: "recurring",
        },
        input: "standup every weekday at 9am for 2 weeks",
      },
      {
        expected: {
          custom: (r) => {
            expect(rruleToShortLabel(r.rrule)).toBe("Weekly thru May 9");
          },
          expansion: { count: 8, dtstart: "20260321T000000Z" },
          rrule: ["BYDAY=SA", "UNTIL=20260509"],
          type: "recurring",
        },
        input: "every saturday for 8 weeks",
      },
      {
        expected: {
          custom: (r) => {
            expect(parseRrule(r.rrule)).not.toBeNull();
          },
          rrule: [],
          type: "recurring",
        },
        input: "every monday for 10 weeks",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // "every [week] <day-list>" should augment the infinite weekly rule with
  // BYDAY rather than overwrite it with a finite-slash list.

  describe("every + day-list composition", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "run" },
          rrule: ["FREQ=WEEKLY", "BYDAY=MO,FR"],
          type: "recurring",
        },
        input: "run every week m/f",
      },
      {
        expected: {
          rrule: ["BYDAY=MO,FR", "UNTIL="],
          type: "recurring",
        },
        input: "run every week m/f for 10 weeks",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T15:00:00", title: "run" },
          rrule: ["FREQ=WEEKLY", "BYDAY=MO,FR"],
          type: "recurring",
        },
        input: "run every m/f at 3pm",
      },
      {
        expected: { rrule: ["BYDAY=MO,WE,FR"], type: "recurring" },
        input: "run every m/w/f at 3pm",
      },
      // Regression: full or short day names in a slash list under "every" stay one infinite BYDAY
      // rule; "every mon" must not strand "/wed/fri" and collapse it to a finite series.
      {
        expected: { rrule: ["FREQ=WEEKLY", "BYDAY=MO,WE,FR"], type: "recurring" },
        input: "run every mon/wed/fri at 3pm",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "BYDAY=MO,WE,FR"], type: "recurring" },
        input: "run every monday/wednesday/friday",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "BYDAY=MO,WE"], type: "recurring" },
        input: "standup every week mondays and wednesdays at 9am",
      },
      // Regression: bare m/f (no "every") stays finite.
      { expected: { count: 2, type: "finite" }, input: "run m/f at 3pm" },
      // Regression: bare "weekdays" stays finite (Mon–Fri).
      { expected: { count: 5, type: "finite" }, input: "standup weekdays" },
    ];
    it.each(cases)("$input", runCase);
  });

  // A window without a cadence word defaults to FREQ=DAILY, so the count or boundary isn't silently stripped from the title.

  describe("default daily when window present but no cadence", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "run dog" },
          rrule: ["FREQ=DAILY", "COUNT=10"],
          rruleAbsent: ["BYDAY="],
          type: "recurring",
        },
        input: "run dog 10 times",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: "run dog" },
          rrule: ["FREQ=DAILY", "COUNT=10"],
          type: "recurring",
        },
        input: "run dog 10 times tomorrow",
      },
      {
        expected: {
          expansion: { count: 14, dtstart: "20260316T080000Z" },
          input: { scheduledStart: "2026-03-16T08:00:00", title: "meditate" },
          rrule: ["FREQ=DAILY", "UNTIL="],
          type: "recurring",
        },
        input: "meditate for 2 weeks at 8am",
      },
      {
        expected: {
          input: { title: "practice piano" },
          rrule: ["FREQ=DAILY", "UNTIL=202606"],
          type: "recurring",
        },
        input: "practice piano through june",
      },
      {
        expected: { input: { title: "run dog" }, type: "single" },
        input: "run dog",
      },
      // Regression: slash has its own cadence, stays finite.
      { expected: { count: 6, type: "finite" }, input: "run m/w/f for 2 weeks" },
      // Regression: explicit 'daily 10 times' is unchanged.
      {
        expected: { rrule: ["FREQ=DAILY", "COUNT=10"], type: "recurring" },
        input: "run dog daily 10 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("until / till as window boundary", () => {
    const cases: ParserCase[] = [
      {
        expected: { rrule: ["BYDAY=MO", "UNTIL=2026043"], type: "recurring" },
        input: "standup every monday until april 30",
      },
      {
        expected: {
          input: { title: "meditate" },
          rrule: ["FREQ=DAILY", "UNTIL=202606"],
          type: "recurring",
        },
        input: "meditate until june",
      },
      {
        expected: { rrule: ["UNTIL="], type: "recurring" },
        input: "practice every day till june",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("interval cadences", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "sync" },
          rrule: ["FREQ=WEEKLY", "INTERVAL=2"],
          type: "recurring",
        },
        input: "sync biweekly",
      },
      {
        expected: { rrule: ["FREQ=MONTHLY", "INTERVAL=2"], type: "recurring" },
        input: "rent bimonthly",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "INTERVAL=2"], type: "recurring" },
        input: "review fortnightly",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "INTERVAL=2"], type: "recurring" },
        input: "sync every other week",
      },
      {
        expected: { rrule: ["FREQ=DAILY", "INTERVAL=2"], type: "recurring" },
        input: "water plants every other day",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "INTERVAL=2"], type: "recurring" },
        input: "sync every 2 weeks",
      },
      {
        expected: { rrule: ["FREQ=DAILY", "INTERVAL=3"], type: "recurring" },
        input: "water plants every 3 days",
      },
      {
        expected: { rrule: ["FREQ=MONTHLY", "INTERVAL=6"], type: "recurring" },
        input: "checkup every 6 months",
      },
      {
        expected: { rrule: ["INTERVAL=2", "COUNT=5"], type: "recurring" },
        input: "sync every 2 weeks 5 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("yearly cadence", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { title: "renewal" }, rrule: ["FREQ=YEARLY"], type: "recurring" },
        input: "renewal yearly",
      },
      { expected: { rrule: ["FREQ=YEARLY"], type: "recurring" }, input: "taxes annually" },
      { expected: { rrule: ["FREQ=YEARLY"], type: "recurring" }, input: "birthday every year" },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("time ranges", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 120,
            scheduledEnd: "2026-03-15T17:00:00",
            scheduledStart: "2026-03-15T15:00:00",
          },
          type: "single",
        },
        input: "meeting from 3pm to 5pm",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-03-16T17:00:00",
            scheduledStart: "2026-03-16T15:00:00",
          },
          type: "single",
        },
        input: "meeting 3pm to 5pm tomorrow",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-03-16T17:00:00",
            scheduledStart: "2026-03-16T15:00:00",
          },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "sync every monday 3pm to 5pm",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // chrono parses the span; `result.end` becomes scheduledEnd only when the start is date-only. A timed event with a date range stays single-day to avoid ambiguity.

  describe("multi-day all-day ranges", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            scheduledEnd: "2026-04-25",
            scheduledStart: "2026-04-18",
            title: "vacation",
          },
          type: "single",
        },
        input: "vacation April 18-25",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-04-25", scheduledStart: "2026-04-18" },
          type: "single",
        },
        input: "vacation from April 18 to April 25",
      },
      // "through" / "thru" between "<Month> <day>" pairs is normalized to "to" at the top of parseInput.
      {
        expected: {
          input: { scheduledEnd: "2026-04-20", scheduledStart: "2026-04-18" },
          type: "single",
        },
        input: "offsite April 18 to April 20",
      },
      // A weekday end is certain of its weekday, not its day, and was dropped.
      {
        expected: {
          input: { scheduledEnd: "2026-03-20", scheduledStart: "2026-03-16", title: "offsite" },
          type: "single",
        },
        input: "offsite from Mon to Fri",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-03-20", scheduledStart: "2026-03-16", title: "offsite" },
          type: "single",
        },
        input: "offsite Mon to Fri",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-03-23", scheduledStart: "2026-03-20", title: "retreat" },
          type: "single",
        },
        input: "retreat Fri to Mon",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-03-15T17:00:00",
            scheduledStart: "2026-03-15T15:00:00",
          },
          type: "single",
        },
        input: "meeting 3pm to 5pm",
      },
      // Without the rewrite to "to", chrono reads "2 through 10" as a 2am-10am time range.
      {
        expected: {
          input: {
            scheduledEnd: "2026-05-10",
            scheduledStart: "2026-05-02",
            title: "travel",
          },
          type: "single",
        },
        input: "travel May 2 through 10",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-05-10", scheduledStart: "2026-05-02" },
          type: "single",
        },
        input: "travel May 2 thru 10",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-04-25", scheduledStart: "2026-04-18" },
          type: "single",
        },
        input: "trip April 18 through April 25",
      },
      {
        expected: {
          input: { scheduledEnd: "2027-01-03", scheduledStart: "2026-12-28" },
          type: "single",
        },
        input: "trip Dec 28 through Jan 3",
      },
      // Regression: cadence + "through" stays a bounded-recurrence window; the rewrite only fires right after a "<Month> <day>" literal.
      {
        expected: { rrule: ["FREQ=DAILY", "UNTIL=202606"], type: "recurring" },
        input: "practice piano through june",
      },
      {
        expected: { rrule: ["BYDAY=MO", "UNTIL=2026043"], type: "recurring" },
        input: "standup every monday through april 30",
      },
      {
        expected: {
          input: { scheduledStart: "2026-04-18" },
          inputAbsent: ["scheduledEnd"],
          type: "single",
        },
        input: "vacation April 18",
      },
      // Start gets the time; an end, if present, collapses to the same day.
      {
        expected: {
          custom: (r) => {
            if (r.input.scheduledEnd) {
              expect(r.input.scheduledEnd).toContain("2026-04-18");
            }
          },
          inputMatches: { scheduledStart: /^2026-04-18T15:00:00/ },
          type: "single",
        },
        input: "trip April 18-20 at 3pm",
      },
    ];
    it.each(cases)("$input", runCase);

    it("keeps no end that names only a month, rather than reading it as the 1st", () => {
      const result = parseInput("trip from March 20 to April", NOW);
      expect(result.type).toBe("single");
      expect(result).not.toHaveProperty("input.scheduledEnd");
    });
  });

  describe("RRULE validation", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          custom: (r) => {
            expect(parseRrule(r.rrule)).not.toBeNull();
          },
          rrule: [],
          type: "recurring",
        },
        input: "every monday",
      },
      {
        expected: { rrule: [], rruleAbsent: ["DTSTART"], type: "recurring" },
        input: "morning run daily",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("for disambiguation", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { durationMinutes: 60 }, type: "single" },
        input: "task for 1h",
      },
      {
        expected: {
          input: { title: "task" },
          rrule: ["FREQ=DAILY"],
          type: "recurring",
        },
        input: "task for 2 weeks",
      },
      {
        expected: {
          count: 6,
          eachInput: { durationMinutes: 60 },
          type: "finite",
        },
        input: "run m/w/f for 1h for 2 weeks",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("token stripping and title cleanliness", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { title: "meeting" }, type: "single" },
        input: "  #work  meeting  @tomorrow  at 2pm  ",
      },
      {
        expected: {
          input: { tags: ["a", "b", "c"], title: "" },
          type: "single",
        },
        input: "#a #b #c",
      },
      {
        expected: { input: { title: "hello world" }, type: "single" },
        input: "hello world",
      },
      {
        expected: {
          input: { title: "task !invalid" },
          inputAbsent: ["priority"],
          type: "single",
        },
        input: "task !invalid",
      },
      {
        expected: {
          inputAbsent: ["folderQuery"],
          inputMatches: { title: /~/ },
          type: "single",
        },
        input: "task ~",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("daily keyword interaction with every", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "daily standup" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "daily standup every monday",
      },
      {
        expected: {
          input: { title: "standup" },
          rrule: ["FREQ=DAILY"],
          type: "recurring",
        },
        input: "standup daily",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("bare date parsing (no @ prefix)", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-16T14:00:00", title: "team meeting" },
          type: "single",
        },
        input: "team meeting tomorrow at 2pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15", title: "lunch" }, type: "single" },
        input: "lunch today",
      },
      // "monday" at the start is the first chrono result; a later "9am" is not merged (the parser uses chronoResults[0] only).
      {
        expected: { input: { scheduledStart: "2026-03-16", title: "standup" }, type: "single" },
        input: "monday standup",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16", title: "standup" }, type: "single" },
        input: "standup monday",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: "team meeting" },
          type: "single",
        },
        input: "team monday meeting",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-20T15:00:00", title: "review" },
          type: "single",
        },
        input: "review next friday at 3pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-18", title: "sync" }, type: "single" },
        input: "sync this wednesday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-18", title: "deadline" }, type: "single" },
        input: "deadline in 3 days",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-20T15:30:00", title: "call" },
          type: "single",
        },
        input: "call march 20 at 3:30pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 2pm",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T14:00:00", title: "meeting" },
          type: "single",
        },
        input: "meeting @tomorrow at 2pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "standup @monday 9am",
      },
      {
        expected: { rrule: ["BYDAY=MO"], type: "recurring" },
        input: "standup every monday",
      },
      {
        expected: { count: 3, type: "finite" },
        input: "run m/w/f at 3pm",
      },
      // A bare month resolves with forwardDate; the exact value depends on the chrono version.
      {
        expected: {
          input: { title: "plan trip" },
          inputMatches: { scheduledStart: /\d{4}-\d{2}-\d{2}/ },
          type: "single",
        },
        input: "plan trip march",
      },
      // chrono skips "may" in "may day celebration" as ambiguous.
      {
        expected: {
          input: { title: "may day celebration" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "may day celebration",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("monthly keyword", () => {
    it.each<ParserCase>([
      {
        expected: {
          input: { title: "rent payment" },
          rrule: ["FREQ=MONTHLY"],
          type: "recurring",
        },
        input: "rent payment monthly",
      },
    ])("$input", runCase);
  });

  describe("bare weekly keyword", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { title: "sync" },
          rrule: ["FREQ=WEEKLY"],
          type: "recurring",
        },
        input: "sync weekly",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-15T15:00:00", title: "review" },
          rrule: ["FREQ=WEEKLY"],
          type: "recurring",
        },
        input: "review weekly at 3pm",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("for disambiguation — no recurrence pattern", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { durationMinutes: 30, title: "focus session" },
          type: "single",
        },
        input: "focus session for 30min",
      },
      {
        expected: {
          input: {
            durationMinutes: 120,
            scheduledEnd: "2026-03-16T11:00:00",
            scheduledStart: "2026-03-16T09:00:00",
          },
          type: "single",
        },
        input: "deep work for 2h @tomorrow at 9am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("multi-tag ordering stability", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { tags: ["design", "ux", "frontend"] },
          type: "single",
        },
        input: "task #design #ux #frontend",
      },
      {
        expected: {
          input: { tags: ["alpha", "beta", "gamma"] },
          type: "single",
        },
        input: "#alpha meeting #beta @tomorrow #gamma",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring with time range", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 120,
            scheduledEnd: "2026-03-16T11:00:00",
            scheduledStart: "2026-03-16T09:00:00",
          },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "standup every monday from 9am to 11am",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-03-16T17:00:00",
            scheduledStart: "2026-03-16T09:00:00",
          },
          rrule: ["BYDAY=MO,TU,WE,TH,FR", "UNTIL="],
          type: "recurring",
        },
        input: "work every weekday 9am-5pm for 2 weeks",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("time edge cases", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-16T00:00:00" }, type: "single" },
        input: "late job at 12am",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T23:59:00" }, type: "single" },
        input: "late note at 11:59pm",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("tag and folder regex boundaries", () => {
    const cases: ParserCase[] = [
      // The tag regex is /#(\w+)/, so anything after a hyphen stays in the title.
      {
        expected: {
          input: { tags: ["multi"] },
          inputMatches: { title: /-word/ },
          type: "single",
        },
        input: "review #multi-word",
      },
      {
        expected: {
          input: { tags: ["q4", "2025"], title: "plan" },
          type: "single",
        },
        input: "plan #q4 #2025",
      },
      {
        expected: { input: { tags: ["snake_case"] }, type: "single" },
        input: "note #snake_case",
      },
      // Parser does NOT dedupe duplicate tag names — caller's responsibility.
      {
        expected: { input: { tags: ["work", "work"] }, type: "single" },
        input: "note #work #work",
      },
      {
        expected: {
          input: { folderQuery: "side" },
          inputMatches: { title: /-project/ },
          type: "single",
        },
        input: "page ~side-project",
      },
      // Parser preserves casing; QuickAddDialog lowercases for the Inbox check.
      {
        expected: {
          input: { folderQuery: "Inbox", title: "dump" },
          type: "single",
        },
        input: "dump ~Inbox",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("empty-title cases (caller falls back to 'Untitled')", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: "" },
          type: "single",
        },
        input: "tomorrow",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-15T15:00:00", title: "" },
          type: "single",
        },
        input: "at 3pm",
      },
      {
        expected: {
          input: { durationMinutes: 120, title: "" },
          type: "single",
        },
        input: "for 2h",
      },
      {
        expected: {
          input: { folderQuery: "Projects", priority: "high", title: "" },
          type: "single",
        },
        input: "!high ~Projects",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("priority case-insensitivity", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { priority: "urgent" }, type: "single" },
        input: "blocker !URGENT",
      },
      {
        expected: { input: { priority: "medium" }, type: "single" },
        input: "review !Medium",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("full NLP composition", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            durationMinutes: 90,
            folderQuery: "Engineering",
            priority: "high",
            scheduledEnd: "2026-03-16T15:30:00",
            scheduledStart: "2026-03-16T14:00:00",
            tags: ["design", "ux"],
            title: "team review",
          },
          type: "single",
        },
        input: "team review tomorrow at 2pm for 90m !high #design #ux ~Engineering",
      },
      {
        expected: {
          input: {
            durationMinutes: 90,
            folderQuery: "Engineering",
            priority: "high",
            tags: ["design", "ux"],
            title: "team review",
          },
          type: "single",
        },
        input: "#design ~Engineering team review !high tomorrow #ux at 2pm for 90m",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurring edge cases", () => {
    const cases: ParserCase[] = [
      // The serializer may omit INTERVAL=1; the rule must still round-trip.
      {
        expected: {
          custom: (r) => {
            expect(parseRrule(r.rrule)).not.toBeNull();
          },
          rrule: ["FREQ=WEEKLY"],
          type: "recurring",
        },
        input: "sync every 1 week",
      },
      {
        expected: {
          expansion: { count: 1, dtstart: "20260316T000000Z" },
          rrule: ["BYDAY=MO", "UNTIL="],
          type: "recurring",
        },
        input: "standup every monday for 1 week",
      },
      {
        expected: { rrule: ["COUNT=1"], type: "recurring" },
        input: "kickoff every monday 1 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // Edges of the "Month day-day" / "Month day through day" rewrite: single-digit days, ordinals,
  // abbreviated months, metadata tokens, same-day ranges and reversed ranges (no scheduledEnd).
  describe("multi-day all-day ranges — adjacent edges", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledEnd: "2026-04-09", scheduledStart: "2026-04-05" },
          type: "single",
        },
        input: "trip Apr 5-9",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-09-07", scheduledStart: "2026-09-01" },
          type: "single",
        },
        input: "trip Sep 1-7",
      },
      // The rewrite regex captures ordinal suffixes so the span resolves cleanly.
      {
        expected: {
          input: { scheduledEnd: "2026-05-10", scheduledStart: "2026-05-02" },
          type: "single",
        },
        input: "travel May 2nd through 10th",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-04-25", scheduledStart: "2026-04-18" },
          type: "single",
        },
        input: "trip Apr 18th thru Apr 25th",
      },
      // chrono's forwardDate advances an earlier second date to the next year, keeping the range ordered.
      {
        expected: {
          input: { scheduledEnd: "2027-04-18", scheduledStart: "2026-04-25" },
          type: "single",
        },
        input: "vacation April 25 to April 18",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-04-25",
            scheduledStart: "2026-04-18",
            tags: ["vacation"],
            title: "trip",
          },
          type: "single",
        },
        input: "trip April 18-25 #vacation",
      },
      {
        expected: {
          input: {
            priority: "urgent",
            scheduledEnd: "2026-04-25",
            scheduledStart: "2026-04-18",
            title: "trip",
          },
          type: "single",
        },
        input: "trip April 18-25 !urgent",
      },
      {
        expected: {
          input: {
            folderQuery: "Travel",
            scheduledEnd: "2026-04-25",
            scheduledStart: "2026-04-18",
            title: "trip",
          },
          type: "single",
        },
        input: "trip April 18 to April 25 ~Travel",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-05-10",
            scheduledStart: "2026-05-02",
            title: "travel",
          },
          type: "single",
        },
        input: "travel from May 2 to May 10",
      },
      // chrono consumes "tomorrow" but not the leading "from"; the strip covers single dates too.
      {
        expected: { input: { title: "call" }, type: "single" },
        input: "call from tomorrow",
      },
      {
        expected: {
          input: { scheduledEnd: "2026-06-05", scheduledStart: "2026-05-02" },
          type: "single",
        },
        input: "trip May 2 through Jun 5",
      },
      {
        expected: {
          input: { scheduledStart: "2026-04-18" },
          inputAbsent: ["scheduledEnd"],
          type: "single",
        },
        input: "trip April 18 to April 18",
      },
      // Without a month the rewrite does not apply, and chrono has no grammar for "18-25".
      {
        expected: { inputAbsent: ["scheduledEnd"], type: "single" },
        input: "trip 18-25",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // After a finite-window phrase consumes its tokens, no boundary keyword remains in the title.
  describe("title leakage — finite window keywords", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          inputMatches: { title: /^(?!.*\bthrough\b)(?!.*\bapril\b).*$/i },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday through april 30",
      },
      {
        expected: {
          inputMatches: { title: /^(?!.*\buntil\b).*$/i },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday until april 30",
      },
      {
        expected: {
          inputMatches: { title: /^(?!.*\btill\b).*$/i },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday till april 30",
      },
      {
        expected: { input: { title: "standup" }, rrule: [], type: "recurring" },
        input: "standup every monday 4 times",
      },
      {
        expected: { input: { title: "standup" }, rrule: [], type: "recurring" },
        input: "standup every monday for 2 weeks",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // chrono absorbs the connector inconsistently ("on friday" yes, "on May 24" no) and can't parse bare
  // day-of-month forms ("on the 24th", "Sat 24"). Both must vanish from the title.
  describe("title leakage — connectors and day-of-month", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-24T14:00:00", title: "Call mom" },
          type: "single",
        },
        input: "Call mom on March 24 2pm !high",
      },
      {
        expected: { input: { scheduledStart: "2026-05-24", title: "Review" }, type: "single" },
        input: "Review on May 24",
      },
      {
        expected: { input: { scheduledStart: "2026-05-01", title: "Pay rent" }, type: "single" },
        input: "Pay rent by May 1",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: "Submit report" },
          type: "single",
        },
        input: "Submit report for tomorrow",
      },
      {
        expected: { input: { scheduledStart: "2026-03-24", title: "Meeting" }, type: "single" },
        input: "Meeting on the 24th",
      },
      {
        expected: { input: { scheduledStart: "2026-04-01", title: "Pay rent" }, type: "single" },
        input: "Pay rent by the 1st",
      },
      {
        expected: { input: { scheduledStart: "2026-03-24", title: "Plan sprint" }, type: "single" },
        input: "Plan sprint Sat 24",
      },
      {
        expected: {
          input: { scheduledStart: "2026-04-13T16:00:00", title: "Standup" },
          type: "single",
        },
        input: "Standup fri 13th 4pm",
      },
      {
        expected: {
          input: { title: "3rd draft review" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "3rd draft review",
      },
      {
        expected: {
          input: { title: "the 1st time we met" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "the 1st time we met",
      },
      {
        expected: {
          input: { title: "review section 24" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "review section 24",
      },
      {
        expected: { rrule: ["FREQ=WEEKLY", "BYDAY=FR"], type: "recurring" },
        input: "standup every friday",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // A sentence typed whole, or passed whole by an assistant: the date phrase, its connecting words and the closing full stop all go.
  describe("title leakage — sentences typed whole", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-04-30", title: "Renew passport" },
          type: "single",
        },
        input: "Renew passport by the end of next month",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-31", title: "Renew passport" },
          type: "single",
        },
        input: "Renew passport by the end of the month",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-31", title: "Submit timesheet" },
          type: "single",
        },
        input: "Submit timesheet end of month",
      },
      {
        expected: {
          input: { scheduledStart: "2026-04-30", title: "Renew passport" },
          type: "single",
        },
        input: "Renew passport by the end of next month.",
      },
      {
        expected: {
          input: { scheduledStart: "2026-04-01", title: "Pay the gym membership" },
          rrule: ["FREQ=MONTHLY"],
          type: "recurring",
        },
        input: "Pay the gym membership on the 1st of every month",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-19T15:30:00", title: "Coffee with Jordan" },
          type: "single",
        },
        input: "Coffee with Jordan on Thursday at 3:30pm.",
      },
      {
        expected: {
          input: { title: "Call mum." },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "Call mum.",
      },
      // Negative: "!" and "?" carry meaning and stay after a strip.
      {
        expected: { input: { scheduledStart: "2026-03-16", title: "Ship it!" }, type: "single" },
        input: "Ship it tomorrow!",
      },
      {
        expected: {
          input: { title: "Read the end of the book" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "Read the end of the book",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("a time-of-day word with no date beside it is part of the title", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-15T20:00:00", title: "Evening review" },
          type: "single",
        },
        input: "Evening review today 8pm",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00", title: "Morning pages" },
          type: "single",
        },
        input: "Morning pages tomorrow 9am",
      },
      {
        expected: {
          input: {
            scheduledEnd: "2026-03-16T05:00:00",
            scheduledStart: "2026-03-15T21:00:00",
            title: "night shift",
          },
          type: "single",
        },
        input: "night shift today 9pm to 5am",
      },
      {
        expected: {
          input: { title: "Morning pages" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "Morning pages",
      },
      {
        expected: {
          input: { title: "Stretch in the evening" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "Stretch in the evening",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("time-without-date weekday anchoring", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-17T16:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "call every tuesday at 4pm",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-20T09:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "call every friday at 9am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("duration parsing edges", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { durationMinutes: 15 }, type: "single" },
        input: "focus for 0.25h",
      },
      {
        expected: { input: { durationMinutes: 90 }, type: "single" },
        input: "focus for 90 minutes",
      },
      {
        expected: { input: { durationMinutes: 60 }, type: "single" },
        input: "focus for 1 hour",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("recurrence + window composition — adjacent edges", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          rrule: ["FREQ=WEEKLY", "INTERVAL=2", "UNTIL="],
          type: "recurring",
        },
        input: "standup every other week for 4 weeks",
      },
      {
        expected: {
          rrule: ["INTERVAL=3", "COUNT=5"],
          type: "recurring",
        },
        input: "medication every 3 days 5 times",
      },
      {
        expected: {
          rrule: ["FREQ=WEEKLY", "INTERVAL=2", "UNTIL="],
          type: "recurring",
        },
        input: "standup biweekly for 2 months",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // The interval regex needs a unit word, so "every other tuesday" falls through to chrono.
  describe("interval + weekday composition", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          rrule: ["FREQ=WEEKLY", "INTERVAL=2", "BYDAY=TU"],
          type: "recurring",
        },
        input: "standup every other tuesday",
      },
      {
        expected: {
          rrule: ["INTERVAL=2", "BYDAY=MO"],
          type: "recurring",
        },
        input: "kickoff every 2 mondays",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-17", title: "standup" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every other tuesday",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-17T09:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every other tuesday at 9am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // Reference dates other than Sun Mar 15 2026: other weekdays, year rollover, and the same-day boundary.
  describe("reference date variation", () => {
    // Same-day future time: the parser anchors via nextWeekdayOccurrence, which returns at least 7 days ahead for the same weekday.
    const MON_MORN = new Date("2026-03-16T07:00:00");
    const MON_AFTN = new Date("2026-03-16T15:00:00");
    const FRI = new Date("2026-03-20T12:00:00");
    const SAT = new Date("2026-03-21T12:00:00");
    const DEC30 = new Date("2026-12-30T12:00:00");
    const DEC31 = new Date("2026-12-31T12:00:00");
    const LAST_SUN = new Date("2026-03-29T12:00:00");

    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-23T09:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am",
        now: MON_MORN,
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-23T09:00:00" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday at 9am",
        now: MON_AFTN,
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-27" },
          rrule: [],
          type: "recurring",
        },
        input: "review every friday",
        now: FRI,
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-23" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday",
        now: SAT,
      },
      {
        expected: {
          input: { scheduledStart: "2027-01-04" },
          rrule: [],
          type: "recurring",
        },
        input: "standup every monday",
        now: DEC30,
      },
      {
        expected: {
          input: { scheduledStart: "2027-01-01" },
          type: "single",
        },
        input: "party tomorrow",
        now: DEC31,
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-30" },
          rrule: ["UNTIL=20260406"],
          type: "recurring",
        },
        input: "standup every monday for 2 weeks",
        now: LAST_SUN,
      },
    ];
    it.each(cases)("$input @ $now", runCase);
  });

  // Dense phrases exercising every token type. Inline snapshots lock the whole ParseResult;
  // update with `pnpm --filter @pikos/core exec vitest run -u`.
  describe("kitchen-sink composition", () => {
    it("bounded weekly + time range + tags + folder + priority", () => {
      expect(
        parseInput(
          "team sync every monday from 9am to 10am for 6 weeks #work #standup ~Engineering !high",
          NOW
        )
      ).toMatchInlineSnapshot(`
        {
          "input": {
            "durationMinutes": 60,
            "folderQuery": "Engineering",
            "priority": "high",
            "scheduledEnd": "2026-03-16T10:00:00",
            "scheduledStart": "2026-03-16T09:00:00",
            "tags": [
              "work",
              "standup",
            ],
            "title": "team sync",
          },
          "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260420T235959",
          "type": "recurring",
        }
      `);
    });

    it("multi-day BYDAY + COUNT + duration + metadata", () => {
      expect(
        parseInput(
          "gym every tuesday and thursday at 6pm for 45m 12 times #health ~Fitness !2",
          NOW
        )
      ).toMatchInlineSnapshot(`
        {
          "input": {
            "durationMinutes": 45,
            "folderQuery": "Fitness",
            "priority": "high",
            "scheduledEnd": "2026-03-17T18:45:00",
            "scheduledStart": "2026-03-17T18:00:00",
            "tags": [
              "health",
            ],
            "title": "gym",
          },
          "rrule": "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=12",
          "type": "recurring",
        }
      `);
    });

    it("interval + weekday + bounded window + time + metadata", () => {
      expect(
        parseInput("1:1 every other tuesday at 3pm for 30m for 8 weeks #work ~Reports !urgent", NOW)
      ).toMatchInlineSnapshot(`
        {
          "input": {
            "durationMinutes": 30,
            "folderQuery": "Reports",
            "priority": "urgent",
            "scheduledEnd": "2026-03-17T15:30:00",
            "scheduledStart": "2026-03-17T15:00:00",
            "tags": [
              "work",
            ],
            "title": "1:1",
          },
          "rrule": "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20260428T235959",
          "type": "recurring",
        }
      `);
    });

    it("multi-day all-day range + tags + priority + folder", () => {
      expect(parseInput("vacation April 18-25 #pto ~Travel !low", NOW)).toMatchInlineSnapshot(`
        {
          "input": {
            "folderQuery": "Travel",
            "priority": "low",
            "scheduledEnd": "2026-04-25",
            "scheduledStart": "2026-04-18",
            "tags": [
              "pto",
            ],
            "title": "vacation",
          },
          "type": "single",
        }
      `);
    });

    it("scrambled token order — same dense phrase, different order", () => {
      expect(
        parseInput(
          "!high #work team sync ~Engineering every monday from 9am to 10am for 6 weeks",
          NOW
        )
      ).toMatchInlineSnapshot(`
        {
          "input": {
            "durationMinutes": 60,
            "folderQuery": "Engineering",
            "priority": "high",
            "scheduledEnd": "2026-03-16T10:00:00",
            "scheduledStart": "2026-03-16T09:00:00",
            "tags": [
              "work",
            ],
            "title": "team sync",
          },
          "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260420T235959",
          "type": "recurring",
        }
      `);
    });

    it("plural-day form + bounded + time + duration", () => {
      expect(parseInput("standup mondays at 9am for 30m for 4 weeks #work", NOW))
        .toMatchInlineSnapshot(`
          {
            "input": {
              "durationMinutes": 30,
              "scheduledEnd": "2026-03-16T09:30:00",
              "scheduledStart": "2026-03-16T09:00:00",
              "tags": [
                "work",
              ],
              "title": "standup",
            },
            "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260406T235959",
            "type": "recurring",
          }
        `);
    });
  });

  // Inputs real users type: mixed case, trailing punctuation, long titles, redundant whitespace.
  describe("adversarial input", () => {
    const longTitle = "a ".repeat(120).trim();
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "STANDUP EVERY MONDAY at 9am",
      },
      {
        expected: { rrule: ["INTERVAL=2", "BYDAY=TU"], type: "recurring" },
        input: "standup EvErY OtHeR TuEsDaY",
      },
      // Trailing punctuation on priority: the "." orphaned by the strip goes.
      {
        expected: { input: { priority: "urgent", title: "call" }, type: "single" },
        input: "call !urgent.",
      },
      // Redundant whitespace collapses. NOW=12:00, 3pm tomorrow → 2026-03-16T15:00:00.
      {
        expected: {
          input: { scheduledStart: "2026-03-16T15:00:00", title: "call mom" },
          type: "single",
        },
        input: "  call    mom    tomorrow   at   3pm  ",
      },
      {
        expected: {
          input: {
            scheduledStart: "2026-03-16T19:00:00",
            title: "🎉 birthday party",
          },
          type: "single",
        },
        input: "🎉 birthday party tomorrow at 7pm",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: longTitle },
          type: "single",
        },
        input: `${longTitle} tomorrow`,
      },
      // Two "every" phrases: pin only recurring weekly with at least one BYDAY among MO/WE.
      {
        expected: {
          custom: (r) => {
            expect(r.rrule).toMatch(/BYDAY=(MO|WE)/);
          },
          rrule: ["FREQ=WEEKLY"],
          type: "recurring",
        },
        input: "standup every monday and every wednesday",
      },
      {
        expected: {
          input: {
            priority: "urgent",
            scheduledStart: "2026-03-16",
            title: "buy groceries",
          },
          type: "single",
        },
        input: "!urgent buy groceries tomorrow",
      },
      // The tag regex is non-overlapping: "#abc#def" yields "abc" and "def".
      {
        expected: {
          input: { tags: ["abc", "def"], title: "note" },
          type: "single",
        },
        input: "note #abc#def",
      },
      {
        expected: {
          input: { tags: ["abc", "def"], title: "note" },
          type: "single",
        },
        input: "note #abc, #def",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "meeting at 09:00",
      },
      // "every <day>" needs a known weekday, so "word" leaves the input single.
      {
        expected: {
          inputAbsent: ["scheduledStart"],
          inputMatches: { title: /every word counts/ },
          type: "single",
        },
        input: "every word counts in the report",
      },
      {
        expected: { input: { tags: ["404"], title: "fix bug" }, type: "single" },
        input: "fix #404 bug",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // Casual phrases users type most, pinned so a chrono upgrade can't change them silently.
  describe("chrono casual phrases", () => {
    const LATE = new Date("2026-03-15T21:00:00");
    const cases: ParserCase[] = [
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00", title: "call" },
          type: "single",
        },
        input: "call tomorrow morning",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T15:00:00" }, type: "single" },
        input: "call tomorrow afternoon",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T18:00:00" }, type: "single" },
        input: "call tomorrow evening",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T20:00:00" }, type: "single" },
        input: "call tomorrow night",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T20:00:00" }, type: "single" },
        input: "call tonight",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "call this morning",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T15:00:00" }, type: "single" },
        input: "call this afternoon",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-15T18:00:00", title: "dinner" },
          type: "single",
        },
        input: "dinner this evening",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T15:00:00" }, type: "single" },
        input: "call today afternoon",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "call today morning",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T20:00:00" }, type: "single" },
        input: "call tonight",
        now: LATE,
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00", title: "standup" },
          type: "single",
        },
        input: "standup monday morning",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20T18:00:00" }, type: "single" },
        input: "dinner friday evening",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "standup this monday morning",
      },
      // "next monday" is forward, "this <weekday>" the same week (today if it is that day), "last <weekday>" the previous week.
      {
        expected: { input: { scheduledStart: "2026-03-16" }, type: "single" },
        input: "call next monday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16" }, type: "single" },
        input: "call this monday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20" }, type: "single" },
        input: "review this friday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15" }, type: "single" },
        input: "note this sunday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-09" }, type: "single" },
        input: "retro last monday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-13" }, type: "single" },
        input: "retro last friday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-08" }, type: "single" },
        input: "note last sunday",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "standup every monday morning",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T09:00:00" },
          rrule: ["BYDAY=MO,TU,WE,TH,FR"],
          type: "recurring",
        },
        input: "standup every weekday morning",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-16T15:00:00" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "review every monday afternoon",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-17T18:00:00" },
          rrule: ["INTERVAL=2", "BYDAY=TU"],
          type: "recurring",
        },
        input: "dinner every other tuesday evening",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-21T09:00:00" },
          rrule: ["BYDAY=SA,SU"],
          type: "recurring",
        },
        input: "brunch every weekend morning",
      },
      {
        expected: { input: { priority: "urgent", title: "call" }, type: "single" },
        input: "call !urgent.",
      },
      {
        expected: { input: { tags: ["abc", "def"], title: "note" }, type: "single" },
        input: "note #abc, #def",
      },
      {
        expected: { input: { scheduledStart: "2026-03-18" }, type: "single" },
        input: "review in 3 days",
      },
      {
        expected: { input: { scheduledStart: "2026-03-29" }, type: "single" },
        input: "retro in 2 weeks",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20" }, type: "single" },
        input: "call next friday",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T13:00:00" }, type: "single" },
        input: "call in 1 hour",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20T15:00:00" }, type: "single" },
        input: "review friday at 3pm",
      },
      // 9pm to 5am — start 21:00 today/tomorrow, end at 05:00 next day. Duration
      // should reflect 8 hours, not −16.
      {
        expected: {
          input: { durationMinutes: 8 * 60 },
          inputMatches: { scheduledEnd: /T05:00:00$/, scheduledStart: /T21:00:00$/ },
          type: "single",
        },
        input: "shift 9pm to 5am",
      },
      {
        expected: {
          input: { durationMinutes: 5 * 60 },
          inputMatches: { scheduledEnd: /T17:00:00$/, scheduledStart: /T12:00:00$/ },
          type: "single",
        },
        input: "workshop noon to 5pm",
      },
      // NOW is 12:00 — chrono returns 12:00; if the parser uses <= ref, it
      // shifts to tomorrow. Pin only the time component.
      {
        expected: {
          inputMatches: { scheduledStart: /^2026-03-1[56]T12:00:00$/ },
          type: "single",
        },
        input: "call mom at noon",
      },
      // chrono returns 00:00 today; <= ref shifts to tomorrow.
      {
        expected: {
          inputMatches: { scheduledStart: /T00:00:00$/ },
          type: "single",
        },
        input: "alarm at midnight",
      },
      // Pin only that something forward of NOW was parsed.
      {
        expected: {
          inputMatches: { scheduledStart: /^2026-03-(2[0-9]|1[6-9])/ },
          type: "single",
        },
        input: "review next week",
      },
      // "5p" is sometimes parsed by chrono as 5pm. Pin only the hour, and only
      // when chrono actually produced a date.
      {
        expected: {
          custom: (r) => {
            if (r.input.scheduledStart) {
              expect(r.input.scheduledStart).toMatch(/T1[57]:00:00/);
            }
          },
          type: "single",
        },
        input: "meeting at 5p",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // Adversarial input degrades to a single page titled with the input, no schedule, and never throws.
  describe("negative paths and garbage input", () => {
    const longToken = "x".repeat(1000);
    const cases: ParserCase[] = [
      // The priority regex requires a known word or digit, so '!!!' is not consumed.
      {
        expected: {
          input: { title: "!!!" },
          inputAbsent: ["priority"],
          type: "single",
        },
        input: "!!!",
      },
      {
        expected: { input: { title: "" }, type: "single" },
        input: "   \t\t  \n  ",
      },
      {
        expected: {
          input: { tags: [], title: "asdf jkl qwerty" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "asdf jkl qwerty",
      },
      {
        expected: { inputMatches: { title: /12345/ }, type: "single" },
        input: "12345",
      },
      {
        expected: { input: { tags: [], title: "#" }, type: "single" },
        input: "#",
      },
      {
        expected: {
          input: { title: "~" },
          inputAbsent: ["folderQuery"],
          type: "single",
        },
        input: "~",
      },
      // "for N weeks" requires \d+, so "X" falls through; "every monday" still matches.
      {
        expected: {
          rrule: ["BYDAY=MO"],
          rruleAbsent: ["UNTIL=", "COUNT="],
          type: "recurring",
        },
        input: "standup every monday for X weeks",
      },
      // The slash-day regex requires the whole list to be valid weekdays.
      {
        expected: { inputMatches: { title: /m\/x\/f/ }, type: "single" },
        input: "plan m/x/f",
      },
      // everyDayRe needs a separator: "every monday" matches and "tuesday" is left for chrono.
      {
        expected: { rrule: ["BYDAY=MO"], type: "recurring" },
        input: "standup every monday tuesday",
      },
      // JS \w is ASCII-only: "#café" captures "caf" and "é" stays in the title.
      {
        expected: {
          input: { tags: ["caf"] },
          inputMatches: { title: /é/ },
          type: "single",
        },
        input: "note #café",
      },
      {
        expected: {
          custom: (r) => {
            expect(r.input.title.length).toBeGreaterThan(900);
          },
          type: "single",
        },
        input: longToken,
      },
      // Every token type at once with adversarial whitespace; only checks that a result comes back.
      {
        expected: {
          custom: () => {},
          rrule: [],
          type: "recurring",
        },
        input: "  !urgent  every  other  tuesday  at  9am  for  30m  for  4  weeks  #a  #b  ~c  ",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // The lead itself: every unit spelling, the !rN shorthand, and the filler
  // words a person actually types around them.
  describe("reminder tokens — units and shorthand", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { reminderMinutes: [30], scheduledStart: "2026-03-16T15:00:00", title: "Dentist" },
          type: "single",
        },
        input: "Dentist tomorrow at 3pm remind 30m before",
      },
      {
        expected: { input: { reminderMinutes: [30], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 30 min before",
      },
      {
        expected: { input: { reminderMinutes: [45], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 45 minutes before",
      },
      {
        expected: { input: { reminderMinutes: [5], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 5 mins before",
      },
      {
        expected: { input: { reminderMinutes: [120], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 2h before",
      },
      {
        expected: { input: { reminderMinutes: [60], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 1 hr before",
      },
      {
        expected: { input: { reminderMinutes: [180], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 3 hours before",
      },
      {
        expected: { input: { reminderMinutes: [90], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 1.5h before",
      },
      {
        // A timed page keeps a day-lead as plain minutes — see the all-day block below.
        expected: { input: { reminderMinutes: [1440], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 1d before",
      },
      {
        expected: { input: { reminderMinutes: [2880], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 2 days before",
      },
      {
        expected: { input: { reminderMinutes: [30], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm !r30",
      },
      {
        expected: { input: { reminderMinutes: [90], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm !r90",
      },
      {
        expected: { input: { reminderMinutes: [60], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm !r1h",
      },
      {
        expected: { input: { reminderMinutes: [1440], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm !r1d",
      },
      {
        expected: { input: { reminderMinutes: [30], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind me 30 min before",
      },
      {
        expected: { input: { reminderMinutes: [15], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm reminder 15m before",
      },
      {
        expected: { input: { reminderMinutes: [10], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind me please 10 minutes beforehand",
      },
      {
        // "before" is optional — the word "remind" already said which direction.
        expected: { input: { reminderMinutes: [30], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm remind 30m",
      },
      {
        expected: { input: { reminderMinutes: [30], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow at 3pm REMIND 30M BEFORE",
      },
      {
        expected: { input: { reminderMinutes: [1440], title: "Ping team" }, type: "single" },
        input: "Ping team tomorrow at 2pm remind me a day before",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("reminder tokens — all-day vs timed resolution", () => {
    const cases: ParserCase[] = [
      {
        // All-day: no start time to count back from, so the lead becomes the
        // day-before anchor (pikos_db DAY_BEFORE_MINUTES = -2).
        expected: {
          input: { reminderMinutes: [-2], scheduledStart: "2026-03-16", title: "Dentist" },
          type: "single",
        },
        input: "Dentist tomorrow remind day before",
      },
      {
        expected: {
          input: { reminderMinutes: [-2], scheduledStart: "2026-03-16", title: "Dentist" },
          type: "single",
        },
        input: "Dentist tomorrow remind me the day before",
      },
      {
        expected: { input: { reminderMinutes: [-2], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow remind 1d before",
      },
      {
        // Even a minutes lead collapses: it is the only reminder an all-day page
        // can carry, and a 30-minute row on it would never fire.
        expected: { input: { reminderMinutes: [-2], title: "Dentist" }, type: "single" },
        input: "Dentist tomorrow !r30",
      },
      {
        expected: {
          input: { reminderMinutes: [-2], scheduledEnd: "2026-04-25", title: "vacation" },
          type: "single",
        },
        input: "vacation April 18-25 remind day before",
      },
      {
        expected: {
          input: { reminderMinutes: [1440], scheduledStart: "2026-03-16T15:00:00" },
          type: "single",
        },
        input: "Dentist tomorrow at 3pm remind day before",
      },
    ];
    it.each(cases)("$input", runCase);

    it("accumulates and dedupes multiple tokens, ascending", () => {
      const r = parseInput("Ship it tomorrow at 3pm remind 1h before remind 30m before", NOW);
      if (r.type !== "single") throw new Error("expected single");
      expect(r.input.reminderMinutes).toEqual([30, 60]);
      expect(r.input.title).toBe("Ship it");
    });

    it("dedupes a phrase and a shorthand naming the same lead", () => {
      const r = parseInput("Ship it tomorrow at 3pm remind 30m before !r30", NOW);
      if (r.type !== "single") throw new Error("expected single");
      expect(r.input.reminderMinutes).toEqual([30]);
    });

    it("carries the lead onto a recurring page", () => {
      const r = parseInput("Standup every weekday at 9am remind 15 min before", NOW);
      if (r.type !== "recurring") throw new Error("expected recurring");
      expect(r.input.reminderMinutes).toEqual([15]);
      expect(r.input.title).toBe("Standup");
    });

    it("gives every page of a finite series its own copy of the lead", () => {
      const r = parseInput("gym m/w/f 7am remind 30m before", NOW);
      if (r.type !== "finite") throw new Error("expected finite");
      expect(r.inputs.map((i) => i.reminderMinutes)).toEqual([[30], [30], [30]]);
      expect(r.inputs[0]!.reminderMinutes).not.toBe(r.inputs[1]!.reminderMinutes);
    });
  });

  describe("reminder tokens — nothing to anchor to", () => {
    const cases: ParserCase[] = [
      {
        // No schedule, so the words stay in the title rather than becoming a row
        // the scheduler could never fire.
        expected: {
          input: { title: "Call mom remind 30m before" },
          inputAbsent: ["reminderMinutes", "scheduledStart"],
          type: "single",
        },
        input: "Call mom remind 30m before",
      },
      {
        expected: {
          input: { title: "Call mom !r30" },
          inputAbsent: ["reminderMinutes"],
          type: "single",
        },
        input: "Call mom !r30",
      },
      {
        // "remind me to …" names no unit, so it is ordinary title text.
        expected: {
          input: { scheduledStart: "2026-03-16", title: "remind me to buy milk" },
          inputAbsent: ["reminderMinutes"],
          type: "single",
        },
        input: "remind me to buy milk tomorrow",
      },
      {
        // "in" is deliberately not a filler word, so chrono still gets the date.
        expected: {
          input: { scheduledStart: "2026-03-17", title: "Ping team remind me" },
          inputAbsent: ["reminderMinutes"],
          type: "single",
        },
        input: "Ping team remind me in 2 days",
      },
      {
        // Composes with the rest of the grammar without eating it.
        expected: {
          input: {
            durationMinutes: 120,
            reminderMinutes: [30],
            scheduledEnd: "2026-03-16T17:00:00",
            scheduledStart: "2026-03-16T15:00:00",
            title: "Groceries",
          },
          type: "single",
        },
        input: "Groceries for 2h tomorrow at 3pm remind 30 minutes before",
      },
      {
        expected: {
          input: {
            priority: "high",
            reminderMinutes: [15],
            tags: ["work"],
            title: "Ship",
          },
          type: "single",
        },
        input: "Ship #work !high tomorrow at 3pm !r15",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("body separator", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { content: "she likes the blue one", title: "Buy a gift" },
          type: "single",
        },
        input: "Buy a gift // she likes the blue one",
      },
      {
        // The body is verbatim: no tag, folder, priority or date is read out of it.
        expected: {
          input: {
            content: "remember #blue and ~folder !urgent tomorrow",
            tags: [],
            title: "Buy a gift",
          },
          inputAbsent: ["folderQuery", "priority", "scheduledStart"],
          type: "single",
        },
        input: "Buy a gift // remember #blue and ~folder !urgent tomorrow",
      },
      {
        expected: { input: { content: "b // c", title: "a" }, type: "single" },
        input: "a // b // c",
      },
      {
        expected: { input: { content: "just a note", title: "" }, type: "single" },
        input: "// just a note",
      },
      {
        expected: { input: { title: "Task" }, inputAbsent: ["content"], type: "single" },
        input: "Task //",
      },
      {
        expected: { input: { content: "line one\nline two", title: "Notes" }, type: "single" },
        input: "Notes // line one\nline two",
      },
      {
        // Whitespace on both sides is required — this is what keeps URLs intact.
        expected: {
          input: { scheduledStart: "2026-03-16", title: "check https://example.com/a//b" },
          inputAbsent: ["content"],
          type: "single",
        },
        input: "check https://example.com/a//b tomorrow",
      },
      {
        expected: {
          input: { title: "a//b" },
          inputAbsent: ["content"],
          type: "single",
        },
        input: "a//b",
      },
      {
        expected: {
          input: { content: "see https://example.com for #context", title: "Review PR" },
          type: "single",
        },
        input: "Review PR tomorrow at 2pm // see https://example.com for #context",
      },
      {
        expected: {
          input: { content: "tomorrow at 3pm", title: "Call" },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "Call // tomorrow at 3pm",
      },
      {
        // The title side keeps its full grammar.
        expected: {
          input: {
            content: "ask about the trip",
            scheduledStart: "2026-03-16T15:00:00",
            tags: ["family"],
            title: "Call mom",
          },
          type: "single",
        },
        input: "Call mom tomorrow at 3pm #family // ask about the trip",
      },
      {
        expected: {
          input: {
            content: "bring the insurance card",
            reminderMinutes: [30],
            scheduledStart: "2026-03-16T15:00:00",
            title: "Dentist",
          },
          type: "single",
        },
        input: "Dentist tomorrow at 3pm remind 30m before // bring the insurance card",
      },
      {
        // The body travels onto every page of a finite series.
        expected: {
          count: 3,
          eachInput: { content: "bring a towel", title: "gym" },
          type: "finite",
        },
        input: "gym m/w/f 7am // bring a towel",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // One representative test per top-level scenario.
  describe("scenario matrix — relative dates", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-16" }, type: "single" },
        input: "call tomorrow",
      },
      {
        expected: { input: { scheduledStart: "2026-03-18" }, type: "single" },
        input: "review in 3 days",
      },
      {
        expected: { input: { scheduledStart: "2026-03-16T14:00:00" }, type: "single" },
        input: "meeting next monday at 2pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T20:00:00" }, type: "single" },
        input: "dinner tonight",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — absolute dates", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-20" }, type: "single" },
        input: "file taxes march 20",
      },
      {
        expected: { input: { scheduledStart: "2026-03-20T15:00:00" }, type: "single" },
        input: "appt march 20 at 3pm",
      },
      {
        expected: { input: { scheduledStart: "2027-03-05" }, type: "single" },
        input: "dentist @march 5",
      },
      {
        expected: { input: { scheduledStart: "2026-04-15T10:00:00" }, type: "single" },
        input: "appt 4/15 at 10am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — N pages (finite recurrence)", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          count: 3,
          eachInput: { title: "gym" },
          inputs: [
            { scheduledStart: "2026-03-16T15:00:00" },
            { scheduledStart: "2026-03-18T15:00:00" },
            { scheduledStart: "2026-03-20T15:00:00" },
          ],
          type: "finite",
        },
        input: "gym m/w/f at 3pm",
      },
      {
        expected: {
          count: 5,
          inputs: [
            { scheduledStart: "2026-03-16T09:00:00" },
            { scheduledStart: "2026-03-17T09:00:00" },
            { scheduledStart: "2026-03-18T09:00:00" },
            { scheduledStart: "2026-03-19T09:00:00" },
            { scheduledStart: "2026-03-20T09:00:00" },
          ],
          type: "finite",
        },
        input: "standup weekdays at 9am 5 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — recurring schedules", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          rrule: ["FREQ=WEEKLY", "BYDAY=MO"],
          rruleAbsent: ["UNTIL=", "COUNT="],
          type: "recurring",
        },
        input: "standup every monday",
      },
      {
        expected: { rrule: ["UNTIL="], type: "recurring" },
        input: "standup every monday for 4 weeks",
      },
      {
        expected: { rrule: ["FREQ=DAILY"], type: "recurring" },
        input: "vitamin daily",
      },
      {
        expected: {
          input: { scheduledStart: "2026-03-17T09:00:00" },
          rrule: ["INTERVAL=2", "BYDAY=TU"],
          type: "recurring",
        },
        input: "standup every other tuesday morning",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — non-scheduled", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: { tags: [], title: "buy groceries" },
          inputAbsent: ["scheduledStart", "scheduledEnd", "folderQuery", "priority"],
          type: "single",
        },
        input: "buy groceries",
      },
      {
        expected: {
          input: {
            folderQuery: "Personal",
            priority: "low",
            tags: ["shopping"],
            title: "buy groceries",
          },
          inputAbsent: ["scheduledStart"],
          type: "single",
        },
        input: "buy groceries #shopping ~Personal !low",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — tags / priority / folder mix", () => {
    const cases: ParserCase[] = [
      {
        expected: {
          input: {
            folderQuery: "Engineering",
            priority: "high",
            tags: ["work", "urgent"],
            title: "team sync",
          },
          type: "single",
        },
        input: "!high #work #urgent ~Engineering team sync",
      },
      {
        expected: { input: { tags: ["a", "b", "c"] }, type: "single" },
        input: "note #a #b #c",
      },
      {
        expected: { input: { priority: "low" }, type: "single" },
        input: "task !urgent !low",
      },
      {
        expected: { input: { folderQuery: "B" }, type: "single" },
        input: "task ~A ~B",
      },
      // !0 explicitly clears priority. Folder last-wins ensures the user's
      // most-recent ~Folder choice takes effect.
      {
        expected: {
          input: { folderQuery: "B", priority: null },
          type: "single",
        },
        input: "task !urgent !0 ~A ~B",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  describe("scenario matrix — schema/UI mapping contract", () => {
    // Imperative rather than ParserCase-narrowed, since the assertions span all three result shapes.

    it("ParsedInput.title is always a string (never undefined)", () => {
      const inputs = ["", "   ", "buy groceries", "#tag #only", "tomorrow"];
      for (const s of inputs) {
        const r = parseInput(s, NOW);
        if (r.type === "single") expect(typeof r.input.title).toBe("string");
        else if (r.type === "recurring") expect(typeof r.input.title).toBe("string");
        else for (const inp of r.inputs) expect(typeof inp.title).toBe("string");
      }
    });

    it("scheduledStart shape: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS' or undefined", () => {
      const all = [
        parseInput("buy groceries", NOW),
        parseInput("tomorrow", NOW),
        parseInput("tomorrow at 3pm", NOW),
        parseInput("every monday morning", NOW),
      ];
      for (const r of all) {
        const start =
          r.type === "single"
            ? r.input.scheduledStart
            : r.type === "recurring"
              ? r.input.scheduledStart
              : r.inputs[0]?.scheduledStart;
        if (start === undefined) continue;
        expect(start).toMatch(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/);
      }
    });

    it("rrule (when present) is parseable by the recurrence engine", () => {
      const cases = [
        "standup every monday",
        "standup every other tuesday",
        "gym every weekday morning",
        "review every friday at 3pm for 4 weeks",
      ];
      for (const s of cases) {
        const r = parseInput(s, NOW);
        if (r.type !== "recurring") continue;
        expect(parseRrule(r.rrule)).not.toBeNull();
      }
    });

    it("priority is one of: 'urgent' | 'high' | 'medium' | 'low' | null | undefined", () => {
      const cases = ["task", "task !1", "task !urgent", "task !0", "task !5"];
      for (const s of cases) {
        const r = parseInput(s, NOW);
        if (r.type !== "single") continue;
        const p = r.input.priority;
        expect(
          p === undefined || p === null || ["urgent", "high", "medium", "low"].includes(p)
        ).toBe(true);
      }
    });

    it("tags is always an array", () => {
      const cases = ["task", "task #a", "task #a #b", "#a #b #c"];
      for (const s of cases) {
        const r = parseInput(s, NOW);
        if (r.type !== "single") continue;
        expect(Array.isArray(r.input.tags)).toBe(true);
      }
    });

    it("scheduledEnd is only ever set when scheduledStart is also set", () => {
      const cases = [
        "buy groceries",
        "meeting 3pm to 5pm",
        "vacation April 18-25",
        "every weekday 9am to 5pm",
      ];
      for (const s of cases) {
        const r = parseInput(s, NOW);
        const inp = r.type === "single" ? r.input : r.type === "recurring" ? r.input : r.inputs[0];
        if (!inp) continue;
        if (inp.scheduledEnd) expect(inp.scheduledStart).toBeDefined();
      }
    });
  });
});

describe("a rename leaves the date to the page's slot", () => {
  const rename = (s: string) => parseInput(s, NOW, { rename: true });

  it("reads tags, folder and priority out of the title", () => {
    expect(rename("standup #work ~projects !high")).toEqual({
      input: { folderQuery: "projects", priority: "high", tags: ["work"], title: "standup" },
      type: "single",
    });
  });

  it("reads a repeat without dating it", () => {
    const r = rename("standup every weekday");
    expect(r.type).toBe("recurring");
    if (r.type !== "recurring") return;
    expect(r.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(r.input).toEqual({ tags: [], title: "standup" });
  });

  it.each([
    ["a date", "prep for tomorrow"],
    ["a time", "call at 3pm"],
    ["a month name", "review March plan"],
    ["a duration", "focus for 30m"],
    ["a reminder", "pay rent remind me 1d before"],
    ["a body", "buy a gift // the blue one"],
    ["days without every", "gym m/w/f"],
    ["bare weekdays", "weekdays meeting"],
  ])("keeps %s in the title", (_, title) => {
    expect(rename(title)).toEqual({ input: { tags: [], title }, type: "single" });
  });
});

// Invariants for any generated input (about 100 random inputs per property, fixed seed so failures reproduce).

describe("parser invariants (property tests)", () => {
  it("never throws", () => {
    forAll(() => true, { runs: 200 });
  });

  it("title is always a string", () => {
    forAll((_, r) => {
      if (r.type === "single") return typeof r.input.title === "string";
      if (r.type === "recurring") return typeof r.input.title === "string";
      return r.inputs.every((i) => typeof i.title === "string");
    });
  });

  it("tags is always an array of strings", () => {
    forAll((_, r) => {
      const tags =
        r.type === "single"
          ? r.input.tags
          : r.type === "recurring"
            ? r.input.tags
            : r.inputs[0]?.tags;
      if (tags === undefined) return true;
      return Array.isArray(tags) && tags.every((t) => typeof t === "string");
    });
  });

  it("scheduledStart, when present, matches the date or datetime ISO shape", () => {
    forAll((_, r) => {
      const all = r.type === "single" ? [r.input] : r.type === "recurring" ? [r.input] : r.inputs;
      return all.every(
        (i) =>
          i.scheduledStart === undefined ||
          /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(i.scheduledStart)
      );
    });
  });

  it("scheduledEnd implies scheduledStart", () => {
    forAll((_, r) => {
      const all = r.type === "single" ? [r.input] : r.type === "recurring" ? [r.input] : r.inputs;
      return all.every((i) => !i.scheduledEnd || i.scheduledStart !== undefined);
    });
  });

  it("when scheduledEnd is set on a timed start, end >= start", () => {
    forAll((_, r) => {
      const all = r.type === "single" ? [r.input] : r.type === "recurring" ? [r.input] : r.inputs;
      return all.every((i) => {
        if (!i.scheduledStart || !i.scheduledEnd) return true;
        if (!i.scheduledStart.includes("T") || !i.scheduledEnd.includes("T")) return true;
        return new Date(i.scheduledEnd).getTime() >= new Date(i.scheduledStart).getTime();
      });
    });
  });

  it("priority is null, undefined, or one of the four labels", () => {
    forAll((_, r) => {
      const p =
        r.type === "single"
          ? r.input.priority
          : r.type === "recurring"
            ? r.input.priority
            : r.inputs[0]?.priority;
      return (
        p === undefined ||
        p === null ||
        p === "urgent" ||
        p === "high" ||
        p === "medium" ||
        p === "low"
      );
    });
  });

  it("recurring rrule is always parseable by the recurrence engine", () => {
    forAll((_, r) => {
      if (r.type !== "recurring") return true;
      return parseRrule(r.rrule) !== null;
    });
  });

  it("finite count matches inputs length", () => {
    forAll((_, r) => {
      if (r.type !== "finite") return true;
      return r.count === r.inputs.length;
    });
  });
});
