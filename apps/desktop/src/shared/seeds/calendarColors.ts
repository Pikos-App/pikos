// Calendar (multi-color) seed — the same Mon→Sun ramp as the calendar seed,
// but events are split across 5 color-coded folders so the calendar surfaces
// a realistic mix of folder colors at once. Useful for eyeballing how
// cascade, splits, and chip rendering look against a busy palette.

import type { StorageAdapter } from "@pikos/core";
import { addDays, format, startOfWeek } from "date-fns";

const MARKER = "Calendar multi color seed marker";

async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.includes(MARKER));
}

type FolderKey = "work" | "personal" | "health" | "family" | "errands";

const FOLDER_NAMES: Record<FolderKey, string> = {
  errands: "Errands",
  family: "Family & social",
  health: "Health",
  personal: "Personal",
  work: "Work",
};

const FOLDER_COLORS: Record<FolderKey, string> = {
  errands: "#f59e0b",
  family: "#10b981",
  health: "#8b5cf6",
  personal: "#3b82f6",
  work: "#ef4444",
};

export async function seedCalendarColors(adapter: StorageAdapter): Promise<void> {
  if (await alreadySeeded(adapter)) return;

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

  const folderIds = {} as Record<FolderKey, string>;
  for (const key of Object.keys(FOLDER_NAMES) as FolderKey[]) {
    const folder = await adapter.createFolder({
      color: FOLDER_COLORS[key],
      name: FOLDER_NAMES[key],
      parentId: null,
    });
    folderIds[key] = folder.id;
  }

  await adapter.createPage({
    content: doc(
      p("Calendar multi-color seed marker."),
      p("Same Mon→Sun ramp as the standard calendar seed, but spread across 5 folders:"),
      bullets(...(Object.keys(FOLDER_NAMES) as FolderKey[]).map((k) => FOLDER_NAMES[k])),
      p("Delete this marker page to re-seed.")
    ),
    folderId: folderIds.work,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed",
    tags: [],
    title: MARKER,
  });

  type EventSpec = {
    title: string;
    folder: FolderKey;
    start: { hour: number; minute?: number };
    durationMin?: number;
  };

  async function addEvent(day: Date, spec: EventSpec): Promise<void> {
    const startHour = spec.start.hour;
    const startMin = spec.start.minute ?? 0;
    const start = timed(day, startHour, startMin);

    const page = await adapter.createPage({
      content: doc(p(spec.title), p("Calendar test event.")),
      folderId: folderIds[spec.folder],
      priority: 0,
      status: "not_started",
      subtitle: null,
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

  // Folder mapping rationale:
  //   work     — meetings, calls, sprint ceremonies
  //   personal — admin tasks (timesheets, recaps, planning, EOW close-out)
  //   health   — runs, yoga
  //   family   — calls with family, dinners, social brunch
  //   errands  — food prep, shopping, dry cleaning, returns, lunch pickups

  // ── Mon — quiet, back-to-back ────────────────────────────────────────────
  await seedDay(dayN(0), [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "1:1 with Sarah" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Design review" },
  ]);

  // ── Tue — meetings + point reminders ─────────────────────────────────────
  await seedDay(dayN(1), [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "Sprint planning" },
    { folder: "errands", start: { hour: 12 }, title: "Lunch with Marcus" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Customer call — Acme" },
    { folder: "personal", start: { hour: 16, minute: 30 }, title: "Submit timesheet" },
  ]);

  // ── Wed — first real conflict ────────────────────────────────────────────
  await seedDay(dayN(2), [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    {
      durationMin: 90,
      folder: "work",
      start: { hour: 10 },
      title: "Design review (overrun)",
    },
    {
      durationMin: 60,
      folder: "work",
      start: { hour: 11 },
      title: "Customer call — Foundry",
    },
    { durationMin: 30, folder: "errands", start: { hour: 13 }, title: "Quick lunch" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "1:1 with Marcus" },
    { folder: "personal", start: { hour: 16 }, title: "Send weekly recap" },
  ]);

  // ── Thu — triple-booked afternoon ────────────────────────────────────────
  await seedDay(dayN(3), [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "Sprint review" },
    { folder: "errands", start: { hour: 12 }, title: "Pickup lunch" },
    {
      durationMin: 90,
      folder: "work",
      start: { hour: 13 },
      title: "Workshop — discovery",
    },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Peer 1:1 (Alex)" },
    {
      durationMin: 60,
      folder: "work",
      start: { hour: 14, minute: 30 },
      title: "Stakeholder sync",
    },
    { folder: "personal", start: { hour: 16, minute: 30 }, title: "EOD recap to team" },
  ]);

  // ── Fri — crunch day ─────────────────────────────────────────────────────
  await seedDay(dayN(4), [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "Retro" },
    { durationMin: 60, folder: "work", start: { hour: 11 }, title: "Demo to leadership" },
    { durationMin: 120, folder: "work", start: { hour: 13 }, title: "Strategy session" },
    {
      durationMin: 60,
      folder: "work",
      start: { hour: 13, minute: 30 },
      title: "Ad-hoc 1:1 — Priya",
    },
    { folder: "personal", start: { hour: 14 }, title: "Ping marketing on launch copy" },
    { folder: "personal", start: { hour: 14 }, title: "Respond to investor email" },
    { durationMin: 60, folder: "work", start: { hour: 15 }, title: "Project handoff" },
    { folder: "personal", start: { hour: 17 }, title: "Close out the week" },
  ]);

  // ── Sat — personal-life day ──────────────────────────────────────────────
  await seedDay(dayN(5), [
    { durationMin: 60, folder: "health", start: { hour: 8 }, title: "Morning run" },
    { durationMin: 90, folder: "family", start: { hour: 10 }, title: "Brunch with Jamie" },
    { durationMin: 120, folder: "errands", start: { hour: 12 }, title: "Errands & groceries" },
    { folder: "family", start: { hour: 14, minute: 30 }, title: "Call Mom" },
    { durationMin: 90, folder: "health", start: { hour: 15 }, title: "Yoga class" },
    { durationMin: 120, folder: "family", start: { hour: 19 }, title: "Dinner with the Kims" },
  ]);

  // ── Sun — full chaos ─────────────────────────────────────────────────────
  await seedDay(dayN(6), [
    // Morning cluster
    { durationMin: 60, folder: "health", start: { hour: 7, minute: 30 }, title: "Long run — 10k" },
    {
      durationMin: 90,
      folder: "errands",
      start: { hour: 9 },
      title: "Farmer's market run",
    },
    { durationMin: 60, folder: "family", start: { hour: 9, minute: 30 }, title: "Call Dad" },
    { folder: "errands", start: { hour: 10 }, title: "Pick up dry cleaning" },
    { folder: "errands", start: { hour: 10 }, title: "Drop off Amazon return" },
    // Midday — meal prep block with point reminders inside
    { durationMin: 120, folder: "errands", start: { hour: 12 }, title: "Sunday meal prep" },
    { folder: "errands", start: { hour: 12, minute: 30 }, title: "Start rice cooker" },
    { folder: "errands", start: { hour: 13 }, title: "Preheat oven for chicken" },
    { folder: "errands", start: { hour: 13, minute: 30 }, title: "Pack lunch containers" },
    // Afternoon — week prep cluster
    { durationMin: 60, folder: "personal", start: { hour: 15 }, title: "Weekly review" },
    {
      durationMin: 60,
      folder: "personal",
      start: { hour: 15, minute: 30 },
      title: "Plan Monday's priorities",
    },
    { folder: "personal", start: { hour: 16 }, title: "Confirm Mon standup attendees" },
    { folder: "personal", start: { hour: 16 }, title: "Re-read board for sprint planning" },
    // Evening — wind down + social
    { durationMin: 90, folder: "family", start: { hour: 18 }, title: "Family dinner" },
    { durationMin: 60, folder: "family", start: { hour: 19 }, title: "FaceTime grandparents" },
    { folder: "errands", start: { hour: 21 }, title: "Set out clothes for tomorrow" },
    { folder: "personal", start: { hour: 21, minute: 30 }, title: "Wind down — read 30 min" },
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
