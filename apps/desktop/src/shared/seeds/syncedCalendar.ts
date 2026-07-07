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
// (never shifts), a weekly recurring series, and one detached page (broken-sync).

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
    at(today, 0, 9, 0),
    at(today, 0, 9, 30),
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

  const recStart = at(today, 0, 14, 0);
  const recEnd = at(today, 0, 14, 30);
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

  // Work: cross-zone (Tokyo) + a detached page (editable, broken-sync icon).
  await synced(work, "Tokyo sync", at(today, 1, 8, 0), at(today, 1, 8, 30), "Asia/Tokyo", "active");
  await synced(
    work,
    "Old planning (detached)",
    at(today, 0, 17, 0),
    at(today, 0, 17, 30),
    "America/New_York",
    "detached"
  );
}
