// Notifications seed — fixtures for manually testing the reminder scheduler.
//
// Everything is anchored to `new Date()` at seed time, so it's useful whenever
// you run it. The scheduler fires a per-page reminder when
// `scheduledStart − minutesBefore` lands inside a minute-aligned 60s window,
// compared against the LOCAL wall clock — so all timed starts here are written
// in local time and "fires in ~N min" means N minutes after you seed.
//
// Reminder model per page:
//   • `reminders: [5, 30]` → explicit page_reminders rows at those lead times.
//   • `reminders` omitted   → no rows → the GLOBAL default lead time applies.
//   • `reminders: [-1]`     → the "disabled" sentinel → never fires.
//   • all-day (date-only start) → excluded from per-event firing entirely.
//
// Watch the staggered cluster fire over the first ~5 minutes, and confirm the
// "must NOT fire" pages (completed, disabled, all-day) stay silent. Overdue and
// all-day pages feed the daily-summary counts (today / overdue) rather than
// per-event notifications.

import type { StorageAdapter } from "@pikos/core";
import { isTimedIso } from "@pikos/core";
import { addDays, addHours, addMinutes, format, set } from "date-fns";

const MARKER = "Notifications seed marker";

async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.includes(MARKER));
}

export async function seedNotifications(adapter: StorageAdapter): Promise<void> {
  if (await alreadySeeded(adapter)) return;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = (d: Date): string => format(d, "yyyy-MM-dd");
  const timedStr = (d: Date): string => format(d, "yyyy-MM-dd'T'HH:mm:ss");
  const clock = (d: Date): string => format(d, "HH:mm");
  const minsFromNow = (n: number): Date => addMinutes(now, n);

  const folder = await adapter.createFolder({
    color: "#f59e0b",
    name: "🔔 Notification Test",
    parentId: null,
  });

  type Spec = {
    title: string;
    note: string;
    status: "not_started" | "done";
    /** scheduledStart — timed ISO (with 'T') or date-only for all-day. Omit for unscheduled. */
    start?: string;
    end?: string;
    /** Explicit page_reminders lead times. Omit → global default. [-1] → disabled sentinel. */
    reminders?: number[];
    priority?: 0 | 1 | 2 | 3 | 4;
    folderId?: string | null;
  };

  async function create(spec: Spec): Promise<void> {
    const page = await adapter.createPage({
      content: doc(p(spec.note)),
      folderId: spec.folderId === undefined ? folder.id : spec.folderId,
      priority: spec.priority ?? 0,
      status: spec.status,
      subtitle: spec.note,
      tags: ["notif-test"],
      title: spec.title,
    });
    if (spec.start) {
      const timed = isTimedIso(spec.start);
      await adapter.createPageSchedule({
        pageId: page.id,
        ...(spec.end !== undefined && { scheduledEnd: spec.end }),
        scheduledStart: spec.start,
        ...(timed && { timezone: tz }),
      });
    }
    if (spec.reminders) {
      for (const minutesBefore of spec.reminders) {
        await adapter.createPageReminder({ minutesBefore, pageId: page.id });
      }
    }
  }

  // ── Marker (delete to allow a non-reset re-seed) ────────────────────────────
  await adapter.createPage({
    content: doc(p(MARKER)),
    folderId: folder.id,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed without a full reset.",
    tags: ["notif-test"],
    title: MARKER,
  });

  // ── A. Imminent — watch these fire, staggered over ~5 min ───────────────────
  // fireTime = start − lead. start = now + offset + lead → fires at now + offset.
  await create({
    end: timedStr(minsFromNow(36)),
    note: `Explicit 5-min reminder. Start ${clock(minsFromNow(6))}, fires ~${clock(minsFromNow(1))}.`,
    priority: 2,
    reminders: [5],
    start: timedStr(minsFromNow(6)),
    status: "not_started",
    title: "Fires in ~1 min · 5-min lead",
  });
  await create({
    end: timedStr(minsFromNow(32)),
    note: `Explicit 0-min reminder (fires at start). Start & fire ~${clock(minsFromNow(2))}.`,
    priority: 1,
    reminders: [0],
    start: timedStr(minsFromNow(2)),
    status: "not_started",
    title: "Fires in ~2 min · at-start (0-min lead)",
  });
  await create({
    end: timedStr(minsFromNow(63)),
    note: `Explicit 30-min reminder. Start ${clock(minsFromNow(33))}, fires ~${clock(minsFromNow(3))}.`,
    priority: 3,
    reminders: [30],
    start: timedStr(minsFromNow(33)),
    status: "not_started",
    title: "Fires in ~3 min · 30-min lead",
  });

  // ── B. Multiple reminders near each other (~4 min) — test stacking/grouping ──
  for (const n of [1, 2, 3]) {
    await create({
      end: timedStr(minsFromNow(44)),
      note: `One of three reminders firing together ~${clock(minsFromNow(4))} (10-min lead).`,
      priority: 2,
      reminders: [10],
      start: timedStr(minsFromNow(14)),
      status: "not_started",
      title: `Cluster ${n}/3 · fires in ~4 min`,
    });
  }

  // ── C. Multiple lead times on ONE page (fires ~5 min, then ~30 min) ─────────
  await create({
    end: timedStr(minsFromNow(65)),
    note: `30-min lead fires ~${clock(minsFromNow(5))}; 5-min lead fires ~${clock(minsFromNow(30))}.`,
    priority: 2,
    reminders: [5, 30],
    start: timedStr(minsFromNow(35)),
    status: "not_started",
    title: "Two reminders on one page (5 + 30 min)",
  });

  // ── D. Global-default path — fire time depends on the Settings lead time ────
  await create({
    end: timedStr(minsFromNow(42)),
    note: "No explicit reminder rows. With the default 10-min lead, start is now+12 → fires ~2 min. Changes if you alter the default in Settings.",
    priority: 1,
    start: timedStr(minsFromNow(12)),
    status: "not_started",
    title: "Fires via GLOBAL default lead",
  });

  // ── E. MUST NOT FIRE — completed pages with imminent reminders ──────────────
  await create({
    end: timedStr(minsFromNow(36)),
    note: `status=done with an imminent 5-min reminder (would fire ~${clock(minsFromNow(1))}). If a notification appears, that's the completed-page bug.`,
    priority: 2,
    reminders: [5],
    start: timedStr(minsFromNow(6)),
    status: "done",
    title: "COMPLETED — must NOT fire (5-min lead)",
  });
  await create({
    note: `status=done, 0-min lead, start ~${clock(minsFromNow(2))}. Should stay silent.`,
    priority: 1,
    reminders: [0],
    start: timedStr(minsFromNow(2)),
    status: "done",
    title: "COMPLETED — must NOT fire (at-start)",
  });

  // ── F. MUST NOT FIRE — disabled sentinel ────────────────────────────────────
  await create({
    note: `page_reminders.minutesBefore = -1 with an imminent start (~${clock(minsFromNow(3))}). Confirms the disabled sentinel suppresses firing.`,
    priority: 1,
    reminders: [-1],
    start: timedStr(minsFromNow(3)),
    status: "not_started",
    title: "Reminders DISABLED (sentinel) — must NOT fire",
  });

  // ── G. All-day — never fire per-event; feed today's summary count ───────────
  await create({
    note: "Date-only start → excluded from per-event reminders. Counts toward the daily-summary 'scheduled today' total.",
    priority: 2,
    start: dateStr(now),
    status: "not_started",
    title: "All-day TODAY (no per-event fire)",
  });
  await create({
    note: "Done all-day page — should not count as overdue and should not fire.",
    start: dateStr(now),
    status: "done",
    title: "All-day TODAY — COMPLETED",
  });
  await create({
    note: "All-day page that also has an explicit 0-min reminder. All-day exclusion should win — no per-event notification.",
    priority: 1,
    reminders: [0],
    start: dateStr(now),
    status: "not_started",
    title: "All-day WITH a reminder row — still must NOT fire",
  });

  // ── H. Overdue / past — feed daily-summary overdue count, no late firing ────
  await create({
    end: timedStr(addHours(now, -1)),
    note: "Timed start 2h in the past. Per-event won't fire (outside the 60s window); shows in the daily summary overdue count.",
    priority: 2,
    reminders: [10],
    start: timedStr(addHours(now, -2)),
    status: "not_started",
    title: "Overdue ~2h ago",
  });
  await create({
    note: "Within the 24h overdue window — should count as overdue.",
    priority: 1,
    start: timedStr(addHours(now, -20)),
    status: "not_started",
    title: "Overdue ~20h ago",
  });
  await create({
    note: "Older than 24h — should NOT count as overdue (tests the horizon).",
    priority: 3,
    start: timedStr(addHours(now, -30)),
    status: "not_started",
    title: "Overdue ~30h ago (outside 24h window)",
  });
  await create({
    note: "status=done 3h ago — should not appear in the overdue count.",
    start: timedStr(addHours(now, -3)),
    status: "done",
    title: "Overdue but COMPLETED (no overdue count)",
  });

  // ── I. Future — present in the calendar, reminders won't fire soon ──────────
  const tomorrow9 = set(addDays(now, 1), { hours: 9, milliseconds: 0, minutes: 0, seconds: 0 });
  await create({
    end: timedStr(addMinutes(tomorrow9, 60)),
    note: "Future timed event with the global default reminder. Reminder fires tomorrow, not during this session.",
    priority: 2,
    start: timedStr(tomorrow9),
    status: "not_started",
    title: "Tomorrow 9:00am",
  });
  await create({
    note: "Far-future timed event — sanity check that distant reminders don't fire early.",
    priority: 1,
    start: timedStr(addDays(now, 3)),
    status: "not_started",
    title: "In ~3 days",
  });
  await create({
    note: "All-day a week out — appears in the calendar; no per-event reminder.",
    priority: 4,
    start: dateStr(addDays(now, 7)),
    status: "not_started",
    title: "Next week (all-day)",
  });

  // ── J. Unscheduled — no schedule, must never fire ───────────────────────────
  await create({
    folderId: null,
    note: "No schedule at all — control case; must never produce a notification.",
    priority: 1,
    status: "not_started",
    title: "Unscheduled page (no schedule)",
  });
}

// ── Tiptap JSON helpers ───────────────────────────────────────────────────────

type Node = Record<string, unknown>;

function doc(...nodes: Node[]): string {
  return JSON.stringify({ content: nodes, type: "doc" });
}

function p(text: string): Node {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}
