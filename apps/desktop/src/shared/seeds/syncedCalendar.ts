import type { MockStorageAdapter, StorageAdapter } from "@pikos/core";
import { formatDateOnly, formatLocalISO } from "@pikos/core";
import { addDays, endOfMonth, format, set } from "date-fns";

// Mock external-calendar sync seed (TEST MODE ONLY). Mirrors the real-DB
// `dev_seed_synced_calendar` Tauri command so Layer-4 tests, the VITE_SEED
// harness, and Playwright exercise synced pages without a network sync.
// The real app path goes through the Tauri command instead (see DeveloperSettings).
//
// Produces the same spread as the dev command: a same-day timed event, a
// cross-zone event (resolves to the viewer's zone, no badge), a zone-less one
// (floats like a native page, and is served by its own reminder query), an
// all-day event (never shifts), an all-day span, a plain weekly series, a live
// series carrying both occurrence deltas (a timed EXDATE + a moved instance), a
// backdated finite series whose occurrences are already overdue, a past one-off,
// one detached page (broken-sync), a detached series with a moved instance, a
// detached all-day series, and the two provider rule shapes that decide whether
// the recurrence chip locks. The Rust side has tests over that list — the two
// halves drifted apart unnoticed once.
//
// Every shape here exists because some behavior is otherwise unreachable in a
// manual pass, so a row retired for looking redundant takes a QA check with it.
//
// Times are picked to miss the realistic seed's day-0 slots (6:30, 8, 9, 9:15,
// 2–4 PM, 3–4 PM, 7 PM), which this scenario stacks onto: a collision collapses
// the loser out of the layout, where no calendar check can see it. Two lanes to
// judge beyond day 0, both of which have cost a red test:
//   · Beyond day+7 the realistic seed places only *recurring* items, whose lane
//     depends on the weekday the run lands on — Mon/Wed/Fri 6:30, weekdays 9:15,
//     Wed 2 PM, Fri 4 PM. An offset far enough out to shift weekday by run day
//     needs a lane free on EVERY weekday, not just today's.
//   · A cross-zone event has two possible lanes — London/New York run an hour
//     closer for three weeks a year — so both must be free.
// The calendar also collapses [0,6) and [22,24) by default: a seed outside that
// band renders nowhere at all. Blocks that merely touch (one ends where the next
// begins) don't cluster, but a block shorter than 15 min is padded to 15 for
// overlap, so measure the lane from the padded end. All-day bars stack in rows
// with no depth cap, so an all-day row is free of all of this.

