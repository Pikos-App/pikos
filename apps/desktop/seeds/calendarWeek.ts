// The current week, ramping from a quiet Monday to a packed Sunday, across five
// color-coded folders. Each day adds one layer of layout complexity, so the
// cascade and text-collision code meets the patterns real calendars produce
// against a busy palette rather than synthetic stress shapes.

import type { StorageAdapter } from "@pikos/core";
import { startOfWeek } from "date-fns";

import { doc, p } from "./doc";
import { at, ensureFolder, plantPage } from "./plant";

export type CalendarFolderKey = "work" | "personal" | "health" | "family" | "errands";

const FOLDERS: Record<CalendarFolderKey, { name: string; color: string }> = {
  errands: { color: "#f59e0b", name: "Errands" },
  family: { color: "#10b981", name: "Family & social" },
  health: { color: "#8b5cf6", name: "Health" },
  personal: { color: "#3b82f6", name: "Personal" },
  work: { color: "#ef4444", name: "Work" },
};

export async function calendarFolders(
  adapter: StorageAdapter
): Promise<Record<CalendarFolderKey, string>> {
  const ids = {} as Record<CalendarFolderKey, string>;
  for (const key of Object.keys(FOLDERS) as CalendarFolderKey[]) {
    ids[key] = (await ensureFolder(adapter, FOLDERS[key].name, { color: FOLDERS[key].color })).id;
  }
  return ids;
}

/** Days from this Monday to today, so `at(mondayOffset() + n, …)` lands on weekday `n`. */
export function mondayOffset(now: Date = new Date()): number {
  const monday = startOfWeek(now, { weekStartsOn: 1 });
  return Math.round((monday.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
}

interface EventSpec {
  title: string;
  folder: CalendarFolderKey;
  start: { hour: number; minute?: number };
  /** Omitted or 0 is a point event with no end. */
  durationMin?: number;
}

export async function plantCalendarWeek(adapter: StorageAdapter): Promise<void> {
  const folderIds = await calendarFolders(adapter);
  const monday = mondayOffset();

  async function seedDay(weekday: number, events: EventSpec[]): Promise<void> {
    for (const event of events) {
      const minute = event.start.minute ?? 0;
      const start = at(monday + weekday, event.start.hour, minute);
      const duration = event.durationMin ?? 0;
      await plantPage(adapter, {
        content: doc(p(event.title), p("Calendar test event.")),
        folderId: folderIds[event.folder],
        start,
        tags: ["calendar-test"],
        title: event.title,
        ...(duration > 0 && { end: at(monday + weekday, event.start.hour, minute + duration) }),
      });
    }
  }

  // Mon: three sequential meetings, no overlap. The full-width baseline.
  await seedDay(0, [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "1:1 with Sarah" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Design review" },
  ]);

  // Tue: point events beside duration blocks, still no overlap.
  await seedDay(1, [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "Sprint planning" },
    { folder: "errands", start: { hour: 12 }, title: "Lunch with Marcus" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Customer call — Acme" },
    { folder: "personal", start: { hour: 16, minute: 30 }, title: "Submit timesheet" },
  ]);

  // Wed: one double-booking, an overrun spilling into the next call. 2-deep cascade.
  await seedDay(2, [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 90, folder: "work", start: { hour: 10 }, title: "Design review (overrun)" },
    { durationMin: 60, folder: "work", start: { hour: 11 }, title: "Customer call — Foundry" },
    { durationMin: 30, folder: "errands", start: { hour: 13 }, title: "Quick lunch" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "1:1 with Marcus" },
    { folder: "personal", start: { hour: 16 }, title: "Send weekly recap" },
  ]);

  // Thu: a workshop with two meetings stacked on it. 3-deep cascade.
  await seedDay(3, [
    { durationMin: 30, folder: "work", start: { hour: 9 }, title: "Standup" },
    { durationMin: 60, folder: "work", start: { hour: 10 }, title: "Sprint review" },
    { folder: "errands", start: { hour: 12 }, title: "Pickup lunch" },
    { durationMin: 90, folder: "work", start: { hour: 13 }, title: "Workshop — discovery" },
    { durationMin: 60, folder: "work", start: { hour: 14 }, title: "Peer 1:1 (Alex)" },
    { durationMin: 60, folder: "work", start: { hour: 14, minute: 30 }, title: "Stakeholder sync" },
    { folder: "personal", start: { hour: 16, minute: 30 }, title: "EOD recap to team" },
  ]);

  // Fri: cascade plus two point reminders at the same minute, so the cascade
  // meets text-collision sub-column splitting.
  await seedDay(4, [
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

  // Sat: a spread-out personal day.
  await seedDay(5, [
    { durationMin: 60, folder: "health", start: { hour: 8 }, title: "Morning run" },
    { durationMin: 90, folder: "family", start: { hour: 10 }, title: "Brunch with Jamie" },
    { durationMin: 120, folder: "errands", start: { hour: 12 }, title: "Errands & groceries" },
    { folder: "family", start: { hour: 14, minute: 30 }, title: "Call Mom" },
    { durationMin: 90, folder: "health", start: { hour: 15 }, title: "Yoga class" },
    { durationMin: 120, folder: "family", start: { hour: 19 }, title: "Dinner with the Kims" },
  ]);

  // Sun: several clusters in one day. Cluster boundaries, more than one
  // text-collision component, and cascades at depth 2 or more.
  await seedDay(6, [
    { durationMin: 60, folder: "health", start: { hour: 7, minute: 30 }, title: "Long run — 10k" },
    { durationMin: 90, folder: "errands", start: { hour: 9 }, title: "Farmer's market run" },
    { durationMin: 60, folder: "family", start: { hour: 9, minute: 30 }, title: "Call Dad" },
    { folder: "errands", start: { hour: 10 }, title: "Pick up dry cleaning" },
    { folder: "errands", start: { hour: 10 }, title: "Drop off Amazon return" },
    { durationMin: 120, folder: "errands", start: { hour: 12 }, title: "Sunday meal prep" },
    { folder: "errands", start: { hour: 12, minute: 30 }, title: "Start rice cooker" },
    { folder: "errands", start: { hour: 13 }, title: "Preheat oven for chicken" },
    { folder: "errands", start: { hour: 13, minute: 30 }, title: "Pack lunch containers" },
    { durationMin: 60, folder: "personal", start: { hour: 15 }, title: "Weekly review" },
    {
      durationMin: 60,
      folder: "personal",
      start: { hour: 15, minute: 30 },
      title: "Plan Monday's priorities",
    },
    { folder: "personal", start: { hour: 16 }, title: "Confirm Mon standup attendees" },
    { folder: "personal", start: { hour: 16 }, title: "Re-read board for sprint planning" },
    { durationMin: 90, folder: "family", start: { hour: 18 }, title: "Family dinner" },
    { durationMin: 60, folder: "family", start: { hour: 19 }, title: "FaceTime grandparents" },
    { folder: "errands", start: { hour: 21 }, title: "Set out clothes for tomorrow" },
    { folder: "personal", start: { hour: 21, minute: 30 }, title: "Wind down — read 30 min" },
  ]);
}
