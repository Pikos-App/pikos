import { RRule } from "rrule";
import { describe, expect, it } from "vitest";

import { parseInput } from "./parser";

const NOW = new Date("2026-03-15T12:00:00");

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

    it("first folder wins", () => {
      const r = parseInput("task ~Projects ~Archive", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.folderQuery).toBe("Projects");
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
    it("!1 → urgent", () => {
      const r = parseInput("task !1", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("urgent");
      expect(r.input.title).toBe("task");
    });

    it("!2 → high", () => {
      const r = parseInput("task !2", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("high");
    });

    it("!3 → medium", () => {
      const r = parseInput("task !3", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("medium");
    });

    it("!4 → low", () => {
      const r = parseInput("task !4", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("low");
    });

    it("!0 → null (explicitly cleared)", () => {
      const r = parseInput("task !0", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBeNull();
    });

    it("!1 !3 → medium (last wins)", () => {
      const r = parseInput("task !1 !3", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("medium");
    });

    it("!5 → not matched, stays in title", () => {
      const r = parseInput("task !5", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("task !5");
      expect(r.input.priority).toBeUndefined();
    });

    it("!urgent still works unchanged", () => {
      const r = parseInput("task !urgent", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.priority).toBe("urgent");
    });
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
    it("for 2h → 120 minutes", () => {
      const r = parseInput("focus for 2h", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(120);
    });

    it("for 15min → 15 minutes", () => {
      const r = parseInput("break for 15min", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(15);
    });

    it("for 1.5 hours → 90 minutes", () => {
      const r = parseInput("deep work for 1.5 hours", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(90);
    });

    it("for 30m → 30 minutes", () => {
      const r = parseInput("task for 30m", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.durationMinutes).toBe(30);
    });
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
    it("every monday → recurring FREQ=WEEKLY BYDAY=MO", () => {
      const r = parseInput("daily standup every monday 1pm for 15m", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("daily standup");
      expect(r.input.scheduledStart).toContain("13:00");
      expect(r.input.durationMinutes).toBe(15);
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("morning run daily → recurring FREQ=DAILY", () => {
      const r = parseInput("morning run daily at 7am for 30m", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
    });

    it("every weekday → BYDAY=MO,TU,WE,TH,FR", () => {
      const r = parseInput("every weekday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,TU,WE,TH,FR");
    });

    it("sync every friday at 4pm", () => {
      const r = parseInput("sync every friday at 4pm", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=FR");
    });

    it("every monday at 9am → date anchors to next Monday, not tomorrow", () => {
      // NOW = Sunday 2026-03-15 12:00. Next Monday = 2026-03-16.
      const r = parseInput("standup every monday at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("09:00");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("every monday at 9am from a Wednesday → anchors to next Monday", () => {
      // Wed 2026-03-18 12:00 → next Monday = 2026-03-23
      const wed = new Date("2026-03-18T12:00:00");
      const r = parseInput("standup every monday at 9am", wed);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toContain("2026-03-23");
      expect(r.input.scheduledStart).toContain("09:00");
    });

    it("every day → recurring FREQ=DAILY", () => {
      const r = parseInput("standup every day at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
    });

    it("every weekend → BYDAY=SA,SU", () => {
      const r = parseInput("relax every weekend", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=SA,SU");
    });

    it("every monday, wednesday, friday → BYDAY=MO,WE,FR", () => {
      const r = parseInput("standup every monday, wednesday, friday at 9am", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,WE,FR");
    });

    it("every week + weekday in text → FREQ=WEEKLY;BYDAY inferred from chrono", () => {
      const r = parseInput("standup monday 9am every week", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.input.scheduledStart).toContain("2026-03-16"); // next Monday
      expect(r.input.scheduledStart).toContain("09:00");
    });

    it("every monday (no time) → scheduledStart anchors to next Monday", () => {
      // NOW = Sunday 2026-03-15. Next Monday = 2026-03-16.
      const r = parseInput("run every monday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.scheduledStart).toBe("2026-03-16");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("every month → recurring FREQ=MONTHLY", () => {
      const r = parseInput("report every month", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=MONTHLY");
    });
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
    it("run every monday at 3pm for 10 weeks → recurring with UNTIL, 10 Mondays", () => {
      const r = parseInput("run every monday at 3pm for 10 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.title).toBe("run");
      expect(r.input.scheduledStart).toContain("2026-03-16"); // next Monday
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).toContain("UNTIL=");
      expect(r.rrule).not.toContain("COUNT=");
      // Expansion yields exactly 10 Mondays.
      const rule = RRule.fromString(`DTSTART:20260316T150000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(10);
    });

    it("reproduces user bug: run ~dog every monday at 3pm for 10 weeks → 1 page, not 10", () => {
      const r = parseInput("run ~dog every monday at 3pm for 10 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.folderQuery).toBe("dog");
      expect(r.input.title).toBe("run");
    });

    it("every monday 10 times → recurring with COUNT=10", () => {
      const r = parseInput("standup every monday at 9am 10 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("COUNT=10");
      expect(r.rrule).not.toContain("UNTIL=");
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("every monday for 2 weeks → recurring, expansion yields 2 Mondays", () => {
      const r = parseInput("every monday for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).toContain("UNTIL=");
      expect(r.input.scheduledStart).toBe("2026-03-16");
      const rule = RRule.fromString(`DTSTART:20260316T000000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(2);
    });

    it("every day for 5 days → FREQ=DAILY, expansion yields 5 days", () => {
      const r = parseInput("water plant every day at 7am for 5 days", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("UNTIL=");
      // 7am with NOW=12:00 → tomorrow (3/16); 5-day window ends 3/20.
      expect(r.input.scheduledStart).toBe("2026-03-16T07:00:00");
      const rule = RRule.fromString(`DTSTART:20260316T070000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(5);
    });

    it("every month for 3 months → FREQ=MONTHLY, 3 occurrences", () => {
      const r = parseInput("pay rent every month for 3 months", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=MONTHLY");
      expect(r.rrule).toContain("UNTIL=");
      // dtstart = today (2026-03-15). UNTIL ≈ +89 days ≈ June 11.
      // Monthly from 3/15: 3/15, 4/15, 5/15, 6/15 — but UNTIL < 6/15 → 3 occurrences.
      const rule = RRule.fromString(`DTSTART:20260315T000000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(3);
    });

    it("every monday through april 30 → UNTIL=2026-04-30", () => {
      const r = parseInput("standup every monday through april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("UNTIL=2026043");
      expect(r.rrule).toContain("BYDAY=MO");
      // Mondays on/before Apr 30: 3/16, 3/23, 3/30, 4/6, 4/13, 4/20, 4/27 = 7
      const rule = RRule.fromString(`DTSTART:20260316T000000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(7);
    });

    it("every tuesday and thursday for 2 weeks → BYDAY=TU,TH, 4 occurrences", () => {
      const r = parseInput("gym every tuesday and thursday at 6pm for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=TU,TH");
      expect(r.rrule).toContain("UNTIL=");
      // From 3/15, scheduledStart = Tue 3/17 18:00. 2 weeks window = through 3/30.
      // Occurrences: 3/17, 3/19, 3/24, 3/26 = 4
      const rule = RRule.fromString(`DTSTART:20260317T180000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(4);
    });

    it("every weekday for 2 weeks → BYDAY=MO..FR, 10 occurrences", () => {
      const r = parseInput("standup every weekday at 9am for 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO,TU,WE,TH,FR");
      expect(r.rrule).toContain("UNTIL=");
      const rule = RRule.fromString(`DTSTART:20260316T090000Z\nRRULE:${r.rrule}`);
      expect(rule.all().length).toBe(10);
    });

    it("bounded recurrence preserves tags, folder, priority", () => {
      const r = parseInput("standup every monday at 9am for 4 weeks #work !high ~Engineering", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.input.tags).toEqual(["work"]);
      expect(r.input.priority).toBe("high");
      expect(r.input.folderQuery).toBe("Engineering");
      expect(r.input.title).toBe("standup");
    });

    it("bounded recurrence RRULE does NOT contain DTSTART", () => {
      const r = parseInput("every monday for 4 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).not.toContain("DTSTART");
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
    it("biweekly → FREQ=WEEKLY;INTERVAL=2", () => {
      const r = parseInput("sync biweekly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.input.title).toBe("sync");
    });

    it("bimonthly → FREQ=MONTHLY;INTERVAL=2", () => {
      const r = parseInput("rent bimonthly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=MONTHLY");
      expect(r.rrule).toContain("INTERVAL=2");
    });

    it("fortnightly → FREQ=WEEKLY;INTERVAL=2", () => {
      const r = parseInput("review fortnightly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
    });

    it("every other week → FREQ=WEEKLY;INTERVAL=2", () => {
      const r = parseInput("sync every other week", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
    });

    it("every other day → FREQ=DAILY;INTERVAL=2", () => {
      const r = parseInput("water plants every other day", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("INTERVAL=2");
    });

    it("every 2 weeks → FREQ=WEEKLY;INTERVAL=2", () => {
      const r = parseInput("sync every 2 weeks", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=WEEKLY");
      expect(r.rrule).toContain("INTERVAL=2");
    });

    it("every 3 days → FREQ=DAILY;INTERVAL=3", () => {
      const r = parseInput("water plants every 3 days", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("INTERVAL=3");
    });

    it("every 6 months → FREQ=MONTHLY;INTERVAL=6", () => {
      const r = parseInput("checkup every 6 months", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=MONTHLY");
      expect(r.rrule).toContain("INTERVAL=6");
    });

    it("every 2 weeks + COUNT → bounded", () => {
      const r = parseInput("sync every 2 weeks 5 times", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("INTERVAL=2");
      expect(r.rrule).toContain("COUNT=5");
    });
  });

  // ─── 7n. Yearly / annually ───────────────────────────────────────────────

  describe("yearly cadence", () => {
    it("yearly → FREQ=YEARLY", () => {
      const r = parseInput("renewal yearly", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=YEARLY");
      expect(r.input.title).toBe("renewal");
    });

    it("annually → FREQ=YEARLY", () => {
      const r = parseInput("taxes annually", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=YEARLY");
    });

    it("every year → FREQ=YEARLY", () => {
      const r = parseInput("birthday every year", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=YEARLY");
    });
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
    it("'vacation April 18-25' → Apr 18 → Apr 25, date-only", () => {
      const r = parseInput("vacation April 18-25", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("vacation");
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
    });

    it("'vacation from April 18 to April 25' → Apr 18 → Apr 25", () => {
      const r = parseInput("vacation from April 18 to April 25", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
    });

    it("'offsite April 18 to April 20' → Apr 18 → Apr 20", () => {
      // "to" joins a date range; chrono returns both dates with day-certainty.
      // "through" / "thru" between "<Month> <day>" pairs is normalized to "to"
      // at the top of parseInput so spans parse identically — see the dedicated
      // "'<Month> <day> through ...'" cases below.
      const r = parseInput("offsite April 18 to April 20", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-20");
    });

    it("single bare date (no range) → no scheduledEnd", () => {
      const r = parseInput("vacation April 18", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBeUndefined();
    });

    it("date range with time → treated as single-day timed (range ignored)", () => {
      // Intentionally conservative: mixed semantics are too error-prone.
      const r = parseInput("trip April 18-20 at 3pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-04-18");
      expect(r.input.scheduledStart).toContain("15:00");
      // End, if present, should be on the same day (from time range), never Apr 20.
      if (r.input.scheduledEnd) {
        expect(r.input.scheduledEnd).toContain("2026-04-18");
      }
    });

    it("time range on same day still works (unaffected)", () => {
      const r = parseInput("meeting 3pm to 5pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("15:00");
      expect(r.input.scheduledEnd).toContain("17:00");
    });

    // "<Month> <day> through <day>" gets normalized to "... to ..." up front;
    // without this, chrono reads "2 through 10" as a time range (2am–10am) and
    // the result is a 2am timed event tomorrow instead of the span the user typed.
    it("'travel May 2 through 10' → May 2 → May 10 span", () => {
      const r = parseInput("travel May 2 through 10", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("travel");
      expect(r.input.scheduledStart).toBe("2026-05-02");
      expect(r.input.scheduledEnd).toBe("2026-05-10");
    });

    it("'travel May 2 thru 10' → same span via 'thru' alias", () => {
      const r = parseInput("travel May 2 thru 10", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-05-02");
      expect(r.input.scheduledEnd).toBe("2026-05-10");
    });

    it("'trip April 18 through April 25' → span, not recurring window", () => {
      const r = parseInput("trip April 18 through April 25", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-04-18");
      expect(r.input.scheduledEnd).toBe("2026-04-25");
    });

    it("'trip Dec 28 through Jan 3' → cross-year span", () => {
      const r = parseInput("trip Dec 28 through Jan 3", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBe("2026-12-28");
      expect(r.input.scheduledEnd).toBe("2027-01-03");
    });

    // Regression: cadence + "through" stays a bounded-recurrence window —
    // the rewrite only fires when a "<Month> <day>" literal sits immediately
    // before "through", which isn't the case here.
    it("regression: 'practice piano through june' still a daily window", () => {
      const r = parseInput("practice piano through june", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("FREQ=DAILY");
      expect(r.rrule).toContain("UNTIL=202606");
    });

    it("regression: 'standup every monday through april 30' stays bounded", () => {
      const r = parseInput("standup every monday through april 30", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
      expect(r.rrule).toContain("UNTIL=2026043");
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
    it("bare 'tomorrow' is accepted", () => {
      const r = parseInput("team meeting tomorrow at 2pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team meeting");
      expect(r.input.scheduledStart).toContain("2026-03-16");
      expect(r.input.scheduledStart).toContain("14:00");
    });

    it("bare 'today' is accepted", () => {
      const r = parseInput("lunch today", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("lunch");
      expect(r.input.scheduledStart).toContain("2026-03-15");
    });

    it("bare full day name at start", () => {
      // "monday" at start: chrono picks it up as first result; subsequent "9am" is a
      // separate result and not merged (parser uses chronoResults[0] only).
      // Test without a trailing time to cleanly verify day-at-start parsing.
      const r = parseInput("monday standup", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("standup");
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("bare full day name at end", () => {
      const r = parseInput("standup monday", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("standup");
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("bare full day name in the middle", () => {
      const r = parseInput("team monday meeting", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("team meeting");
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("'next friday' multi-word phrase", () => {
      const r = parseInput("review next friday at 3pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("review");
      expect(r.input.scheduledStart).toContain("15:00");
    });

    it("'this wednesday' multi-word phrase", () => {
      const r = parseInput("sync this wednesday", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("sync");
      expect(r.input.scheduledStart).toContain("2026-03-18");
    });

    it("'in 3 days' relative phrase", () => {
      const r = parseInput("deadline in 3 days", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("deadline");
      expect(r.input.scheduledStart).toContain("2026-03-18");
    });

    it("bare month + day: 'march 20'", () => {
      const r = parseInput("call march 20 at 3:30pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("call");
      expect(r.input.scheduledStart).toContain("2026-03-20");
      expect(r.input.scheduledStart).toContain("15:30");
    });

    it("bare month alone: 'march' → accepted as March 1st", () => {
      const r = parseInput("plan trip march", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("plan trip");
      expect(r.input.scheduledStart).toBeDefined();
      // chrono with forwardDate should resolve to next March 1
    });

    it("bare month in compound phrase: 'may' NOT parsed (known limitation)", () => {
      // "may" in "may day celebration" is ambiguous enough that chrono skips it.
      // This is the safe/correct behavior — no false positive here.
      const r = parseInput("may day celebration", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toBeUndefined();
      expect(r.input.title).toBe("may day celebration");
    });

    it("bare time '2pm' still works", () => {
      const r = parseInput("meeting 2pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("14:00");
    });

    it("@tomorrow still works", () => {
      const r = parseInput("meeting @tomorrow at 2pm", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.title).toBe("meeting");
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("@monday still works", () => {
      const r = parseInput("standup @monday 9am", NOW);
      expect(r.type).toBe("single");
      if (r.type !== "single") return;
      expect(r.input.scheduledStart).toContain("2026-03-16");
    });

    it("bare day name consumed by 'every' before chrono sees it", () => {
      const r = parseInput("standup every monday", NOW);
      expect(r.type).toBe("recurring");
      if (r.type !== "recurring") return;
      expect(r.rrule).toContain("BYDAY=MO");
    });

    it("slash syntax consumed before chrono sees it", () => {
      const r = parseInput("run m/w/f at 3pm", NOW);
      expect(r.type).toBe("finite");
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
});
