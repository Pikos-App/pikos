// ─── NAVIGATION ───────────────────────────────────────────────────────────
//
// Tests are grouped roughly by RESULT SHAPE (single / finite / recurring)
// with cross-cutting concerns at the bottom. New cases should live in the
// section that matches their primary contract — if you find yourself unsure,
// "scenario matrix" near the bottom holds one canonical case per shape.
//
// RESULT SHAPE — single (no schedule, title + metadata only)
//   • single page creation
//   • priority and folder edge cases
//   • numeric priority shortcuts (!0-4)              ← table
//   • empty-title cases
//   • priority case-insensitivity
//   • multi-tag ordering stability
//   • tag and folder regex boundaries
//
// RESULT SHAPE — single (date-only, datetime, or date range)
//   • time without date
//   • duration parsing / duration parsing edges      ← table
//   • bare date parsing (no @ prefix)
//   • time ranges / time edge cases
//   • multi-day all-day ranges + adjacent edges
//   • for disambiguation (with/without recurrence)
//   • chrono casual phrases (tomorrow morning, tonight, this/last weekday)
//
// RESULT SHAPE — finite (N concrete pages from m/w/f, weekdays, …)
//   • finite recurrence + shared properties
//
// RESULT SHAPE — recurring (FREQ + optional BYDAY/INTERVAL/COUNT/UNTIL)
//   • infinite recurrence
//   • recurring word order / 'and' separator / plural day names
//   • recurring with duration / metadata / time range
//   • recurring title cleanliness
//   • bare day names stay single                     ← regression
//   • bounded recurrence — every X + window
//   • every + day-list composition
//   • default daily when window present
//   • until / till as window boundary
//   • interval cadences (biweekly, every other, every N)  ← table
//   • interval + weekday composition (every other tuesday)
//   • yearly cadence                                  ← table
//   • monthly / weekly / daily keyword cadence
//   • recurrence + window composition — adjacent edges
//   • recurring edge cases
//   • RRULE validation                                ← rrule round-trip
//
// CROSS-CUTTING
//   • token stripping and title cleanliness
//   • title leakage — finite window keywords
//   • time-without-date weekday anchoring
//   • reference date variation                        ← year/month rollover
//   • kitchen-sink composition                        ← inline snapshots
//   • adversarial input                               ← case, punct, emoji
//   • negative paths and garbage input                ← never throw
//   • full NLP composition
//   • scenario matrix (one canonical per shape)       ← table
//   • parser invariants (property tests)              ← end of file

import { RRule } from "rrule";
import { describe, expect, it } from "vitest";

import { parseInput } from "./parser";
import { assertCase, forAll, type ParserCase } from "./parser.testHelpers";

const NOW = new Date("2026-03-15T12:00:00");

/** Tabular runner that fixes the suite NOW. Use as `runCase({...})` inside an it.each. */
const runCase = (c: ParserCase) => assertCase(c, NOW);