/** What an all-day series' rule row carries — see the reconciler's `SENTINEL_TZ`. */
const ZONELESS_RULE_TZ = "UTC";

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

  // Mirrors the dev command's `insert_synced_recurring`. Occurrence deltas are
  // written before markPageSynced, which locks an active mirror against them.
  const syncedSeries = async (
    folderId: string,
    title: string,
    baseStart: string,
    baseEnd: string,
    timezone: string | undefined,
    rrule: string,
    series: {
      state?: "active" | "detached";
      exdates?: string[];
      moved?: { original: string; start: string; end: string };
      /** Connect day, when it predates the seed run — the head and render floors. */
      syncedSince?: string;
    } = {}
  ): Promise<void> => {
    const page = await adapter.createPage({
      content: "",
      folderId,
      priority: 0,
      scheduledEnd: baseEnd,
      scheduledStart: baseStart,
      status: "not_started",
      tags: [],
      title,
    });
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule,
      scheduledEnd: baseEnd,
      scheduledStart: baseStart,
      timezone: timezone ?? ZONELESS_RULE_TZ,
    });
    if (series.exdates?.length) await adapter.addRuleExdates(rule.id, series.exdates);
    if (series.moved) {
      await adapter.createPageSchedule({
        originalDate: series.moved.original,
        pageId: page.id,
        ruleId: rule.id,
        scheduledEnd: series.moved.end,
        scheduledStart: series.moved.start,
        ...(timezone ? { timezone } : {}),
      });
    }
    mock.markPageSynced(page.id, {
      state: series.state ?? "active",
      ...(timezone ? { timezone } : {}),
      ...(series.syncedSince ? { syncedSince: series.syncedSince } : {}),
    });
  };

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
  // Ends are stored inclusive, so a 3-day span ends on day+2 — the one shape that
  // shows a double-decremented provider end (it would render 2 days).
  await synced(
    personal,
    "Product summit",
    formatDateOnly(today),
    formatDateOnly(addDays(today, 2)),
    undefined,
    "active"
  );

  // 5 PM London resolves to noon or 1 PM in New York.
  await syncedSeries(
    personal,
    "Weekly 1:1 (London)",
    at(today, 0, 17, 0),
    at(today, 0, 17, 30),
    "Europe/London",
    "FREQ=WEEKLY"
  );

  // A synced series with a cancelled instance (a timed EXDATE) and one moved to a
  // later week (an override row with a timed original_date), both stored as full
  // wall-clock — exercises the day-keyed exclusion so neither ghosts at its
  // original slot.
  await syncedSeries(
    personal,
    "Recurring review",
    at(today, 0, 10, 0),
    at(today, 0, 10, 30),
    "America/New_York",
    "FREQ=WEEKLY",
    {
      exdates: [at(today, 7, 10, 0)],
      moved: {
        end: at(today, 24, 15, 30),
        original: at(today, 14, 10, 0),
        start: at(today, 24, 15, 0),
      },
    }
  );

  // A provider rule whose end condition falls mid-day: rebuilding it as the
  // editor's floating end-of-day would gain the occurrence it excluded, so the
  // chip locks even though the series is detached and otherwise editable.
  await syncedSeries(
    personal,
    "Swim class (term ends)",
    at(today, 0, 6, 0),
    at(today, 0, 6, 30),
    "America/New_York",
    `FREQ=WEEKLY;UNTIL=${format(addDays(today, 21), "yyyyMMdd")}T113000`,
    { state: "detached" }
  );

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
  // A CalDAV event with no TZID floats like a native page, and its reminders are
  // served by neither the zoned nor the native query but a third one.
  await synced(
    work,
    "Contractor call (no zone)",
    at(today, 0, 13, 30),
    at(today, 0, 14, 0),
    undefined,
    "active"
  );

  // A detached series carrying a provider-moved instance: its occurrences stay
  // in-series as override rows rather than cloning out, so the moved block is
  // unlocked and a re-link can reclaim the slot. 7:15 AM is the one gap day 0
  // leaves between the 6:30 run and the 8 AM block.
  await syncedSeries(
    work,
    "Detached sprint",
    at(today, 0, 7, 15),
    at(today, 0, 7, 45),
    "America/New_York",
    "FREQ=WEEKLY",
    {
      moved: {
        end: at(today, 16, 15, 30),
        original: at(today, 14, 7, 15),
        start: at(today, 16, 15, 0),
      },
      state: "detached",
    }
  );

  // Connected five days ago, so its passed occurrences sit above the floor and
  // read as missed rather than as provider history: the head is overdue and its
  // tick opens the gap dialog. COUNT exhausts it on today's occurrence, which is
  // the only way to reach the terminal state.
  await syncedSeries(
    work,
    "Release countdown",
    at(today, -5, 8, 30),
    at(today, -5, 9, 0),
    "America/New_York",
    "FREQ=DAILY;COUNT=6",
    { syncedSince: formatDateOnly(addDays(today, -5)) }
  );

  // An all-day series: one bar per occurrence day rather than a span, and its
  // moved instance keys on a date-only original_date.
  await syncedSeries(
    work,
    "On-call rotation",
    formatDateOnly(today),
    formatDateOnly(today),
    undefined,
    "FREQ=WEEKLY",
    {
      moved: {
        end: formatDateOnly(addDays(today, 15)),
        original: formatDateOnly(addDays(today, 14)),
        start: formatDateOnly(addDays(today, 15)),
      },
      state: "detached",
    }
  );

  // BYMONTHDAY=-1 is inside the carrier's envelope, so the chip stays editable —
  // the other arm of "Swim class (term ends)".
  await syncedSeries(
    work,
    "Month-end close",
    at(endOfMonth(today), 0, 12, 30),
    at(endOfMonth(today), 0, 13, 0),
    "America/New_York",
    "FREQ=MONTHLY;BYMONTHDAY=-1",
    { state: "detached" }
  );
}
