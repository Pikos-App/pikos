// Repeating pages in every rule shape the engine takes, each with a history
// written through the same calls a person makes: completed and skipped past
// occurrences, a backlog left open, a moved instance and a native exdate.
//
// Timed series sit before 09:00 or in the evening, clear of the lanes
// `calendarWeek` and `calendarEdges` lay out, so a fixture's shape still reads.

import type { StorageAdapter } from "@pikos/core";
import { getLocalTimezone } from "@pikos/core";
import {
  addDays,
  format,
  lastDayOfMonth,
  setDate,
  startOfDay,
  startOfMonth,
  subMonths,
} from "date-fns";

import { bullets, doc, p, tasks } from "./doc";
import { at, backdate, day, ensureFolder, instant, type PageSpec, plantPage, shift } from "./plant";

/** Days from today to the first `weekday` (0 = Sunday) on or after `from` days out. */
export function weekdayFrom(weekday: number, from: number, now: Date = new Date()): number {
  const start = addDays(startOfDay(now), from);
  return from + ((weekday - start.getDay() + 7) % 7);
}

function offsetOf(date: Date, now: Date = new Date()): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

interface Routine {
  spec: Omit<PageSpec, "folderId">;
  /**
   * What happened to past occurrences, oldest first: `d` completed, `s`
   * skipped. Once it runs out, `rest` says whether the remaining past
   * occurrences were completed too or left open as a backlog.
   */
  history?: { pattern: string; rest: "done" | "open" };
  /** Move one future occurrence: its date offset, and the new start and end. */
  move?: { originalDay: number; start: string; end: string };
}

const WEEKDAY = { FR: 5, MO: 1, TH: 4, TU: 2, WE: 3 } as const;

function routines() {
  const now = new Date();
  const thursdayAfterNext = weekdayFrom(WEEKDAY.TH, 7);
  const fridayAhead = weekdayFrom(WEEKDAY.FR, 1);
  const lastThursdayLastMonth = (() => {
    const last = lastDayOfMonth(subMonths(now, 1));
    return offsetOf(addDays(last, -((last.getDay() - WEEKDAY.TH + 7) % 7)));
  })();
  const quarterlyAnchor = offsetOf(
    now.getDate() < 15
      ? setDate(now, 15)
      : setDate(startOfMonth(addDays(lastDayOfMonth(now), 1)), 15)
  );

  return {
    birthday: {
      spec: {
        content: doc(p("Card, and call in the morning before she goes out.")),
        repeat: { rrule: "FREQ=YEARLY" },
        start: day(10),
        tags: ["family"],
        title: "Mum's birthday",
      },
    },
    bookClub: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(p("This month: whatever Priya picked. Bring the good biscuits.")),
        end: at(lastThursdayLastMonth, 21),
        repeat: { rrule: "FREQ=MONTHLY;BYDAY=-1TH" },
        start: at(lastThursdayLastMonth, 19, 30),
        tags: ["social"],
        title: "Book club (last Thursday)",
      },
    },
    gym: {
      history: { pattern: "ddsd", rest: "done" },
      move: {
        end: at(thursdayAfterNext, 7, 45),
        originalDay: thursdayAfterNext,
        start: at(thursdayAfterNext, 7),
      },
      spec: {
        content: doc(
          tasks({ checked: false, text: "Squats 5×5" }, { checked: false, text: "Row 2k" })
        ),
        end: at(weekdayFrom(WEEKDAY.TU, -28), 6, 45),
        priority: 1,
        repeat: { rrule: "FREQ=WEEKLY;BYDAY=TU,TH" },
        start: at(weekdayFrom(WEEKDAY.TU, -28), 6),
        tags: ["health"],
        title: "Gym",
      },
    },
    payday: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(bullets("Move savings", "Check the pay slip")),
        repeat: { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR" },
        start: day(weekdayFrom(WEEKDAY.FR, -14)),
        tags: ["finance"],
        title: "Payday (every other Friday)",
      },
    },
    physio: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(p("Six sessions, then the review appointment.")),
        end: at(weekdayFrom(WEEKDAY.MO, -14), 7, 45),
        repeat: { rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6" },
        start: at(weekdayFrom(WEEKDAY.MO, -14), 7, 15),
        tags: ["health"],
        title: "Physio exercises (six weeks)",
      },
    },
    planTheDay: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(tasks({ checked: false, text: "Pick the three things" })),
        end: at(weekdayFrom(WEEKDAY.MO, -7), 8, 30),
        reminders: [10],
        repeat: {
          exdates: [at(fridayAhead, 8, 15)],
          rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
        },
        start: at(weekdayFrom(WEEKDAY.MO, -7), 8, 15),
        title: "Plan the day (weekdays)",
      },
    },
    plants: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(p("Not the cactus.")),
        repeat: { rrule: "FREQ=DAILY;INTERVAL=3" },
        start: day(-12),
        tags: ["home"],
        title: "Water the plants (every 3 days)",
      },
    },
    quarterlyTaxes: {
      spec: {
        content: doc(p("Estimated payment. The figure is in the finance sheet.")),
        priority: 3,
        repeat: { rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15" },
        start: day(quarterlyAnchor),
        tags: ["finance"],
        title: "Quarterly tax payment",
      },
    },
    rent: {
      history: { pattern: "", rest: "done" },
      spec: {
        content: doc(p("Standing order, but check it went.")),
        repeat: { rrule: "FREQ=MONTHLY;BYMONTHDAY=1" },
        start: day(offsetOf(startOfMonth(now))),
        tags: ["finance"],
        title: "Rent goes out",
      },
    },
    spanish: {
      history: { pattern: "s", rest: "done" },
      spec: {
        content: doc(p("Evening course. Ends when the term does.")),
        end: at(weekdayFrom(WEEKDAY.WE, -7), 19, 30),
        repeat: {
          rrule: `FREQ=WEEKLY;BYDAY=WE;UNTIL=${format(addDays(now, 20), "yyyyMMdd")}T235959`,
        },
        start: at(weekdayFrom(WEEKDAY.WE, -7), 18),
        tags: ["learning"],
        title: "Spanish class (until end of term)",
      },
    },
    vitamins: {
      history: { pattern: "ddddddddsddd", rest: "open" },
      spec: {
        content: doc(p("With breakfast.")),
        end: at(-14, 6, 50),
        reminders: [0],
        repeat: { rrule: "FREQ=DAILY" },
        start: at(-14, 6, 45),
        tags: ["health"],
        title: "Take vitamins",
      },
    },
  } satisfies Record<string, Routine>;
}