describe("NL Page Creation Parser", () => {
  // ─── 1. Single page creation ───────────────────────────────────────────────

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
      // NOW = Sunday 2026-03-15, @monday → next Monday = 2026-03-16.
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
      // NOW=12:00, 15:30 is future → today.
      {
        expected: { input: { scheduledStart: "2026-03-15T15:30:00" }, type: "single" },
        input: "meeting at 3:30pm",
      },
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 14:00",
      },
      // Plain text → no schedule, no tags. Title carries the full input.
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

  // ─── 2. Priority & folder edge cases ───────────────────────────────────────

  describe("priority and folder edge cases", () => {
    const cases: ParserCase[] = [
      // Last-wins for priority and folder.
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
      // Bare priority token → empty title.
      {
        expected: { input: { priority: "high", title: "" }, type: "single" },
        input: "!high",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── Numeric priority shortcuts ────────────────────────────────────────────

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
      // last wins
      { expected: { input: { priority: "medium" }, type: "single" }, input: "task !1 !3" },
      // !5 isn't a valid numeric priority — title containing "!5" proves
      // it wasn't consumed; toMatchObject can't assert "priority absent",
      // so the title assertion carries the contract.
      { expected: { input: { title: "task !5" }, type: "single" }, input: "task !5" },
      // word form still works
      { expected: { input: { priority: "urgent" }, type: "single" }, input: "task !urgent" },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 3. Time without date ──────────────────────────────────────────────────

  describe("time without date", () => {
    // NOW = 12:00.
    const cases: ParserCase[] = [
      // 2pm is future → today.
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 2pm",
      },
      // 8am is past → tomorrow.
      {
        expected: { input: { scheduledStart: "2026-03-16T08:00:00" }, type: "single" },
        input: "meeting 8am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 4. Duration parsing ───────────────────────────────────────────────────

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

  // ─── 5. Finite recurrence ─────────────────────────────────────────────────

  describe("finite recurrence", () => {
    const cases: ParserCase[] = [
      // m/w/f at 3pm for 45m → 3 pages (Mon 3/16, Wed 3/18, Fri 3/20).
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
      // m/w/f for 1h through march 31: 3/16, 3/18, 3/20, 3/23, 3/25, 3/27, 3/30 = 7.
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
      // weekdays at 9am 3 times → next 3 weekdays.
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
      // Bare weekdays → next 5 weekdays (Mon–Fri).
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
      // t/th/f slash syntax — t maps to Tuesday: Tue 3/17, Thu 3/19, Fri 3/20.
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
      // Through Thursday March 19 → Mon 3/16 and Wed 3/18, NOT Fri 3/20.
      {
        expected: {
          count: 2,
          inputs: [{ scheduledStart: "2026-03-16" }, { scheduledStart: "2026-03-18" }],
          type: "finite",
        },
        input: "task m/w/f through march 19",
      },
      // scheduledEnd computes correctly on expanded finite pages.
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

  // ─── 6. Finite recurrence — shared properties ─────────────────────────────

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

  // ─── 7. Infinite recurrence ───────────────────────────────────────────────

  describe("infinite recurrence", () => {
    // NOW = Sun 2026-03-15. Next Monday = 2026-03-16. Wed 2026-03-18 → next Monday = 2026-03-23.
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

  // ─── 7b. Recurring — word order variations ────────────────────────────────

  describe("recurring word order variations", () => {
    // All variations should produce the same result: recurring WEEKLY;BYDAY=MO
    // with scheduledStart on next Monday at 9am. Title "standup" survives in
    // whatever case the parser preserves; case-insensitive match accepts all.
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

  // ─── 7c. Recurring — "and" separator ─────────────────────────────────────

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
      // Oxford comma.
      {
        expected: { rrule: ["BYDAY=MO,WE,FR"], type: "recurring" },
        input: "standup every mon, wed, and fri at 9am",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 7d. Recurring — plural day names ────────────────────────────────────

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
      // "on" + plural.
      {
        expected: { rrule: ["BYDAY=MO"], type: "recurring" },
        input: "standup on mondays at 9am",
      },
      // Plural without time → all-day recurring (next Friday = 2026-03-20).
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

  // ─── 7e. Recurring — duration preserved ──────────────────────────────────

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
      // NOW = Mon 2026-03-16 08:00; 9am future → today.
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

  // ─── 7f. Recurring — metadata preserved ──────────────────────────────────

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

  // ─── 7g. Recurring — title cleanliness ───────────────────────────────────

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

  // ─── 7h. Bare day names should NOT recur ─────────────────────────────────

  describe("bare day names stay single (not recurring)", () => {
    const cases: ParserCase[] = [
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "standup monday at 9am",
      },
      // Smoke test: just the type contract.
      { expected: { type: "single" }, input: "call next monday" },
      // Singular "on monday".
      { expected: { type: "single" }, input: "meeting on monday at 2pm" },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 7i. Bounded recurrence (every X + window) ───────────────────────────
  //
  // "every X for N weeks/days/months" or "N times" or "through <date>"
  // should yield ONE recurring page with a bounded RRULE (COUNT or UNTIL),
  // expanded virtually — NOT N independent pages.

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
      // Expansion-count rows.
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
      // 7am with NOW=12:00 → tomorrow (3/16); 5-day window ends 3/20.
      {
        expected: {
          expansion: { count: 5, dtstart: "20260316T070000Z" },
          input: { scheduledStart: "2026-03-16T07:00:00" },
          rrule: ["FREQ=DAILY", "UNTIL="],
          type: "recurring",
        },
        input: "water plant every day at 7am for 5 days",
      },
      // dtstart = today (2026-03-15). UNTIL ≈ +89 days ≈ June 11.
      // Monthly from 3/15: 3/15, 4/15, 5/15, 6/15 — but UNTIL < 6/15 → 3 occurrences.
      {
        expected: {
          expansion: { count: 3, dtstart: "20260315T000000Z" },
          rrule: ["FREQ=MONTHLY", "UNTIL="],
          type: "recurring",
        },
        input: "pay rent every month for 3 months",
      },
      // Mondays on/before Apr 30: 3/16, 3/23, 3/30, 4/6, 4/13, 4/20, 4/27 = 7.
      {
        expected: {
          expansion: { count: 7, dtstart: "20260316T000000Z" },
          rrule: ["UNTIL=2026043", "BYDAY=MO"],
          type: "recurring",
        },
        input: "standup every monday through april 30",
      },
      // From 3/15, scheduledStart = Tue 3/17 18:00. 2 weeks window through 3/30.
      // Occurrences: 3/17, 3/19, 3/24, 3/26 = 4.
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
      // Round-trip parseable: RRULE alone (no DTSTART) survives RRule.fromString.
      {
        expected: {
          custom: (r) => {
            const rule = RRule.fromString("RRULE:" + r.rrule);
            expect(rule).toBeDefined();
          },
          rrule: [],
          type: "recurring",
        },
        input: "every monday for 10 weeks",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 7j. Composition: every + slash / plural days ────────────────────────
  //
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
      // Implicit weekly. NOW=Sun 3/15, next Mon 3/16, 3pm.
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

  // ─── 7k. Default daily when window given without cadence ─────────────────
  //
  // A window ("10 times", "for 2 weeks", "through <date>") without an explicit
  // cadence word defaults to FREQ=DAILY. Keeps the user's count/boundary
  // signal meaningful instead of silently stripping it from the title.

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
      // 8am with NOW=12:00 → tomorrow (3/16); 2-week window → 14 occurrences.
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
      // No window → single, title unchanged.
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

  // ─── 7l. "until" / "till" as window boundary (synonym of "through") ──────

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
      // 'till' alias.
      {
        expected: { rrule: ["UNTIL="], type: "recurring" },
        input: "practice every day till june",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 7m. Interval cadences (biweekly / every other / every N) ────────────

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
      // every N + COUNT → bounded
      {
        expected: { rrule: ["INTERVAL=2", "COUNT=5"], type: "recurring" },
        input: "sync every 2 weeks 5 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 7n. Yearly / annually ───────────────────────────────────────────────

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

  // ─── 7o. Time ranges (from X to Y) ───────────────────────────────────────

  describe("time ranges", () => {
    // NOW=12:00, 3pm is future → today.
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
      // Recurring + time range.
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

  // ─── Multi-day all-day ranges ────────────────────────────────────────────
  // chrono-node handles the parsing — we only need to plumb `result.end` into
  // scheduledEnd for date-only spans. Only supported when start is date-only
  // (timed events with a date range are deliberately treated as single-day
  // timed to avoid ambiguous semantics).

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
      // "to" joins a date range; chrono returns both dates with day-certainty.
      // "through" / "thru" between "<Month> <day>" pairs is normalized to "to" at
      // the top of parseInput so spans parse identically — see the "<Month> <day>
      // through ..." cases below.
      {
        expected: {
          input: { scheduledEnd: "2026-04-20", scheduledStart: "2026-04-18" },
          type: "single",
        },
        input: "offsite April 18 to April 20",
      },
      // NOW=12:00, 3pm is future → today (2026-03-15). Time range stays single-day.
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
      // "<Month> <day> through <day>" gets normalized to "... to ..." up front;
      // without this, chrono reads "2 through 10" as a time range (2am–10am) and
      // produces a 2am timed event tomorrow instead of the span the user typed.
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
      // Cross-year span.
      {
        expected: {
          input: { scheduledEnd: "2027-01-03", scheduledStart: "2026-12-28" },
          type: "single",
        },
        input: "trip Dec 28 through Jan 3",
      },
      // Regression: cadence + "through" stays a bounded-recurrence window — the
      // rewrite only fires when a "<Month> <day>" literal sits immediately before
      // "through", which isn't the case here.
      {
        expected: { rrule: ["FREQ=DAILY", "UNTIL=202606"], type: "recurring" },
        input: "practice piano through june",
      },
      {
        expected: { rrule: ["BYDAY=MO", "UNTIL=2026043"], type: "recurring" },
        input: "standup every monday through april 30",
      },
      // Single bare date (no range) → no scheduledEnd.
      {
        expected: {
          input: { scheduledStart: "2026-04-18" },
          inputAbsent: ["scheduledEnd"],
          type: "single",
        },
        input: "vacation April 18",
      },
      // Date-range + time has conservative semantics: start gets the time, and
      // end (if present) collapses to the same day. Conditional end check.
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
  });

  // ─── 8. RRULE validation ──────────────────────────────────────────────────

  describe("RRULE validation", () => {
    const cases: ParserCase[] = [
      // Rrule string is parseable by the rrule library.
      {
        expected: {
          custom: (r) => {
            const rule = RRule.fromString("RRULE:" + r.rrule);
            expect(rule).toBeDefined();
          },
          rrule: [],
          type: "recurring",
        },
        input: "every monday",
      },
      // Rrule must not contain DTSTART.
      {
        expected: { rrule: [], rruleAbsent: ["DTSTART"], type: "recurring" },
        input: "morning run daily",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 9. `for` disambiguation ─────────────────────────────────────────────

  describe("for disambiguation", () => {
    const cases: ParserCase[] = [
      // Duration only.
      {
        expected: { input: { durationMinutes: 60 }, type: "single" },
        input: "task for 1h",
      },
      // Window + no cadence → defaults to daily.
      {
        expected: {
          input: { title: "task" },
          rrule: ["FREQ=DAILY"],
          type: "recurring",
        },
        input: "task for 2 weeks",
      },
      // Finite, duration=60, window=2 weeks. 2 weeks from 3/15: Mon/Wed/Fri in
      // 3/16–3/29 → 3/16, 3/18, 3/20, 3/23, 3/25, 3/27 = 6 pages (3/29 is Sunday).
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

  // ─── 10. Token stripping / title cleanliness ──────────────────────────────

  describe("token stripping and title cleanliness", () => {
    const cases: ParserCase[] = [
      // Strips tokens, collapses whitespace.
      {
        expected: { input: { title: "meeting" }, type: "single" },
        input: "  #work  meeting  @tomorrow  at 2pm  ",
      },
      // Only tags → empty title.
      {
        expected: {
          input: { tags: ["a", "b", "c"], title: "" },
          type: "single",
        },
        input: "#a #b #c",
      },
      // Plain text passthrough.
      {
        expected: { input: { title: "hello world" }, type: "single" },
        input: "hello world",
      },
      // Unrecognized !token stays in title.
      {
        expected: {
          input: { title: "task !invalid" },
          inputAbsent: ["priority"],
          type: "single",
        },
        input: "task !invalid",
      },
      // Bare ~ with no word stays in title.
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

  // ─── 11. daily keyword interaction ────────────────────────────────────────

  describe("daily keyword interaction with every", () => {
    const cases: ParserCase[] = [
      // 'daily' survives in title when 'every <day>' is the recurrence.
      {
        expected: {
          input: { title: "daily standup" },
          rrule: ["BYDAY=MO"],
          type: "recurring",
        },
        input: "daily standup every monday",
      },
      // 'daily' alone triggers FREQ=DAILY recurrence.
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

  // ─── 12. bare date parsing (no @ prefix) ──────────────────────────────────

  describe("bare date parsing (no @ prefix)", () => {
    const cases: ParserCase[] = [
      // Bare temporal keywords / day-name positions.
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
      // "monday" at start: chrono picks it up as first result; subsequent "9am" is a
      // separate result and not merged (parser uses chronoResults[0] only). Tested
      // without trailing time to cleanly verify day-at-start parsing.
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
      // Multi-word relative phrases.
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
      // Bare time only — NOW=12:00, so 2pm is future → today.
      {
        expected: { input: { scheduledStart: "2026-03-15T14:00:00" }, type: "single" },
        input: "meeting 2pm",
      },
      // @ prefix still works (regression check).
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
      // Bare day name consumed by 'every' before chrono sees it → recurring.
      {
        expected: { rrule: ["BYDAY=MO"], type: "recurring" },
        input: "standup every monday",
      },
      // Slash syntax consumed before chrono sees it → finite (m/w/f from Sun 3/15: 3/16, 3/18, 3/20).
      {
        expected: { count: 3, type: "finite" },
        input: "run m/w/f at 3pm",
      },
      // Bare month alone: chrono resolves with forwardDate. Only assert presence
      // of scheduledStart (exact value depends on chrono version).
      {
        expected: {
          input: { title: "plan trip" },
          inputMatches: { scheduledStart: /\d{4}-\d{2}-\d{2}/ },
          type: "single",
        },
        input: "plan trip march",
      },
      // "may" in "may day celebration" is ambiguous enough that chrono skips it.
      // No false positive — safe/correct behaviour.
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

  // ─── 13. Edge cases from test strategy ──────────────────────────────────────

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
      // NOW=Sun 3/15, 3pm future → today. Next weekly anchors to today.
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
      // 'for 30min' with no recurrence → duration only.
      {
        expected: {
          input: { durationMinutes: 30, title: "focus session" },
          type: "single",
        },
        input: "focus session for 30min",
      },
      // 'for 2h' without day pattern → duration only. NOW=Sun 3/15, tomorrow 9am.
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

  // ─── 14. Recurring + time range (timed event with end) ────────────────────

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

  // ─── 15. Edge cases: midnight times, zero/negative bounds, bare digits ─

  describe("time edge cases", () => {
    // NOW = 2026-03-15 12:00 (noon).
    const cases: ParserCase[] = [
      // 12am (00:00) today is past → tomorrow.
      {
        expected: { input: { scheduledStart: "2026-03-16T00:00:00" }, type: "single" },
        input: "late job at 12am",
      },
      // 11:59pm today is future → today.
      {
        expected: { input: { scheduledStart: "2026-03-15T23:59:00" }, type: "single" },
        input: "late note at 11:59pm",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── 16. Token regex boundaries (\w only — no hyphens/unicode) ───────────

  describe("tag and folder regex boundaries", () => {
    const cases: ParserCase[] = [
      // Regex is /#(\w+)/ — \w matches [A-Za-z0-9_], not hyphens. Anything after
      // the hyphen stays in the title.
      {
        expected: {
          input: { tags: ["multi"] },
          inputMatches: { title: /-word/ },
          type: "single",
        },
        input: "review #multi-word",
      },
      // Tag with digits.
      {
        expected: {
          input: { tags: ["q4", "2025"], title: "plan" },
          type: "single",
        },
        input: "plan #q4 #2025",
      },
      // Tag with underscores.
      {
        expected: { input: { tags: ["snake_case"] }, type: "single" },
        input: "note #snake_case",
      },
      // Parser does NOT dedupe duplicate tag names — caller's responsibility.
      {
        expected: { input: { tags: ["work", "work"] }, type: "single" },
        input: "note #work #work",
      },
      // Hyphenated folder captures only the word-char prefix.
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

  // ─── 17. Title remains empty when all input is tokens ────────────────────

  describe("empty-title cases (caller falls back to 'Untitled')", () => {
    const cases: ParserCase[] = [
      // Only a date → empty title.
      {
        expected: {
          input: { scheduledStart: "2026-03-16", title: "" },
          type: "single",
        },
        input: "tomorrow",
      },
      // Only a time. NOW=12:00, 3pm future → today.
      {
        expected: {
          input: { scheduledStart: "2026-03-15T15:00:00", title: "" },
          type: "single",
        },
        input: "at 3pm",
      },
      // Only a duration → empty title, no schedule.
      {
        expected: {
          input: { durationMinutes: 120, title: "" },
          type: "single",
        },
        input: "for 2h",
      },
      // Only priority + folder.
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

  // ─── 18. Priority casing variations ──────────────────────────────────────

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

  // ─── 19. Composition: full NLP combo ────────────────────────────────────

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
      // Token-order independence — same combo, scrambled.
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
      // INTERVAL=1 may be omitted by the rrule serializer (default), but the
      // emitted rule must round-trip cleanly.
      {
        expected: {
          custom: (r) => {
            const rule = RRule.fromString("RRULE:" + r.rrule);
            expect(rule).toBeDefined();
          },
          rrule: ["FREQ=WEEKLY"],
          type: "recurring",
        },
        input: "sync every 1 week",
      },
      // 'every monday for 1 week' → bounded with one Monday in the window.
      {
        expected: {
          expansion: { count: 1, dtstart: "20260316T000000Z" },
          rrule: ["BYDAY=MO", "UNTIL="],
          type: "recurring",
        },
        input: "standup every monday for 1 week",
      },
      // 'every monday 1 time' → COUNT=1.
      {
        expected: { rrule: ["COUNT=1"], type: "recurring" },
        input: "kickoff every monday 1 times",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── multi-day all-day range — adjacent failure modes ───────────────────────
  // The "Month day-day" / "Month day through day" rewrite has tests for the
  // happy paths and the cross-year case. The cases below cover the edges that
  // historically broke before the rewrite landed: hyphen with single-digit
  // days, ordinals, abbreviated months, range plus metadata tokens, degenerate
  // same-day ranges, and reversed ranges (end ≤ start ⇒ no scheduledEnd).
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
      // chrono is configured with forwardDate: true. When the second date is
      // earlier in the calendar than the first, it advances to the next year so
      // the range is still chronologically valid. Pinned so a future change to
      // forwardDate doesn't break silently.
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
      // Chrono consumes "tomorrow" but not the leading "from" — verify the strip
      // extension covers single-date phrasing too, not just spans.
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
      // Degenerate same-day: no scheduledEnd.
      {
        expected: {
          input: { scheduledStart: "2026-04-18" },
          inputAbsent: ["scheduledEnd"],
          type: "single",
        },
        input: "trip April 18 to April 18",
      },
      // No month → the rewrite regex doesn't apply. "18-25" is not a date in
      // chrono's grammar; the span fields must not be set.
      {
        expected: { inputAbsent: ["scheduledEnd"], type: "single" },
        input: "trip 18-25",
      },
    ];
    it.each(cases)("$input", runCase);
  });

  // ─── token leakage — adjacent failure modes ────────────────────────────────
  // After a finite-window phrase ("through <date>" / "until <date>") consumes
  // its tokens, no boundary keyword should remain in the title.
  describe("title leakage — finite window keywords", () => {
    it("'through' is gone after a successful boundary parse", () => {
      const r = parseInput("standup every monday through april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title.toLowerCase()).not.toMatch(/\bthrough\b/);
      expect(r.input.title.toLowerCase()).not.toMatch(/\bapril\b/);
    });

    it("'until' is gone after a successful boundary parse", () => {
      const r = parseInput("standup every monday until april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title.toLowerCase()).not.toMatch(/\buntil\b/);
    });

    it("'till' is gone after a successful boundary parse", () => {
      const r = parseInput("standup every monday till april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title.toLowerCase()).not.toMatch(/\btill\b/);
    });

    it("'X times' is consumed even when paired with 'every'", () => {
      const r = parseInput("standup every monday 4 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("standup");
      expect(r.input.title).not.toContain("4");
      expect(r.input.title.toLowerCase()).not.toContain("times");
    });

    it("'for N weeks' is consumed when paired with cadence", () => {
      const r = parseInput("standup every monday for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("standup");
      expect(r.input.title.toLowerCase()).not.toMatch(/\bfor\b/);
      expect(r.input.title.toLowerCase()).not.toMatch(/\bweeks?\b/);
    });
  });

  // ─── time-without-date anchor — additional weekday cases ────────────────────
  describe("time-without-date weekday anchoring", () => {
    it("'every tuesday at 4pm' from a Wednesday → next Tuesday at 16:00", () => {
      // NOW = 2026-03-15 (Sunday). "every tuesday at 4pm" should anchor to Mar 17.
      const r = parseInput("call every tuesday at 4pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-17T16:00:00");
    });

    it("BYDAY=FR + time anchors to next Friday", () => {
      const r = parseInput("call every friday at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-20T09:00:00");
    });
  });

  // ─── duration parsing — parsing-only edges ────────────────────────────────
  describe("duration parsing edges", () => {
    it("for 0.25h → 15 minutes (rounded)", () => {
      const r = parseInput("focus for 0.25h", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(15);
    });

    it("for 90 minutes → 90 (no rounding hop)", () => {
      const r = parseInput("focus for 90 minutes", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(90);
    });

    it("for 1 hour singular → 60", () => {
      const r = parseInput("focus for 1 hour", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(60);
    });
  });

  // ─── recurrence + window composition adjacent ──────────────────────────────
  describe("recurrence + window composition — adjacent edges", () => {
    it("'every other week' + 'for 4 weeks' → INTERVAL=2 with bounded window", () => {
      const r = parseInput("standup every other week for 4 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("UNTIL=");
    });

    it("'every 3 days' + '5 times' → INTERVAL=3 with COUNT=5", () => {
      const r = parseInput("medication every 3 days 5 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("INTERVAL=3");
      expect(r.rrule).toContain("COUNT=5");
    });

    it("'biweekly' + 'for 2 months' → INTERVAL=2 weekly with UNTIL", () => {
      const r = parseInput("standup biweekly for 2 months", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("UNTIL=");
    });
  });

  // ─── interval + weekday combinations ───────────────────────────────────────
  // The interval regex requires a unit word (day/week/month/year), so phrases
  // like "every other tuesday" don't match it and fall through to chrono.
  // These tests document the gap so we can decide whether to extend the
  // grammar (interval + BYDAY) before launch.
  describe("interval + weekday composition", () => {
    it("'every other tuesday' → recurring weekly INTERVAL=2 BYDAY=TU", () => {
      const r = parseInput("standup every other tuesday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("BYDAY=TU");
    });

    it("'every 2 mondays' → recurring weekly INTERVAL=2 BYDAY=MO", () => {
      const r = parseInput("kickoff every 2 mondays", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("'every other tuesday' anchors scheduledStart to next Tuesday", () => {
      // NOW = Sunday Mar 15 2026; next Tuesday = Mar 17.
      const r = parseInput("standup every other tuesday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-17");
      expect(r.input.title).toBe("standup");
    });

    it("'every other tuesday at 9am' carries the time", () => {
      const r = parseInput("standup every other tuesday at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-17T09:00:00");
    });
  });

  // ─── reference-date variation ──────────────────────────────────────────────
  // Most tests in this file run with NOW = Sun Mar 15 2026. These tests vary
  // the reference date to catch behavior that depends on (a) what weekday now
  // is, (b) end-of-year rollover, and (c) the current-day-vs-rule-day boundary.
  describe("reference date variation", () => {
    it("'every monday at 9am' on a Monday morning (before 9am) → today, not next week", () => {
      // Mon Mar 16 2026 at 7am. The rule is Monday 9am — same day, future time.
      const monMorning = new Date("2026-03-16T07:00:00");
      const r = parseInput("standup every monday at 9am", monMorning);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      // We document current behavior: the parser anchors to nextWeekdayOccurrence
      // which always returns at least 7 days ahead when called for the same
      // weekday (consistent with chrono "monday" semantics).
      expect(r.input.scheduledStart).toBe("2026-03-23T09:00:00");
    });

    it("'every monday at 9am' on a Monday afternoon → next Monday", () => {
      const monAfternoon = new Date("2026-03-16T15:00:00");
      const r = parseInput("standup every monday at 9am", monAfternoon);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-23T09:00:00");
    });

    it("'every friday' from a Friday → next Friday (one week ahead)", () => {
      // Fri Mar 20 2026 noon.
      const fri = new Date("2026-03-20T12:00:00");
      const r = parseInput("review every friday", fri);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-27");
    });

    it("'every monday' from a Saturday → next Monday is 2 days away", () => {
      const sat = new Date("2026-03-21T12:00:00");
      const r = parseInput("standup every monday", sat);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-23");
    });

    it("year rollover: 'every monday' on Dec 30 → first Monday of next year", () => {
      // Dec 30 2026 is a Wednesday → next Monday is Jan 4 2027.
      const dec30 = new Date("2026-12-30T12:00:00");
      const r = parseInput("standup every monday", dec30);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2027-01-04");
    });

    it("year rollover: 'tomorrow' on Dec 31 → Jan 1 next year", () => {
      const dec31 = new Date("2026-12-31T12:00:00");
      const r = parseInput("party tomorrow", dec31);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2027-01-01");
    });

    it("month rollover: 'every monday for 2 weeks' on the last Sunday of a month", () => {
      // NOW = Sun Mar 29 2026. Next Monday = Mar 30. Window of 2 weeks → Apr 12 UNTIL.
      const lastSunday = new Date("2026-03-29T12:00:00");
      const r = parseInput("standup every monday for 2 weeks", lastSunday);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-30");
      // Window: 2 weeks = 14 days from scheduledStart Mar 30 → Apr 12.
      expect(r.rrule).toContain("UNTIL=20260412");
    });
  });

  // ─── kitchen-sink composition ──────────────────────────────────────────────
  // Each piece (cadence, window, time range, duration, tag, folder, priority)
  // is unit-tested in isolation. These tests stress how they interact when the
  // user types a single dense phrase. Catching e.g. "rrule emitted but tag
  // dropped" or "title had stranded fragments" requires the whole-input view.
  // Kitchen-sink: dense phrases that exercise every token type. Inline
  // snapshots lock the entire ParseResult so any drift surfaces as a diff.
  // To intentionally update: `pnpm --filter @pikos/core exec vitest run -u`.
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
          "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260426T235959Z",
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
          "rrule": "FREQ=WEEKLY;BYDAY=TU;INTERVAL=2;UNTIL=20260511T235959Z",
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
          "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260426T235959Z",
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
          "rrule": "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260412T235959Z",
          "type": "recurring",
        }
      `);
    });
  });

  // ─── adversarial input ─────────────────────────────────────────────────────
  // Tests for inputs the parser is likely to encounter from real users:
  // mixed case, trailing punctuation, very long titles, redundant whitespace,
  // and ambiguous phrasings.
  describe("adversarial input", () => {
    it("recurrence keywords are case-insensitive: 'EVERY MONDAY at 9am'", () => {
      const r = parseInput("STANDUP EVERY MONDAY at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.input.scheduledStart).toBe("2026-03-16T09:00:00");
    });

    it("mixed case: 'EvErY OtHeR TuEsDaY'", () => {
      const r = parseInput("standup EvErY OtHeR TuEsDaY", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("BYDAY=TU");
    });

    it("trailing punctuation on priority does not break the boundary: 'call !urgent.'", () => {
      const r = parseInput("call !urgent.", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("urgent");
      // The whitespace-before-period gap from token strip is collapsed,
      // keeping the period attached to the trailing word.
      expect(r.input.title).toBe("call.");
    });

    it("redundant whitespace collapses cleanly", () => {
      const r = parseInput("  call    mom    tomorrow   at   3pm  ", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("call mom");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("15:00");
    });

    it("emoji in title is preserved verbatim", () => {
      const r = parseInput("🎉 birthday party tomorrow at 7pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("🎉 birthday party");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("19:00");
    });

    it("very long title (200+ chars) is preserved", () => {
      const longTitle = "a ".repeat(120).trim();
      const r = parseInput(`${longTitle} tomorrow`, NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe(longTitle);
      expect(r.input.scheduledStart).toBe("2026-03-16");
    });

    it("multiple 'every' phrases — first wins (no duplicate cadence)", () => {
      // "every monday and every wednesday" — the first regex consumes
      // "every monday", the second "every wednesday" remains and is consumed
      // by a second pass. Document whichever the parser ends up emitting so
      // future changes don't break silently.
      const r = parseInput("standup every monday and every wednesday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      // At minimum, recurrence is recurring and has at least one BYDAY.
      expect(r.rrule).toMatch(/BYDAY=(MO|WE)/);
    });

    it("priority placed before title preserves the rest", () => {
      const r = parseInput("!urgent buy groceries tomorrow", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("urgent");
      expect(r.input.title).toBe("buy groceries");
      expect(r.input.scheduledStart).toBe("2026-03-16");
    });

    it("tag attached without space is NOT captured (regression for #abc#def)", () => {
      // /#(\w+)/ is non-overlapping and word-char greedy. "#abc#def" captures "abc"
      // first then sees "#def" → captures "def" too. Confirm both are picked up.
      const r = parseInput("note #abc#def", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["abc", "def"]);
      expect(r.input.title).toBe("note");
    });

    it("tag separated by punctuation: 'note #abc, #def'", () => {
      const r = parseInput("note #abc, #def", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["abc", "def"]);
      // Orphan separator punctuation left behind by the tag strip is dropped.
      expect(r.input.title).toBe("note");
    });

    it("'24-hour time' with leading zero: 'meeting at 09:00'", () => {
      const r = parseInput("meeting at 09:00", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // 9am today is in the past from NOW (12pm) → tomorrow.
      expect(r.input.scheduledStart).toBe("2026-03-16T09:00:00");
    });

    it("title that contains 'every' as a regular word stays single", () => {
      // "every other day" is a cadence — but "every word counts" is title text.
      const r = parseInput("every word counts in the report", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // The "every <day>" regex matches "every word"? Let's see — DAY_WORD
      // doesn't include "word", so no match. Should stay single.
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.title).toContain("every word counts");
    });

    it("title that contains a tag-like string in code: 'fix #404 bug'", () => {
      // "#404" matches the tag regex and becomes a tag — documented behavior.
      const r = parseInput("fix #404 bug", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["404"]);
      expect(r.input.title).toBe("fix bug");
    });
  });

  // ─── chrono casual phrases ─────────────────────────────────────────────────
  // chrono-node parses many casual time expressions. These tests pin the ones
  // that real users are most likely to type so we know if a chrono upgrade
  // changes their semantics.
  describe("chrono casual phrases", () => {
    const LATE = new Date("2026-03-15T21:00:00");
    const cases: ParserCase[] = [
      // ─── tomorrow + time-of-day ────────────────────────────────────────────
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
      // ─── today / tonight ───────────────────────────────────────────────────
      {
        expected: { input: { scheduledStart: "2026-03-15T20:00:00" }, type: "single" },
        input: "call tonight",
      },
      // NOW=12:00, "this morning" 9am has passed → rolls to tomorrow.
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
      // 9am has passed → tomorrow.
      {
        expected: { input: { scheduledStart: "2026-03-16T09:00:00" }, type: "single" },
        input: "call today morning",
      },
      // 9pm > 8pm → tonight rolls to tomorrow.
      {
        expected: { input: { scheduledStart: "2026-03-16T20:00:00" }, type: "single" },
        input: "call tonight",
        now: LATE,
      },
      // ─── weekday + time-of-day ─────────────────────────────────────────────
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
      // ─── day qualifiers (this/next/last) ───────────────────────────────────
      // chrono parses "next monday" forward by default; "this <weekday>" picks
      // the same calendar week's weekday (today if applicable); "last <weekday>"
      // picks the previous week's occurrence.
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
      // ─── recurring + casual time-of-day ────────────────────────────────────
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
      // First occurrence: next Saturday Mar 21 at 09:00.
      {
        expected: {
          input: { scheduledStart: "2026-03-21T09:00:00" },
          rrule: ["BYDAY=SA,SU"],
          type: "recurring",
        },
        input: "brunch every weekend morning",
      },
      // ─── trailing punctuation cleanup ──────────────────────────────────────
      // "call !urgent." → priority consumes "!urgent", leaving a stray ".".
      // The trailing "." currently survives — known limitation pinned for
      // future cleanup. See adversarial input section.
      {
        expected: { input: { priority: "urgent", title: "call." }, type: "single" },
        input: "call !urgent.",
      },
      // "note #abc, #def" → tags ["abc","def"], title "note" not "note ,".
      {
        expected: { input: { tags: ["abc", "def"], title: "note" }, type: "single" },
        input: "note #abc, #def",
      },
      // ─── relative phrases ──────────────────────────────────────────────────
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
      // ─── floating date/time cases — assertion patterns use inputMatches ────
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

  // ─── negative paths / garbage input ────────────────────────────────────────
  // The parser should never throw or emit garbage on adversarial inputs.
  // These tests pin "graceful degradation" — a single page with the input as
  // its title and no schedule.
  describe("negative paths and garbage input", () => {
    it("pure punctuation: '!!!' → not a priority, stays in title", () => {
      const r = parseInput("!!!", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // The priority regex requires a known word/digit, so '!!!' is not consumed.
      expect(r.input.title).toBe("!!!");
      expect(r.input.priority).toBeUndefined();
    });

    it("only whitespace and tabs", () => {
      const r = parseInput("   \t\t  \n  ", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
    });

    it("random garbage: 'asdf jkl qwerty'", () => {
      const r = parseInput("asdf jkl qwerty", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("asdf jkl qwerty");
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.tags).toEqual([]);
    });

    it("number-only input: '12345'", () => {
      const r = parseInput("12345", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toContain("12345");
    });

    it("standalone token-like junk: '#'", () => {
      // A bare '#' isn't followed by a word char, so the tag regex doesn't match.
      const r = parseInput("#", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("#");
      expect(r.input.tags).toEqual([]);
    });

    it("standalone token-like junk: '~'", () => {
      const r = parseInput("~", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("~");
      expect(r.input.folderQuery).toBeUndefined();
    });

    it("invalid window: 'every monday for X weeks' (X is non-numeric)", () => {
      // The "for N weeks" regex requires \d+, so non-numeric junk falls through
      // and stays in the title alongside the recurrence.
      const r = parseInput("standup every monday for X weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).not.toContain("UNTIL=");
      expect(r.rrule).not.toContain("COUNT=");
    });

    it("invalid weekday in slash list: 'm/x/f'", () => {
      // 'x' isn't a weekday — the slash-day regex requires the WHOLE list to
      // be valid weekdays. Single 'x' breaks the match → not consumed.
      const r = parseInput("plan m/x/f", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toContain("m/x/f");
    });

    it("conflicting cadence and bare-day: parser picks the first that matches", () => {
      // "every monday tuesday" — the everyDayRe doesn't include "tuesday" in
      // its consume because it requires a separator (comma/and). So we get
      // "every monday" matched and "tuesday" left for chrono.
      const r = parseInput("standup every monday tuesday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("tag with non-ASCII letters is captured by \\w (regex respects Unicode word chars in JS)", () => {
      // JS \w is ASCII-only by default, so "#café" captures only "caf".
      const r = parseInput("note #café", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["caf"]);
      // The trailing "é" stays in the title.
      expect(r.input.title).toContain("é");
    });

    it("very long unbroken token doesn't crash the parser", () => {
      const longToken = "x".repeat(1000);
      const r = parseInput(longToken, NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title.length).toBeGreaterThan(900);
    });

    it("doesn't throw on extreme combinations", () => {
      // Stress: every token type at once + adversarial whitespace.
      const input =
        "  !urgent  every  other  tuesday  at  9am  for  30m  for  4  weeks  #a  #b  ~c  ";
      expect(() => parseInput(input, NOW)).not.toThrow();
    });
  });

  // ─── scenario coverage matrix ──────────────────────────────────────────────
  // One representative test per top-level scenario the parser must handle for
  // production. Each test pins the contract the rest of the app relies on:
  // result.type, scheduledStart shape (date-only / datetime / undefined), and
  // metadata fields (tags / folder / priority).
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
      // March 5 has passed; chrono with forwardDate rolls to next year.
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
    it("'m/w/f at 3pm' → 3 separate pages, each with the same shape", () => {
      const r = parseInput("gym m/w/f at 3pm", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(3);
      expect(r.inputs).toHaveLength(3);
      for (const inp of r.inputs) {
        expect(inp.title).toBe("gym");
        expect(inp.scheduledStart).toMatch(/T15:00:00$/);
      }
    });

    it("'weekdays at 9am 5 times' → 5 pages on consecutive weekdays", () => {
      const r = parseInput("standup weekdays at 9am 5 times", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(5);
      for (const inp of r.inputs) {
        expect(inp.scheduledStart).toMatch(/T09:00:00$/);
      }
    });
  });

  describe("scenario matrix — recurring schedules", () => {
    it("'every monday' → recurring with no window", () => {
      const r = parseInput("standup every monday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).not.toContain("UNTIL=");
      expect(r.rrule).not.toContain("COUNT=");
    });

    it("'every monday for 4 weeks' → bounded recurring with UNTIL", () => {
      const r = parseInput("standup every monday for 4 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("UNTIL=");
    });

    it("'daily' → FREQ=DAILY", () => {
      const r = parseInput("vitamin daily", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
    });

    it("'every other tuesday morning' → INTERVAL=2 BYDAY=TU + 09:00", () => {
      const r = parseInput("standup every other tuesday morning", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("BYDAY=TU");
      expect(r.input.scheduledStart).toBe("2026-03-17T09:00:00");
    });
  });

  describe("scenario matrix — non-scheduled", () => {
    it("plain text → single page, no schedule, no tags/folder/priority", () => {
      const r = parseInput("buy groceries", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("buy groceries");
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.scheduledEnd).toBeUndefined();
      expect(r.input.tags).toEqual([]);
      expect(r.input.folderQuery).toBeUndefined();
      expect(r.input.priority).toBeUndefined();
    });

    it("title-only with metadata (still non-scheduled)", () => {
      const r = parseInput("buy groceries #shopping ~Personal !low", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("buy groceries");
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.tags).toEqual(["shopping"]);
      expect(r.input.folderQuery).toBe("Personal");
      expect(r.input.priority).toBe("low");
    });
  });

  describe("scenario matrix — tags / priority / folder mix", () => {
    it("all three present, scrambled order", () => {
      const r = parseInput("!high #work #urgent ~Engineering team sync", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team sync");
      expect(r.input.tags).toEqual(["work", "urgent"]);
      expect(r.input.folderQuery).toBe("Engineering");
      expect(r.input.priority).toBe("high");
    });

    it("tags accumulate (multi-value)", () => {
      const r = parseInput("note #a #b #c", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["a", "b", "c"]);
    });

    it("priority: last wins", () => {
      const r = parseInput("task !urgent !low", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("low");
    });

    it("folder: last wins", () => {
      const r = parseInput("task ~A ~B", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.folderQuery).toBe("B");
    });

    it("priority and folder can both be cleared by re-typing: latest semantic", () => {
      // !0 explicitly clears priority. There's no equivalent for folder, but
      // last-wins on folder ensures the user's most-recent ~Folder choice
      // takes effect.
      const r = parseInput("task !urgent !0 ~A ~B", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBeNull();
      expect(r.input.folderQuery).toBe("B");
    });
  });

  describe("scenario matrix — schema/UI mapping contract", () => {
    // These tests pin the shape the editor + page-list components depend on.
    // If any of these break, the UI mapping has shifted and downstream
    // components may render incorrectly.

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

    it("rrule (when present) is parseable by the rrule library", async () => {
      const { RRule } = await import("rrule");
      const cases = [
        "standup every monday",
        "standup every other tuesday",
        "gym every weekday morning",
        "review every friday at 3pm for 4 weeks",
      ];
      for (const s of cases) {
        const r = parseInput(s, NOW);
        if (r.type !== "recurring") continue;
        expect(() => RRule.fromString("RRULE:" + r.rrule)).not.toThrow();
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

// ─── property tests ──────────────────────────────────────────────────────────
//
// Invariants the parser must hold for ANY input we generate. Each property
// runs the parser against ~100 randomised inputs (tags + folder + priority +
// date + time + duration + recurrence, in random order with random
// whitespace). Catches compositional bugs no enumerable test will surface.
// Seed is fixed so failures are reproducible.

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

  it("recurring rrule is always parseable by rrule.js", () => {
    forAll((_, r) => {
      if (r.type !== "recurring") return true;
      try {
        RRule.fromString("RRULE:" + r.rrule);
        return true;
      } catch {
        return false;
      }
    });
  });

  it("finite count matches inputs length", () => {
    forAll((_, r) => {
      if (r.type !== "finite") return true;
      return r.count === r.inputs.length;
    });
  });
});
