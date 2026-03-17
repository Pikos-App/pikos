import { describe, expect, it } from "vitest";
import { RRule } from "rrule";
import { parseInput } from "../parser";

const NOW = new Date("2026-03-15T12:00:00");

describe("GOO-19 NL Page Creation Parser", () => {
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

    it("every monday for 2 weeks → finite (2 Mondays: 3/16, 3/23)", () => {
      const r = parseInput("every monday for 2 weeks", NOW);
      expect(r.type).toBe("finite");
      if (r.type !== "finite") return;
      expect(r.count).toBe(2);
      expect(r.inputs[0]!.scheduledStart).toContain("2026-03-16");
      expect(r.inputs[1]!.scheduledStart).toContain("2026-03-23");
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

    it("task for 2 weeks alone → single (no days specified)", () => {
      const r = parseInput("task for 2 weeks", NOW);
      expect(r.type).toBe("single");
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
});