export type RoutineKey = keyof ReturnType<typeof routines>;

export async function plantRoutines(
  adapter: StorageAdapter,
  only?: readonly RoutineKey[]
): Promise<void> {
  const folder = await ensureFolder(adapter, "Routines", { color: "#14b8a6" });
  const all = routines();
  for (const key of only ?? (Object.keys(all) as RoutineKey[])) {
    await plantRoutine(adapter, folder.id, all[key]);
  }
}

async function plantRoutine(adapter: StorageAdapter, folderId: string, routine: Routine) {
  const { page, ruleId } = await plantPage(adapter, { ...routine.spec, folderId });
  if (routine.history) await replayHistory(adapter, page.id, routine.history);
  if (routine.move && ruleId) {
    await adapter.rescheduleVirtualOccurrence({
      originalDate: day(routine.move.originalDay),
      ruleId,
      scheduledEnd: routine.move.end,
      scheduledStart: routine.move.start,
      timezone: getLocalTimezone(),
    });
  }
}

/**
 * Walk a series' past occurrences oldest first. A native completion always
 * takes the oldest open occurrence, so the head is re-read before each step and
 * a backlog can only be the most recent run of occurrences.
 */
export async function replayHistory(
  adapter: StorageAdapter,
  pageId: string,
  history: { pattern: string; rest: "done" | "open" }
): Promise<void> {
  const today = day(0);
  for (let step = 0; step < 2000; step++) {
    const head = await adapter.getPage(pageId);
    const start = head?.scheduledStart;
    if (!head || head.status === "done" || !start || start.slice(0, 10) >= today) return;

    const action = history.pattern[step] ?? (history.rest === "done" ? "d" : null);
    if (action === null) return;
    if (action === "s") {
      await adapter.skipOccurrence({ occurrenceDate: start.slice(0, 10), pageId });
      continue;
    }
    const { clone } = await adapter.completeRecurringPage({ pageId });
    const finished = start.includes("T")
      ? shift(head.scheduledEnd ?? start, 5)
      : `${start}T20:00:00`;
    await backdate(adapter, clone.id, {
      completedAt: finished,
      createdAt: instant(start.includes("T") ? start : `${start}T08:00:00`),
      updatedAt: instant(finished),
    });
  }
}
