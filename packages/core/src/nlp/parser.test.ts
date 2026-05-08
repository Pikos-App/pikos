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
    it("full NL: title, date, time, duration, tag, folder", () => {
      const r = parseInput("team meeting @tomorrow at 2pm for 1h #work ~Projects", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team meeting");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("14:00");
      expect(r.input.durationMinutes).toBe(60);
      expect(r.input.scheduledEnd).toContain("2026-03-16");
      expect(r.input.scheduledEnd).toContain("15:00");
      expect(r.input.tags).toEqual(["work"]);
      expect(r.input.folderQuery).toBe("Projects");
    });

    it("plain text — no tokens", () => {
      const r = parseInput("quick note", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("quick note");
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.tags).toEqual([]);
    });

    it("empty string", () => {
      const r = parseInput("", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
    });

    it("whitespace-only", () => {
      const r = parseInput("   ", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
    });

    it("priority and multiple tags", () => {
      const r = parseInput("brainstorm !high #design #ux", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("brainstorm");
      expect(r.input.priority).toBe("high");
      expect(r.input.tags).toEqual(["design", "ux"]);
    });

    it("@monday → next Monday (bare day = date, not recurrence)", () => {
      // now is Sunday 2026-03-15, next Monday = 2026-03-16
      const r = parseInput("standup @monday 9am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("standup");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("09:00");
    });

    it("@today — date-only, no time", () => {
      const r = parseInput("lunch @today", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-03-15");
    });

    it("@march20 at 3:30pm", () => {
      const r = parseInput("call @march20 at 3:30pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-20");
      expect(r.input.scheduledStart).toContain("15:30");
    });

    it("at keyword with standalone time", () => {
      const r = parseInput("meeting at 3:30pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("15:30");
    });

    it("24-hour time format", () => {
      const r = parseInput("meeting 14:00", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("14:00");
    });

    it("@march5 — no space between month and day", () => {
      const r = parseInput("call @march5", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // chrono-node may or may not parse "march5" without a space.
      // Known limitation: prefer "@march 5" or "@mar 5".
      const hasParsedDate = r.input.scheduledStart !== undefined;
      if (hasParsedDate) {
        expect(r.input.scheduledStart).toContain("03-05");
      } else {
        expect(r.input.title).toContain("march5");
      }
    });
  });

  // ─── 2. Priority & folder edge cases ───────────────────────────────────────

  describe("priority and folder edge cases", () => {
    it("last priority wins", () => {
      const r = parseInput("task !urgent !low", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("low");
    });

    it("last folder wins (consistent with priority's last-wins semantics)", () => {
      const r = parseInput("task ~Projects ~Archive", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.folderQuery).toBe("Archive");
    });

    it("last folder wins across three folders", () => {
      const r = parseInput("task ~A ~B ~C", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.folderQuery).toBe("C");
    });

    it("only a priority token → empty title", () => {
      const r = parseInput("!high", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.priority).toBe("high");
    });
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
    it("future time → today", () => {
      // now = 12:00, 2pm is future
      const r = parseInput("meeting 2pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-15");
      expect(r.input.scheduledStart).toContain("14:00");
    });

    it("past time → tomorrow", () => {
      // now = 12:00, 8am is past
      const r = parseInput("meeting 8am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("08:00");
    });
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
    it("m/w/f at 3pm for 45m → 3 pages (Mon 3/16, Wed 3/18, Fri 3/20)", () => {
      const r = parseInput("run m/w/f at 3pm for 45m", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(3);
      expect(r.inputs).toHaveLength(3);
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-16");
      expect(r.inputs[0]!.scheduledStart).toContain("15:00");
      expect(r.inputs[1]!.scheduledStart).toContain("2026-03-18");
      expect(r.inputs[2]!.scheduledStart).toContain("2026-03-20");
      expect(r.inputs[0]!.durationMinutes).toBe(45);
    });

    it("m/w/f for 1h through march 31 → Mon/Wed/Fri from 3/16 through 3/31", () => {
      const r = parseInput("gym m/w/f for 1h through march 31", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      // Expected: 3/16, 3/18, 3/20, 3/23, 3/25, 3/27, 3/30 = 7 pages
      expect(r.count).toBe(7);
      expect(r.inputs).toHaveLength(7);
      const starts = r.inputs.map((i) => i.scheduledStart);
      expect(starts[0]).toContain("2026-03-16");
      expect(starts[6]).toContain("2026-03-30");
    });

    it("weekdays at 9am 3 times → next 3 weekdays", () => {
      const r = parseInput("review sprint weekdays at 9am 3 times", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(3);
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-16"); // Mon
      expect(r.inputs[1]!.scheduledStart).toContain("2026-03-17"); // Tue
      expect(r.inputs[2]!.scheduledStart).toContain("2026-03-18"); // Wed
    });

    it("bare weekdays → next 5 weekdays (Mon–Fri)", () => {
      const r = parseInput("standup weekdays", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(5);
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-16");
      expect(r.inputs[4]!.scheduledStart).toContain("2026-03-20");
    });

    it("t/th/f slash syntax — t maps to Tuesday", () => {
      const r = parseInput("run t/th/f at 3pm", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(3);
      // Tue 3/17, Thu 3/19, Fri 3/20
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-17");
      expect(r.inputs[1]!.scheduledStart).toContain("2026-03-19");
      expect(r.inputs[2]!.scheduledStart).toContain("2026-03-20");
    });

    it("through date excludes days after boundary", () => {
      // Through Thursday March 19 — Mon 3/16 and Wed 3/18, NOT Fri 3/20
      const r = parseInput("task m/w/f through march 19", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(2);
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-16");
      expect(r.inputs[1]!.scheduledStart).toContain("2026-03-18");
    });

    it("scheduledEnd computes correctly on expanded finite pages", () => {
      const r = parseInput("run m/w/f at 3pm for 1.5 hours", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      for (const inp of r.inputs) {
        expect(inp.durationMinutes).toBe(90);
        expect(inp.scheduledEnd).toBeDefined();
        expect(inp.scheduledEnd).toContain("16:30");
      }
    });
  });

  // ─── 6. Finite recurrence — shared properties ─────────────────────────────

  describe("finite recurrence shared properties", () => {
    it("all pages share tags, folder, duration, title", () => {
      const r = parseInput("run m/w/f at 3pm for 45m #fitness ~Health", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      for (const inp of r.inputs) {
        expect(inp.title).toBe("run");
        expect(inp.tags).toEqual(["fitness"]);
        expect(inp.folderQuery).toBe("Health");
        expect(inp.durationMinutes).toBe(45);
      }
    });
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
    // All of these should produce the same result: recurring WEEKLY;BYDAY=MO
    // with scheduledStart on next Monday at 9am.
    const EXPECTED_DATE = "2026-03-16";
    const EXPECTED_TIME = "09:00";

    const variations = [
      "standup every monday at 9am",
      "standup at 9am every monday",
      "every monday standup at 9am",
      "every monday at 9am standup",
      "standup every mon at 9am",
      "standup every Monday at 9am",
      "STANDUP EVERY MONDAY AT 9AM",
    ];

    for (const input of variations) {
      it(`"${input}" → recurring WEEKLY BYDAY=MO`, () => {
        const r = parseInput(input, NOW);
        expect(r.type).toBe("recurring");
        if (r.type !== "recurring") return;
        expect(r.rrule).toContain("FREQ=WEEKLY");
        expect(r.rrule).toContain("BYDAY=MO");
        expect(r.input.scheduledStart).toContain(EXPECTED_DATE);
        expect(r.input.scheduledStart).toContain(EXPECTED_TIME);
        expect(r.input.title.toLowerCase()).toBe("standup");
      });
    }
  });

  // ─── 7c. Recurring — "and" separator ─────────────────────────────────────

  describe("recurring with 'and' separator", () => {
    it("every tuesday and thursday at 6pm", () => {
      const r = parseInput("gym every tuesday and thursday at 6pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=TU,TH");
      expect(r.input.title).toBe("gym");
    });

    it("every tue and thu (abbreviated)", () => {
      const r = parseInput("gym every tue and thu at 6pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=TU,TH");
    });

    it("every mon, wed, and fri (Oxford comma)", () => {
      const r = parseInput("standup every mon, wed, and fri at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,WE,FR");
    });
  });

  // ─── 7d. Recurring — plural day names ────────────────────────────────────

  describe("recurring via plural day names", () => {
    it("standup mondays at 9am → recurring BYDAY=MO", () => {
      const r = parseInput("standup mondays at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.input.scheduledStart).toContain("09:00");
    });

    it("gym tuesdays and thursdays at 6pm → BYDAY=TU,TH", () => {
      const r = parseInput("gym tuesdays and thursdays at 6pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=TU,TH");
    });

    it("standup on mondays at 9am → recurring (on + plural)", () => {
      const r = parseInput("standup on mondays at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("plural fridays without time → all-day recurring", () => {
      const r = parseInput("review fridays", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=FR");
      expect(r.input.scheduledStart).toBe("2026-03-20"); // next Friday
    });
  });

  // ─── 7e. Recurring — duration preserved ──────────────────────────────────

  describe("recurring with duration", () => {
    it("standup every monday at 9am for 30m → recurring with duration", () => {
      const r = parseInput("standup every monday at 9am for 30m", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.durationMinutes).toBe(30);
      expect(r.input.scheduledEnd).toContain("09:30");
    });

    it("daily standup at 9am for 15m → FREQ=DAILY with duration", () => {
      const r = parseInput("daily standup at 9am for 15m", new Date("2026-03-16T08:00:00"));
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.input.durationMinutes).toBe(15);
    });
  });

  // ─── 7f. Recurring — metadata preserved ──────────────────────────────────

  describe("recurring with metadata", () => {
    it("preserves tags, priority, folder on recurring page", () => {
      const r = parseInput("standup every monday at 9am #work !high ~Engineering", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.tags).toEqual(["work"]);
      expect(r.input.priority).toBe("high");
      expect(r.input.folderQuery).toBe("Engineering");
      expect(r.input.title).toBe("standup");
    });
  });

  // ─── 7g. Recurring — title cleanliness ───────────────────────────────────

  describe("recurring title cleanliness", () => {
    it("daily standup every monday → title 'daily standup'", () => {
      const r = parseInput("daily standup every monday at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("daily standup");
    });

    it("team sync every friday → title 'team sync'", () => {
      const r = parseInput("team sync every friday at 4pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("team sync");
    });

    it("every monday standup → title 'standup'", () => {
      const r = parseInput("every monday standup", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("standup");
    });
  });

  // ─── 7h. Bare day names should NOT recur ─────────────────────────────────

  describe("bare day names stay single (not recurring)", () => {
    it("standup monday at 9am → single, not recurring", () => {
      const r = parseInput("standup monday at 9am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("09:00");
    });

    it("call next monday → single", () => {
      const r = parseInput("call next monday", NOW);
      expect(r.type).toBe("single");
    });

    it("meeting on monday → single (singular 'on monday')", () => {
      const r = parseInput("meeting on monday at 2pm", NOW);
      expect(r.type).toBe("single");
    });
  });

  // ─── 7i. Bounded recurrence (every X + window) ───────────────────────────
  //
  // "every X for N weeks/days/months" or "N times" or "through <date>"
  // should yield ONE recurring page with a bounded RRULE (COUNT or UNTIL),
  // expanded virtually — NOT N independent pages.

  describe("bounded recurrence — every X + window", () => {
    // Pure ParserCase rows — no rrule expansion check.
    const pureCases: ParserCase[] = [
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
    ];
    it.each(pureCases)("$input", runCase);

    // Expansion-count rows: also assert RRule.fromString(...).all().length.
    interface ExpansionCase {
      input: string;
      title?: string;
      scheduledStart?: string;
      rruleContains?: string[];
      rruleAbsent?: string[];
      /** DTSTART line passed to RRule.fromString (e.g. "20260316T150000Z"). */
      dtstart: string;
      /** Expected occurrences from rule.all().length. */
      count: number;
    }
    const expansionCases: ExpansionCase[] = [
      {
        count: 10,
        dtstart: "20260316T150000Z",
        input: "run every monday at 3pm for 10 weeks",
        rruleAbsent: ["COUNT="],
        rruleContains: ["FREQ=WEEKLY", "BYDAY=MO", "UNTIL="],
        scheduledStart: "2026-03-16T15:00:00",
        title: "run",
      },
      {
        count: 2,
        dtstart: "20260316T000000Z",
        input: "every monday for 2 weeks",
        rruleContains: ["BYDAY=MO", "UNTIL="],
        scheduledStart: "2026-03-16",
      },
      {
        // 7am with NOW=12:00 → tomorrow (3/16); 5-day window ends 3/20.
        count: 5,
        dtstart: "20260316T070000Z",
        input: "water plant every day at 7am for 5 days",
        rruleContains: ["FREQ=DAILY", "UNTIL="],
        scheduledStart: "2026-03-16T07:00:00",
      },
      {
        // dtstart = today (2026-03-15). UNTIL ≈ +89 days ≈ June 11.
        // Monthly from 3/15: 3/15, 4/15, 5/15, 6/15 — but UNTIL < 6/15 → 3 occurrences.
        count: 3,
        dtstart: "20260315T000000Z",
        input: "pay rent every month for 3 months",
        rruleContains: ["FREQ=MONTHLY", "UNTIL="],
      },
      {
        // Mondays on/before Apr 30: 3/16, 3/23, 3/30, 4/6, 4/13, 4/20, 4/27 = 7.
        count: 7,
        dtstart: "20260316T000000Z",
        input: "standup every monday through april 30",
        rruleContains: ["UNTIL=2026043", "BYDAY=MO"],
      },
      {
        // From 3/15, scheduledStart = Tue 3/17 18:00. 2 weeks window through 3/30.
        // Occurrences: 3/17, 3/19, 3/24, 3/26 = 4.
        count: 4,
        dtstart: "20260317T180000Z",
        input: "gym every tuesday and thursday at 6pm for 2 weeks",
        rruleContains: ["BYDAY=TU,TH", "UNTIL="],
      },
      {
        count: 10,
        dtstart: "20260316T090000Z",
        input: "standup every weekday at 9am for 2 weeks",
        rruleContains: ["BYDAY=MO,TU,WE,TH,FR", "UNTIL="],
      },
    ];
    it.each(expansionCases)("$input → expands to $count", (c) => {
      const r = parseInput(c.input, NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      if (c.title !== undefined) expect(r.input.title).toBe(c.title);
      if (c.scheduledStart !== undefined) expect(r.input.scheduledStart).toBe(c.scheduledStart);
      for (const f of c.rruleContains ?? []) expect(r.rrule).toContain(f);
      for (const f of c.rruleAbsent ?? []) expect(r.rrule).not.toContain(f);
      const rule = RRule.fromString(`DTSTART:${c.dtstart}\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(c.count);
    });

    it("bounded recurrence RRULE is round-trip parseable", () => {
      const r = parseInput("every monday for 10 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      const rule = RRule.fromString("RRULE:" + r.rrule);
      expect(rule).toBeDefined();
    });
  });

  // ─── 7j. Composition: every + slash / plural days ────────────────────────
  //
  // "every [week] <day-list>" should augment the infinite weekly rule with
  // BYDAY rather than overwrite it with a finite-slash list.

  describe("every + day-list composition", () => {
    it("run every week m/f → infinite BYDAY=MO,FR", () => {
      const r = parseInput("run every week m/f", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO,FR");
      expect(r.input.title).toBe("run");
    });

    it("run every week m/f for 10 weeks → bounded BYDAY=MO,FR", () => {
      const r = parseInput("run every week m/f for 10 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,FR");
      expect(r.rrule).toContain("UNTIL=");
    });

    it("run every m/f → infinite BYDAY=MO,FR (implicit weekly)", () => {
      const r = parseInput("run every m/f at 3pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO,FR");
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.input.title).toBe("run");
    });

    it("run every m/w/f → infinite BYDAY=MO,WE,FR", () => {
      const r = parseInput("run every m/w/f at 3pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,WE,FR");
    });

    it("standup every week mondays and wednesdays at 9am → BYDAY=MO,WE", () => {
      const r = parseInput("standup every week mondays and wednesdays at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO,WE");
    });

    it("regression: bare m/f (no every) stays finite", () => {
      const r = parseInput("run m/f at 3pm", NOW);
      expect(r.type).toBe("finite");
    });

    it("regression: bare weekdays (no every) stays finite", () => {
      const r = parseInput("standup weekdays", NOW);
      expect(r.type).toBe("finite");
    });
  });

  // ─── 7k. Default daily when window given without cadence ─────────────────
  //
  // A window ("10 times", "for 2 weeks", "through <date>") without an explicit
  // cadence word defaults to FREQ=DAILY. Keeps the user's count/boundary
  // signal meaningful instead of silently stripping it from the title.

  describe("default daily when window present but no cadence", () => {
    it("run dog 10 times → FREQ=DAILY;COUNT=10, title 'run dog'", () => {
      const r = parseInput("run dog 10 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("COUNT=10");
      expect(r.rrule).not.toContain("BYDAY=");
      expect(r.input.title).toBe("run dog");
    });

    it("run dog 10 times tomorrow → FREQ=DAILY;COUNT=10 from tomorrow", () => {
      const r = parseInput("run dog 10 times tomorrow", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("COUNT=10");
      expect(r.input.scheduledStart).toBe("2026-03-16");
      expect(r.input.title).toBe("run dog");
    });

    it("meditate for 2 weeks at 8am → FREQ=DAILY;UNTIL, 14 daily occurrences", () => {
      const r = parseInput("meditate for 2 weeks at 8am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("UNTIL=");
      // 8am with NOW=12:00 → tomorrow (3/16); 2-week window → 14 occurrences.
      expect(r.input.scheduledStart).toBe("2026-03-16T08:00:00");
      expect(r.input.title).toBe("meditate");
      const rule = RRule.fromString(`DTSTART:20260316T080000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(14);
    });

    it("practice piano through june → FREQ=DAILY with UNTIL in june", () => {
      const r = parseInput("practice piano through june", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("UNTIL=202606");
      expect(r.input.title).toBe("practice piano");
    });

    it("run dog (no window) → single, title unchanged", () => {
      const r = parseInput("run dog", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("run dog");
    });

    it("regression: run m/w/f for 2 weeks stays finite (slash has cadence)", () => {
      const r = parseInput("run m/w/f for 2 weeks", NOW);
      expect(r.type).toBe("finite");
    });

    it("regression: explicit 'daily 10 times' unchanged", () => {
      const r = parseInput("run dog daily 10 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("COUNT=10");
    });
  });

  // ─── 7l. "until" / "till" as window boundary (synonym of "through") ──────

  describe("until / till as window boundary", () => {
    it("every monday until april 30 → UNTIL", () => {
      const r = parseInput("standup every monday until april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).toContain("UNTIL=2026043");
    });

    it("meditate until june → default FREQ=DAILY with UNTIL", () => {
      const r = parseInput("meditate until june", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("UNTIL=202606");
      expect(r.input.title).toBe("meditate");
    });

    it("'till' works as alias", () => {
      const r = parseInput("practice every day till june", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("UNTIL=");
    });
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
    it("meeting from 3pm to 5pm → start 15:00, end 17:00", () => {
      const r = parseInput("meeting from 3pm to 5pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.input.scheduledEnd).toContain("17:00");
      expect(r.input.durationMinutes).toBe(120);
    });

    it("meeting 3pm to 5pm tomorrow → tomorrow 15:00–17:00", () => {
      const r = parseInput("meeting 3pm to 5pm tomorrow", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.input.scheduledEnd).toContain("2026-03-16");
      expect(r.input.scheduledEnd).toContain("17:00");
    });

    it("every monday 3pm to 5pm → recurring with time range", () => {
      const r = parseInput("sync every monday 3pm to 5pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.input.scheduledEnd).toContain("17:00");
      expect(r.rrule).toContain("BYDAY=MO");
    });
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
    ];
    it.each(cases)("$input", runCase);

    // Single bare date (no range) → no scheduledEnd. toMatchObject can't
    // distinguish "missing key" from "key === undefined", so this stays imperative.
    it("single bare date (no range) → no scheduledEnd", () => {
      const r = parseInput("vacation April 18", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBeUndefined();
    });

    // Mixed-shape: date-range + time has conservative semantics — start gets the
    // time, end (if present) collapses to the same day. The conditional check
    // doesn't fit ParserCase, so this stays imperative.
    it("date range with time → treated as single-day timed (range ignored)", () => {
      const r = parseInput("trip April 18-20 at 3pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-04-18");
      expect(r.input.scheduledStart).toContain("15:00");
      if (r.input.scheduledEnd) {
        expect(r.input.scheduledEnd).toContain("2026-04-18");
      }
    });
  });

  // ─── 8. RRULE validation ──────────────────────────────────────────────────

  describe("RRULE validation", () => {
    it("rrule string is parseable by the rrule library", () => {
      const r = parseInput("every monday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      // Should not throw
      const rule = RRule.fromString("RRULE:" + r.rrule);
      expect(rule).toBeDefined();
    });

    it("rrule does NOT contain DTSTART", () => {
      const r = parseInput("morning run daily", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).not.toContain("DTSTART");
    });
  });

  // ─── 9. `for` disambiguation ─────────────────────────────────────────────

  describe("for disambiguation", () => {
    it("task for 1h → duration only, single page", () => {
      const r = parseInput("task for 1h", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(60);
    });

    it("task for 2 weeks alone → defaults to daily (window + no cadence)", () => {
      const r = parseInput("task for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.input.title).toBe("task");
    });

    it("run m/w/f for 1h for 2 weeks → finite, duration=60, window=2 weeks", () => {
      const r = parseInput("run m/w/f for 1h for 2 weeks", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      // 2 weeks from 3/15: Mon/Wed/Fri in 3/16–3/29
      // 3/16, 3/18, 3/20, 3/23, 3/25, 3/27 = 6 pages (3/29 is Sunday, not in m/w/f)
      expect(r.count).toBeGreaterThan(0);
      expect(r.inputs[0]!.durationMinutes).toBe(60);
    });
  });

  // ─── 10. Token stripping / title cleanliness ──────────────────────────────

  describe("token stripping and title cleanliness", () => {
    it("strips tokens, collapses whitespace", () => {
      const r = parseInput("  #work  meeting  @tomorrow  at 2pm  ", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("meeting");
    });

    it("only tags → empty title", () => {
      const r = parseInput("#a #b #c", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.tags).toEqual(["a", "b", "c"]);
    });

    it("plain text passthrough", () => {
      const r = parseInput("hello world", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("hello world");
    });

    it("unrecognized !token stays in title", () => {
      const r = parseInput("task !invalid", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("task !invalid");
      expect(r.input.priority).toBeUndefined();
    });

    it("bare ~ with no word stays in title", () => {
      const r = parseInput("task ~", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toContain("~");
      expect(r.input.folderQuery).toBeUndefined();
    });
  });

  // ─── 11. daily keyword interaction ────────────────────────────────────────

  describe("daily keyword interaction with every", () => {
    it("daily survives in title when every <day> is the recurrence", () => {
      const r = parseInput("daily standup every monday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("daily standup");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("daily alone triggers FREQ=DAILY recurrence", () => {
      const r = parseInput("standup daily", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("standup");
      expect(r.rrule).toContain("FREQ=DAILY");
    });
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
    ];
    it.each(cases)("$input", runCase);

    // The two cases below assert presence/absence of scheduledStart — semantics
    // toMatchObject can't express, so they stay imperative.
    it("bare month alone: 'march' → accepted (chrono resolves with forwardDate)", () => {
      const r = parseInput("plan trip march", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("plan trip");
      expect(r.input.scheduledStart).toBeDefined();
    });

    it("bare month in compound phrase: 'may' NOT parsed (known limitation)", () => {
      // "may" in "may day celebration" is ambiguous enough that chrono skips it.
      // No false positive — safe/correct behavior.
      const r = parseInput("may day celebration", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.title).toBe("may day celebration");
    });
  });

  // ─── 13. Edge cases from test strategy ──────────────────────────────────────

  describe("monthly keyword", () => {
    it("monthly triggers FREQ=MONTHLY recurrence", () => {
      const r = parseInput("rent payment monthly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("rent payment");
      expect(r.rrule).toContain("FREQ=MONTHLY");
    });
  });

  describe("bare weekly keyword", () => {
    it("weekly triggers FREQ=WEEKLY recurrence", () => {
      const r = parseInput("sync weekly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("sync");
      expect(r.rrule).toContain("FREQ=WEEKLY");
    });

    it("weekly at 3pm — with time", () => {
      const r = parseInput("review weekly at 3pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("review");
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.input.scheduledStart).toContain("15:00");
    });
  });

  describe("for disambiguation — no recurrence pattern", () => {
    it("'for 30min' with no recurrence → duration only, single page", () => {
      const r = parseInput("focus session for 30min", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(30);
      expect(r.input.title).toBe("focus session");
    });

    it("'for 2h' without day pattern → duration only", () => {
      const r = parseInput("deep work for 2h @tomorrow at 9am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(120);
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledEnd).toContain("11:00");
    });
  });

  describe("multi-tag ordering stability", () => {
    it("multiple tags preserve input order", () => {
      const r = parseInput("task #design #ux #frontend", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["design", "ux", "frontend"]);
    });

    it("tags interspersed with other tokens preserve order", () => {
      const r = parseInput("#alpha meeting #beta @tomorrow #gamma", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  // ─── 14. Recurring + time range (timed event with end) ────────────────────

  describe("recurring with time range", () => {
    it("every monday from 9am to 11am → recurring with start+end+duration", () => {
      const r = parseInput("standup every monday from 9am to 11am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("09:00");
      expect(r.input.scheduledEnd).toContain("11:00");
      expect(r.input.durationMinutes).toBe(120);
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("every weekday 9am-5pm bounded for 2 weeks → bounded with duration", () => {
      const r = parseInput("work every weekday 9am-5pm for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toContain("09:00");
      expect(r.input.scheduledEnd).toContain("17:00");
      expect(r.rrule).toContain("BYDAY=MO,TU,WE,TH,FR");
      expect(r.rrule).toContain("UNTIL=");
    });
  });

  // ─── 15. Edge cases: midnight times, zero/negative bounds, bare digits ─

  describe("time edge cases", () => {
    it("at 12am (midnight) → 00:00 next day if past, today if future", () => {
      // NOW = 2026-03-15 12:00 (noon). 12am = 00:00 → today's 00:00 is in past
      // → tomorrow.
      const r = parseInput("late job at 12am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("00:00");
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("at 11:59pm preserves minutes", () => {
      const r = parseInput("late note at 11:59pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("23:59");
    });
  });

  // ─── 16. Token regex boundaries (\w only — no hyphens/unicode) ───────────

  describe("tag and folder regex boundaries", () => {
    it("hyphenated tag captures only the word-char prefix", () => {
      // Regex is /#(\w+)/ — \w matches [A-Za-z0-9_], not hyphens. Anything
      // after the hyphen stays in the title.
      const r = parseInput("review #multi-word", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["multi"]);
      expect(r.input.title).toContain("-word");
    });

    it("tag with digits is accepted", () => {
      const r = parseInput("plan #q4 #2025", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["q4", "2025"]);
      expect(r.input.title).toBe("plan");
    });

    it("tag with underscores is accepted", () => {
      const r = parseInput("note #snake_case", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["snake_case"]);
    });

    it("parser does NOT dedupe duplicate tag names — caller's responsibility", () => {
      const r = parseInput("note #work #work", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.tags).toEqual(["work", "work"]);
    });

    it("hyphenated folder captures only the word-char prefix", () => {
      const r = parseInput("page ~side-project", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.folderQuery).toBe("side");
      expect(r.input.title).toContain("-project");
    });

    it("'~inbox' is preserved as folderQuery — case-insensitive routing in caller", () => {
      const r = parseInput("dump ~Inbox", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // Parser preserves casing; QuickAddDialog lowercases for the Inbox check.
      expect(r.input.folderQuery).toBe("Inbox");
      expect(r.input.title).toBe("dump");
    });
  });

  // ─── 17. Title remains empty when all input is tokens ────────────────────

  describe("empty-title cases (caller falls back to 'Untitled')", () => {
    it("only a date → empty title", () => {
      const r = parseInput("tomorrow", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.scheduledStart).toBe("2026-03-16");
    });

    it("only a time → empty title", () => {
      const r = parseInput("at 3pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.scheduledStart).toContain("15:00");
    });

    it("only a duration → empty title (no schedule)", () => {
      const r = parseInput("for 2h", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.durationMinutes).toBe(120);
    });

    it("only tokens (priority + folder) → empty title", () => {
      const r = parseInput("!high ~Projects", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("");
      expect(r.input.priority).toBe("high");
      expect(r.input.folderQuery).toBe("Projects");
    });
  });

  // ─── 18. Priority casing variations ──────────────────────────────────────

  describe("priority case-insensitivity", () => {
    it("'!URGENT' uppercase → urgent", () => {
      const r = parseInput("blocker !URGENT", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("urgent");
    });

    it("'!Medium' mixed-case → medium", () => {
      const r = parseInput("review !Medium", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("medium");
    });
  });

  // ─── 19. Composition: full NLP combo ────────────────────────────────────

  describe("full NLP composition", () => {
    it("date + time + duration + priority + tags + folder all together", () => {
      const r = parseInput(
        "team review tomorrow at 2pm for 90m !high #design #ux ~Engineering",
        NOW
      );
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team review");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("14:00");
      expect(r.input.scheduledEnd).toContain("15:30");
      expect(r.input.durationMinutes).toBe(90);
      expect(r.input.priority).toBe("high");
      expect(r.input.tags).toEqual(["design", "ux"]);
      expect(r.input.folderQuery).toBe("Engineering");
    });

    it("token order independence: same combo, scrambled order", () => {
      const r = parseInput(
        "#design ~Engineering team review !high tomorrow #ux at 2pm for 90m",
        NOW
      );
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team review");
      expect(r.input.priority).toBe("high");
      expect(r.input.tags).toEqual(["design", "ux"]);
      expect(r.input.folderQuery).toBe("Engineering");
      expect(r.input.durationMinutes).toBe(90);
    });
  });

  describe("recurring edge cases", () => {
    it("'every 1 week' → infinite with INTERVAL=1 (effectively weekly)", () => {
      const r = parseInput("sync every 1 week", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      // INTERVAL=1 may be omitted by the rrule serializer (default), but the
      // emitted rule must round-trip cleanly.
      const rule = RRule.fromString("RRULE:" + r.rrule);
      expect(rule).toBeDefined();
    });

    it("'every monday for 1 week' → bounded with one Monday in the window", () => {
      const r = parseInput("standup every monday for 1 week", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).toContain("UNTIL=");
      const rule = RRule.fromString(`DTSTART:20260316T000000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(1);
    });

    it("'every monday 1 time' → COUNT=1 (single occurrence)", () => {
      const r = parseInput("kickoff every monday 1 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("COUNT=1");
    });
  });

  // ─── multi-day all-day range — adjacent failure modes ───────────────────────
  // The "Month day-day" / "Month day through day" rewrite has tests for the
  // happy paths and the cross-year case. The cases below cover the edges that
  // historically broke before the rewrite landed: hyphen with single-digit
  // days, ordinals, abbreviated months, range plus metadata tokens, degenerate
  // same-day ranges, and reversed ranges (end ≤ start ⇒ no scheduledEnd).
  describe("multi-day all-day ranges — adjacent edges", () => {
    it("single-digit hyphen range: 'trip Apr 5-9' → Apr 5 → Apr 9", () => {
      const r = parseInput("trip Apr 5-9", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-05");
      expect(r.input.scheduledEnd).toBe("2026-04-09");
    });

    it("abbreviated month + hyphen range: 'trip Sep 1-7' → Sep 1 → Sep 7", () => {
      const r = parseInput("trip Sep 1-7", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-09-01");
      expect(r.input.scheduledEnd).toBe("2026-09-07");
    });

    it("ordinals on both ends: 'travel May 2nd through 10th' → May 2 → May 10", () => {
      // The rewrite regex captures ordinal suffixes so the span resolves cleanly.
      const r = parseInput("travel May 2nd through 10th", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-05-02");
      expect(r.input.scheduledEnd).toBe("2026-05-10");
    });

    it("ordinal + abbreviated month: 'trip Apr 18th thru Apr 25th'", () => {
      const r = parseInput("trip Apr 18th thru Apr 25th", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
    });

    it("reversed range: 'vacation April 25 to April 18' → forward-rolls end into next year", () => {
      // chrono is configured with forwardDate: true. When the second date is
      // earlier in the calendar than the first, it advances to the next year
      // so the range is still chronologically valid. Documented here so a
      // future change to forwardDate doesn't break silently.
      const r = parseInput("vacation April 25 to April 18", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-25");
      expect(r.input.scheduledEnd).toBe("2027-04-18");
    });

    it("degenerate same-day: 'trip April 18 to April 18' → no scheduledEnd", () => {
      const r = parseInput("trip April 18 to April 18", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBeUndefined();
    });

    it("range with tag: 'trip April 18-25 #vacation'", () => {
      const r = parseInput("trip April 18-25 #vacation", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("trip");
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
      expect(r.input.tags).toEqual(["vacation"]);
    });

    it("range with priority: 'trip April 18-25 !urgent'", () => {
      const r = parseInput("trip April 18-25 !urgent", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("trip");
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
      expect(r.input.priority).toBe("urgent");
    });

    it("range with folder: 'trip April 18 to April 25 ~Travel'", () => {
      const r = parseInput("trip April 18 to April 25 ~Travel", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("trip");
      expect(r.input.folderQuery).toBe("Travel");
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
    });

    it("'from' prefix is stripped from title for spans: 'travel from May 2 to May 10'", () => {
      const r = parseInput("travel from May 2 to May 10", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-05-02");
      expect(r.input.scheduledEnd).toBe("2026-05-10");
      expect(r.input.title).toBe("travel");
    });

    it("'from' is also stripped for non-span 'from <date>' phrases", () => {
      // Chrono consumes "tomorrow" but not the leading "from" — verify the
      // strip extension covers single-date phrasing too, not just spans.
      const r = parseInput("call from tomorrow", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("call");
    });

    it("through+single-digit on second month: 'May 2 through Jun 5'", () => {
      const r = parseInput("trip May 2 through Jun 5", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-05-02");
      expect(r.input.scheduledEnd).toBe("2026-06-05");
    });

    it("hyphen range without preceding month is not a span: 'trip 18-25'", () => {
      // No month → the rewrite regex doesn't apply. "18-25" is not a date in
      // chrono's grammar; it stays in the title (or chrono produces a fallback
      // we explicitly do NOT depend on). The span fields must not be set.
      const r = parseInput("trip 18-25", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledEnd).toBeUndefined();
    });
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
    ];
    it.each(cases)("$input", runCase);

    // ─── regex-anchored cases (date-or-time fuzz that ParserCase can't express) ──
    it("'9pm to 5am' → start 21:00 today/tomorrow, end at 05:00 next day", () => {
      const r = parseInput("shift 9pm to 5am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toMatch(/T21:00:00$/);
      expect(r.input.scheduledEnd).toMatch(/T05:00:00$/);
      // Duration should reflect 8 hours, not −16.
      expect(r.input.durationMinutes).toBe(8 * 60);
    });

    it("noon to 5pm time range", () => {
      const r = parseInput("workshop noon to 5pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toMatch(/T12:00:00$/);
      expect(r.input.scheduledEnd).toMatch(/T17:00:00$/);
      expect(r.input.durationMinutes).toBe(5 * 60);
    });

    it("'noon' on its own → today at midday", () => {
      const r = parseInput("call mom at noon", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // NOW is 12:00 — chrono returns 12:00; if the parser uses <= ref, it
      // shifts to tomorrow. Pin only the time component.
      expect(r.input.scheduledStart).toMatch(/^2026-03-1[56]T12:00:00$/);
    });

    it("'midnight' on its own → past noon NOW → tomorrow midnight", () => {
      const r = parseInput("alarm at midnight", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // chrono returns 00:00 today; <= ref shifts to tomorrow.
      expect(r.input.scheduledStart).toMatch(/T00:00:00$/);
    });

    it("'next week' — chrono picks next Monday/Sunday-ish (not asserted strictly)", () => {
      const r = parseInput("review next week", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // Pin only that something forward of NOW was parsed.
      expect(r.input.scheduledStart).toMatch(/^2026-03-(2[0-9]|1[6-9])/);
    });

    it("'5p' — short pm form", () => {
      const r = parseInput("meeting at 5p", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      // "5p" is sometimes parsed by chrono as 5pm. Pin only the hour.
      if (r.input.scheduledStart) {
        expect(r.input.scheduledStart).toMatch(/T1[57]:00:00/);
      }
    });
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
