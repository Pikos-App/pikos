import type { MockStorageAdapter, StorageAdapter } from "@pikos/core";
import { formatDateOnly, formatLocalISO } from "@pikos/core";
import { addDays, set } from "date-fns";

// Mock external-calendar sync seed (TEST MODE ONLY). Mirrors the real-DB
// `dev_seed_synced_calendar` Tauri command so Layer-4 tests, the VITE_SEED
// harness, and Playwright exercise synced pages without a network sync.
// The real app path goes through the Tauri command instead (see DeveloperSettings).
//
// Produces the same spread as the dev command: a same-day timed event, a
// cross-zone event (resolves to the viewer's zone, no badge), an all-day event
// (never shifts), a weekly recurring series, a past one-off, and one detached
// page (broken-sync).
//
// Times are picked to miss the realistic seed's day-0 slots (6:30, 8, 9, 9:15,
// 2–4 PM, 3–4 PM, 7 PM), which this scenario stacks onto: a collision collapses
// the loser into the day's "+N more" pill, where no calendar check can see it.
// Judge a cross-zone event at both its offsets — London/New York run an hour
// closer for three weeks a year, so it has two possible lanes and needs both.

function at(base: Date, offsetDays: number, hours: number, minutes: number): string {
  return formatLocalISO(
    set(addDays(base, offsetDays), { hours, milliseconds: 0, minutes, seconds: 0 })
  );
}

export async function seedSyncedCalendar(adapter: StorageAdapter): Promise<void> {
  // markPageSynced is a MockStorageAdapter test seam — this seed never runs
  // against the real adapter (the dev command handles that path).
  const mock = adapter as MockStorageAdapter;

  const account = await adapter.connectCaldavAccount({
    baseUrl: "",
    displayName: "Mock Calendar (dev)",
    password: "",
    username: "",
  });

  const folderByName = new Map<string, string>();
  for (const cal of account.calendars) {
    const color = cal.displayName === "Personal" ? "#7c9cf0" : "#f0a37c";
    const updated = await adapter.toggleSyncCalendar(cal.id, true, color);
    if (updated.folderId) folderByName.set(cal.displayName, updated.folderId);
  }
  const personal = folderByName.get("Personal")!;
  const work = folderByName.get("Work")!;
  const today = new Date();

  const synced = async (
    folderId: string,
    title: string,
    scheduledStart: string,
    scheduledEnd: string | undefined,
    timezone: string | undefined,
    state: "active" | "detached",
    mirror: {
      location?: string;
      attendees?: string[];
      pendingDescription?: string;
      body?: string;
    } = {}
  ): Promise<void> => {
    const { body, ...mirrorMeta } = mirror;
    const page = await adapter.createPage({
      content: body ?? "",
      folderId,
      priority: 0,
      scheduledStart,
      status: "not_started",
      tags: [],
      title,
      ...(scheduledEnd ? { scheduledEnd } : {}),
    });
    mock.markPageSynced(page.id, { state, ...(timezone ? { timezone } : {}), ...mirrorMeta });
  };

  // Personal: same-day (NY), cross-zone (LA), all-day, weekly recurring (London).
  // "Team standup" carries the full B1 read-only mirror surface: location, attendees,
  // a user-edited body, and a withheld upstream description → shows the notice.
  await synced(
    personal,
    "Team standup",
    at(today, 0, 11, 0),
    at(today, 0, 11, 30),
    "America/New_York",
    "active",
    {
      attendees: ["alex@example.com", "sam@example.com", "jordan@example.com"],
      body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"My prep: land the calendar-sync PR before we demo."}]}]}',
      location: "Zoom",
      pendingDescription: "Agenda updated: demo the new sync panel, then round-table blockers.",
    }
  );
  await synced(
    personal,
    "Design review (LA team)",
    at(today, 0, 15, 0),
    at(today, 0, 16, 0),
    "America/Los_Angeles",
    "active",
    { attendees: ["design@example.com"], location: "Room 4B" }
  );
  await synced(personal, "Company offsite", formatDateOnly(today), undefined, undefined, "active");

  // 5 PM London resolves to noon or 1 PM in New York.
  const recStart = at(today, 0, 17, 0);
  const recEnd = at(today, 0, 17, 30);
  const recurring = await adapter.createPage({
    content: "",
    folderId: personal,
    priority: 0,
    scheduledEnd: recEnd,
    scheduledStart: recStart,
    status: "not_started",
    tags: [],
    title: "Weekly 1:1 (London)",
  });
  await adapter.createRecurrenceRule({
    pageId: recurring.id,
    rrule: "FREQ=WEEKLY",
    scheduledEnd: recEnd,
    scheduledStart: recStart,
    timezone: "Europe/London",
  });
  mock.markPageSynced(recurring.id, { state: "active", timezone: "Europe/London" });

  // A synced series with a cancelled instance (a timed EXDATE) and one moved to a
  // later week (an override row with a timed original_date), both stored as full
  // wall-clock — exercises the day-keyed exclusion so neither ghosts at its
  // original slot. Exceptions are seeded before markPageSynced locks the mirror.
  const reviewStart = at(today, 0, 10, 0);
  const reviewEnd = at(today, 0, 10, 30);
  const review = await adapter.createPage({
    content: "",
    folderId: personal,
    priority: 0,
    scheduledEnd: reviewEnd,
    scheduledStart: reviewStart,
    status: "not_started",
    tags: [],
    title: "Recurring review",
  });
  const reviewRule = await adapter.createRecurrenceRule({
    pageId: review.id,
    rrule: "FREQ=WEEKLY",
    scheduledEnd: reviewEnd,
    scheduledStart: reviewStart,
    timezone: "America/New_York",
  });
  await adapter.addRuleExdates(reviewRule.id, [at(today, 7, 10, 0)]);
  await adapter.createPageSchedule({
    originalDate: at(today, 14, 10, 0),
    pageId: review.id,
    ruleId: reviewRule.id,
    scheduledEnd: at(today, 24, 16, 30),
    scheduledStart: at(today, 24, 16, 0),
    timezone: "America/New_York",
  });
  mock.markPageSynced(review.id, { state: "active", timezone: "America/New_York" });

  // Work: cross-zone (Tokyo) + a detached page (editable, broken-sync icon).
  // 10 AM tomorrow in Tokyo resolves to 8 or 9 PM tonight in New York.
  await synced(
    work,
    "Tokyo sync",
    at(today, 1, 10, 0),
    at(today, 1, 10, 30),
    "Asia/Tokyo",
    "active"
  );
  // A one-off two days past: it stays in Today until ticked, so it needs a lane
  // the realistic seed leaves free on a *past* day (that seed fills day −1 only).
  await synced(
    work,
    "Budget sign-off",
    at(today, -2, 13, 0),
    at(today, -2, 13, 30),
    "America/New_York",
    "active"
  );
  await synced(
    work,
    "Old planning (detached)",
    at(today, 0, 17, 0),
    at(today, 0, 17, 30),
    "America/New_York",
    "detached"
  );
}
