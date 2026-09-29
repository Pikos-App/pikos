// Calendar layout seed — a realistic week that ramps from a quiet Monday to a
// packed Sunday. Each day adds the next layer of complexity (point reminders,
// double-bookings, triple-bookings, mixed point+duration overlaps, multi-
// cluster days) so buildDayBlocks gets exercised against patterns that
// actually show up in real calendars, not synthetic stress shapes.

import type { StorageAdapter } from "@pikos/core";
import { addDays, format, startOfWeek } from "date-fns";

const MARKER = "Calendar seed marker";

async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.includes(MARKER));
}

export async function seedCalendar(adapter: StorageAdapter): Promise<void> {
  if (await alreadySeeded(adapter)) return;

  // Anchor at Monday of the current week so the 7-day view shows the full ramp
  // from quiet Monday to chaotic Sunday in a single screen.
  const monday = startOfWeek(new Date(), { weekStartsOn: 1 });

  function dayN(n: number): Date {
    return addDays(monday, n);
  }

  function dateStr(d: Date): string {
    return format(d, "yyyy-MM-dd");
  }

  function timed(d: Date, hour: number, minute = 0): string {
    return `${dateStr(d)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  const calendar = await adapter.createFolder({
    color: "#6366f1",
    name: "Calendar test",
    parentId: null,
  });

  await adapter.createPage({
    content: doc(
      p("Calendar layout seed marker."),
      p("A realistic Mon–Sun ramp for refining buildDayBlocks + PageBlock layout:"),
      bullets(
        "Mon — quiet day, fully back-to-back",
        "Tue — adds point reminders alongside meetings",
        "Wed — first real conflict (one double-booked slot)",
        "Thu — triple-booked afternoon (workshop + 1:1 + sync)",
        "Fri — crunch day: cascade plus same-time point reminders",
        "Sat — personal-life day (errands, social, exercise)",
        "Sun — full chaos: multiple clusters across morning + afternoon + evening"
      ),
      p("Delete this marker page to re-seed.")
    ),
    folderId: calendar.id,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed",
    tags: [],
    title: MARKER,
  });

  type EventSpec = {
    title: string;
    /** Hour the event starts on `day`. */
    start: { hour: number; minute?: number };
    /** Duration in minutes. Omit / 0 → "non-duration" point event (no scheduledEnd). */
    durationMin?: number;
    subtitle?: string;
  };

  async function addEvent(day: Date, spec: EventSpec): Promise<void> {
    const startHour = spec.start.hour;
    const startMin = spec.start.minute ?? 0;
    const start = timed(day, startHour, startMin);

    const page = await adapter.createPage({
      content: doc(p(spec.title), spec.subtitle ? p(spec.subtitle) : p("Calendar test event.")),
      folderId: calendar.id,
      priority: 0,
      status: "not_started",
      subtitle: spec.subtitle ?? null,
      tags: ["calendar-test"],
      title: spec.title,
    });

    const durationMin = spec.durationMin ?? 0;
    if (durationMin <= 0) {
      await adapter.createPageSchedule({
        pageId: page.id,
        scheduledStart: start,
        timezone: "America/Los_Angeles",
      });
      return;
    }

    const totalMin = startHour * 60 + startMin + durationMin;
    const endHour = Math.floor(totalMin / 60);
    const endMin = totalMin % 60;
    const end = timed(day, endHour, endMin);
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: end,
      scheduledStart: start,
      timezone: "America/Los_Angeles",
    });
  }

  async function seedDay(day: Date, events: EventSpec[]): Promise<void> {
    for (const ev of events) await addEvent(day, ev);
  }

  // ── Mon — quiet, back-to-back ────────────────────────────────────────────
  // The mildest day of the week. Three sequential meetings, no point events,
  // no overlap. Baseline for "everything renders full-width, no cascade."
  await seedDay(dayN(0), [
    { durationMin: 30, start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, start: { hour: 10 }, title: "1:1 with Sarah" },
    { durationMin: 60, start: { hour: 14 }, title: "Design review" },
  ]);

  // ── Tue — meetings + point reminders ─────────────────────────────────────
  // Adds non-duration "point" events (lunch reminder, timesheet) alongside
  // normal meetings. Tests rendering of 15-min minimum-height chips next to
  // proper duration blocks, no overlap.
  await seedDay(dayN(1), [
    { durationMin: 30, start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, start: { hour: 10 }, title: "Sprint planning" },
    { start: { hour: 12 }, title: "Lunch with Marcus" },
    { durationMin: 60, start: { hour: 14 }, title: "Customer call — Acme" },
    { start: { hour: 16, minute: 30 }, title: "Submit timesheet" },
  ]);

  // ── Wed — first real conflict ────────────────────────────────────────────
  // Classic real-life double-booking: design review runs long and overlaps the
  // start of the customer call. Tests 2-deep cascade with one event continuing
  // into the next.
  await seedDay(dayN(2), [
    { durationMin: 30, start: { hour: 9 }, title: "Standup" },
    { durationMin: 90, start: { hour: 10 }, title: "Design review (overrun)" },
    { durationMin: 60, start: { hour: 11 }, title: "Customer call — Foundry" },
    { durationMin: 30, start: { hour: 13 }, title: "Quick lunch" },
    { durationMin: 60, start: { hour: 14 }, title: "1:1 with Marcus" },
    { start: { hour: 16 }, title: "Send weekly recap" },
  ]);

  // ── Thu — triple-booked afternoon ────────────────────────────────────────
  // The "I have three meetings at the same time" day. A long workshop with a
  // peer 1:1 and a stakeholder sync stacked on top. Tests 3-deep cascade with
  // varying durations all colliding around the same hour.
  await seedDay(dayN(3), [
    { durationMin: 30, start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, start: { hour: 10 }, title: "Sprint review" },
    { start: { hour: 12 }, title: "Pickup lunch" },
    { durationMin: 90, start: { hour: 13 }, title: "Workshop — discovery" },
    { durationMin: 60, start: { hour: 14 }, title: "Peer 1:1 (Alex)" },
    { durationMin: 60, start: { hour: 14, minute: 30 }, title: "Stakeholder sync" },
    { start: { hour: 16, minute: 30 }, title: "EOD recap to team" },
  ]);

  // ── Fri — crunch day: cascade + same-time reminders ──────────────────────
  // Realistic Friday: morning sequential meetings, afternoon strategy session
  // overlapped by an ad-hoc 1:1, plus two point reminders fired at the same
  // minute. Tests cascade combined with text-collision sub-column splitting.
  await seedDay(dayN(4), [
    { durationMin: 30, start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, start: { hour: 10 }, title: "Retro" },
    { durationMin: 60, start: { hour: 11 }, title: "Demo to leadership" },
    { durationMin: 120, start: { hour: 13 }, title: "Strategy session" },
    { durationMin: 60, start: { hour: 13, minute: 30 }, title: "Ad-hoc 1:1 — Priya" },
    { start: { hour: 14 }, title: "Ping marketing on launch copy" },
    { start: { hour: 14 }, title: "Respond to investor email" },
    { durationMin: 60, start: { hour: 15 }, title: "Project handoff" },
    { start: { hour: 17 }, title: "Close out the week" },
  ]);

  // ── Sat — personal-life day ──────────────────────────────────────────────
  // Different shape entirely: a weekend with errands, social, exercise, family
  // time. Mixes longer leisure blocks with short reminders. No back-to-back
  // meetings. Tests the layout for the "non-work" calendar shape.
  await seedDay(dayN(5), [
    { durationMin: 60, start: { hour: 8 }, title: "Morning run" },
    { durationMin: 90, start: { hour: 10 }, title: "Brunch with Jamie" },
    { durationMin: 120, start: { hour: 12 }, title: "Errands & groceries" },
    { start: { hour: 14, minute: 30 }, title: "Call Mom" },
    { durationMin: 90, start: { hour: 15 }, title: "Yoga class" },
    { durationMin: 120, start: { hour: 19 }, title: "Dinner with the Kims" },
  ]);

  // ── Sun — full chaos ─────────────────────────────────────────────────────
  // Sunday is when prep + personal + planning all collide. Three distinct
  // clusters (morning errands, midday calls, evening prep) plus point
  // reminders sprinkled throughout. Stresses cluster boundary detection,
  // multiple text-collision components in the same day, and depth ≥ 2 cascade.
  await seedDay(dayN(6), [
    // Morning cluster — errands overlap with a workout and a phone call
    { durationMin: 60, start: { hour: 7, minute: 30 }, title: "Long run — 10k" },
    { durationMin: 90, start: { hour: 9 }, title: "Farmer's market run" },
    { durationMin: 60, start: { hour: 9, minute: 30 }, title: "Call Dad" },
    { start: { hour: 10 }, title: "Pick up dry cleaning" },
    { start: { hour: 10 }, title: "Drop off Amazon return" },
    // Midday — meal prep block with point reminders inside
    { durationMin: 120, start: { hour: 12 }, title: "Sunday meal prep" },
    { start: { hour: 12, minute: 30 }, title: "Start rice cooker" },
    { start: { hour: 13 }, title: "Preheat oven for chicken" },
    { start: { hour: 13, minute: 30 }, title: "Pack lunch containers" },
    // Afternoon — week prep cluster
    { durationMin: 60, start: { hour: 15 }, title: "Weekly review" },
    { durationMin: 60, start: { hour: 15, minute: 30 }, title: "Plan Monday's priorities" },
    { start: { hour: 16 }, title: "Confirm Mon standup attendees" },
    { start: { hour: 16 }, title: "Re-read board for sprint planning" },
    // Evening — wind down + social
    { durationMin: 90, start: { hour: 18 }, title: "Family dinner" },
    { durationMin: 60, start: { hour: 19 }, title: "FaceTime grandparents" },
    { start: { hour: 21 }, title: "Set out clothes for tomorrow" },
    { start: { hour: 21, minute: 30 }, title: "Wind down — read 30 min" },
  ]);
}

// ── Tiptap JSON helpers ──────────────────────────────────────────────────────

type Node = Record<string, unknown>;

function doc(...nodes: Node[]): string {
  return JSON.stringify({ content: nodes, type: "doc" });
}

function p(text: string): Node {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function bullets(...items: string[]): Node {
  return {
    content: items.map((text) => ({
      content: [p(text)],
      type: "listItem",
    })),
    type: "bulletList",
  };
}
