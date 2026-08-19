// Mock calendar-sync seed conformance — the mock half of a table both seeders run.
// Why the table exists, and what each row is for: `seed_conformance_tests.rs`, beside
// the dev command, and the fixture's own `scope` header.
//
// This half plants the seed into a fresh MockStorageAdapter — the store test mode, the
// `VITE_SEED` harness and Playwright all run against — and reads it back through the
// adapter's public surface. Where the dev command writes a column, the mock keeps the
// same fact somewhere of its own: a one-off's zone lands on the page rather than on a
// page_schedules row, and a series' head is *derived* from the rule where the writer
// stamps it. The table names the outcome, so each side answers in its own basis.

import { formatDateOnly, getLocalTimezone, MockStorageAdapter } from "@pikos/core";
import type { Page } from "@pikos/core";
import { addDays, endOfMonth, format } from "date-fns";
import { describe, expect, it } from "vitest";

// The loader reads the Rust runners' own fixture directory over node:fs, so it stays
// off @pikos/core's public surface (nothing in a browser bundle can import it) and is
// reached by path from the tests that need it.
import {
  readConformanceTable,
  unhandledStep,
} from "../../../packages/core/src/adapters/conformanceTable";
import { seedSyncedCalendar } from "./syncedCalendar";

interface Step {
  op: "seed";
}

/** A wall-clock the runners resolve rather than the fixture spelling out — see the
 *  Rust `Instant`, which resolves the same three fields. */
interface Instant {
  day?: number;
  monthEnd?: boolean;
  time?: string;
}

interface Span {
  start: Instant;
  end: Instant | null;
}

interface PageExpect {
  title: string;
  calendar: string;
  start: Instant;
  end: Instant | null;
  zone: string | null;
  syncState: string;
  location?: string;
  attendees?: string[];
  pendingDescription?: string;
  bodyText?: string;
}

interface SeriesExpect {
  title: string;
  calendar: string;
  syncState: string;
  rrule: string;
  untilDay?: number;
  untilTime?: string;
  ruleZone: string;
  base: Span;
  head: Span;
  exdates?: Instant[];
  moved?: { original: Instant; start: Instant; end: Instant; zone: string | null };
  connectedDay?: number;
}

interface Scenario {
  name: string;
  steps: Step[];
  expect: {
    account?: { displayName: string; provider: string; authKind: string };
    calendars?: { name: string; color: string; enabled: boolean; externalFolder: boolean }[];
    counts?: {
      accounts: number;
      calendars: number;
      calendarFolders: number;
      syncedPages: number;
      series: number;
      overrides: number;
    };
    pageOrder?: { calendar: string; titles: string[] }[];
    pages?: PageExpect[];
    series?: SeriesExpect[];
  };
}

type Expect = Scenario["expect"];

/** The zone a detached row's rule carries — whatever machine the seed ran on. */
const DEVICE_ZONE = "$device";

const table = readConformanceTable<Scenario>("synced-seed", [
  "account",
  "calendars",
  "counts",
  "pageOrder",
  "pages",
  "series",
]);

function resolveDate(instant: Instant): Date {
  const today = new Date();
  return instant.monthEnd ? endOfMonth(today) : addDays(today, instant.day ?? 0);
}

/** `YYYY-MM-DD` for an all-day instant, `YYYY-MM-DDTHH:MM:SS` for a timed one — the
 *  shape is what tells the two apart everywhere in the app. */
function resolveInstant(instant: Instant): string {
  const day = formatDateOnly(resolveDate(instant));
  return instant.time ? `${day}T${instant.time}:00` : day;
}

function expectedZone(zone: string): string {
  return zone === DEVICE_ZONE ? getLocalTimezone() : zone;
}

/** The rule the fixture describes, with the provider `UNTIL` rebuilt where the shape
 *  is the point (a mid-day one is what locks the recurrence chip). */
function expectedRrule(series: SeriesExpect): string {
  if (series.untilDay === undefined || series.untilTime === undefined) return series.rrule;
  const until = format(addDays(new Date(), series.untilDay), "yyyyMMdd");
  return `${series.rrule};UNTIL=${until}T${series.untilTime}`;
}

/** The calendar folder whose name *contains* the fixture's name — the mock's canned
 *  discovery answers "Personal", the dev command names its folder "Personal (synced)". */
async function calendarFolder(adapter: MockStorageAdapter, name: string): Promise<string> {
  const folders = await adapter.listFolders();
  const folder = folders.find((f) => f.isExternalCalendar && f.name.includes(name));
  expect(folder, `no calendar folder named like ${name}`).toBeDefined();
  return folder!.id;
}

async function pageByTitle(adapter: MockStorageAdapter, title: string): Promise<Page> {
  const summaries = await adapter.listPages();
  const match = summaries.find((p) => p.title === title);
  expect(match, `the seed dropped ${title}`).toBeDefined();
  const page = await adapter.getPage(match!.id);
  return page!;
}

/** One assertion per expectation key. `Record<keyof Expect, …>` is the point: a key
 *  added to `Expect` does not compile until it has a checker here, and
 *  `readConformanceTable` rejects a fixture key that is in neither. */
const CHECKS: Record<keyof Expect, (want: Expect, adapter: MockStorageAdapter) => Promise<void>> = {
  account: async (want, adapter) => {
    if (!want.account) return;
    const accounts = await adapter.getSyncStatus();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.displayName).toBe(want.account.displayName);
    expect(accounts[0]!.provider).toBe(want.account.provider);
    expect(accounts[0]!.authKind).toBe(want.account.authKind);
  },

  calendars: async (want, adapter) => {
    if (!want.calendars) return;
    const accounts = await adapter.getSyncStatus();
    const rows = await adapter.listSyncCalendars(accounts[0]!.id);
    const folders = await adapter.listFolders();
    for (const cal of want.calendars) {
      const row = rows.find((c) => c.displayName.includes(cal.name));
      expect(row, `no calendar named like ${cal.name}`).toBeDefined();
      expect(row!.color, `${cal.name} colour`).toBe(cal.color);
      expect(row!.enabled, `${cal.name} enabled`).toBe(cal.enabled);
      const folder = folders.find((f) => f.id === row!.folderId);
      expect(folder, `${cal.name} folder`).toBeDefined();
      expect(folder!.color, `${cal.name} folder colour`).toBe(cal.color);
      expect(folder!.name.includes(cal.name), `${cal.name} folder name`).toBe(true);
      expect(folder!.isExternalCalendar, `${cal.name} is a calendar folder`).toBe(
        cal.externalFolder
      );
    }
  },

  counts: async (want, adapter) => {
    if (!want.counts) return;
    const accounts = await adapter.getSyncStatus();
    expect(accounts, "accounts").toHaveLength(want.counts.accounts);
    expect(await adapter.listSyncCalendars(accounts[0]!.id), "calendars").toHaveLength(
      want.counts.calendars
    );
    const folders = await adapter.listFolders();
    expect(
      folders.filter((f) => f.isExternalCalendar),
      "calendar folders"
    ).toHaveLength(want.counts.calendarFolders);
    const summaries = await adapter.listPages();
    const pages = await Promise.all(summaries.map((p) => adapter.getPage(p.id)));
    expect(
      pages.filter((p) => p?.syncState != null),
      "synced pages"
    ).toHaveLength(want.counts.syncedPages);
    const rules = await adapter.listRecurrenceRules();
    expect(rules, "series").toHaveLength(want.counts.series);
    const overrides = await adapter.listPageSchedulesForRules(rules.map((r) => r.id));
    expect(
      overrides.filter((s) => s.originalDate != null),
      "provider-moved instances"
    ).toHaveLength(want.counts.overrides);
  },

  pageOrder: async (want, adapter) => {
    if (!want.pageOrder) return;
    // listPages already sorts by sortOrder — the dev command numbers per folder from
    // zero, the mock counts globally, and only the order within a calendar is shared.
    const pages = await adapter.listPages();
    for (const calendar of want.pageOrder) {
      const folderId = await calendarFolder(adapter, calendar.calendar);
      const titles = pages.filter((p) => p.folderId === folderId).map((p) => p.title);
      expect(titles, `${calendar.calendar} contents, in order`).toEqual(calendar.titles);
    }
  },

  pages: async (want, adapter) => {
    if (!want.pages) return;
    for (const expected of want.pages) {
      const page = await pageByTitle(adapter, expected.title);
      const at = expected.title;
      expect(page.folderId, `${at} is filed in ${expected.calendar}`).toBe(
        await calendarFolder(adapter, expected.calendar)
      );
      expect(page.scheduledStart, `${at} start`).toBe(resolveInstant(expected.start));
      expect(page.scheduledEnd ?? null, `${at} end`).toBe(
        expected.end ? resolveInstant(expected.end) : null
      );
      // The mock keeps the stored zone on the page; the writer keeps it on the
      // page_schedules row the page denormalizes.
      expect(page.timezone ?? null, `${at} stored zone`).toBe(expected.zone);
      expect(page.syncState, `${at} sync state`).toBe(expected.syncState);
      expect(page.mirrorLocation ?? null, `${at} mirror location`).toBe(expected.location ?? null);
      expect(page.mirrorAttendees ?? [], `${at} mirror attendees`).toEqual(
        expected.attendees ?? []
      );
      expect(page.pendingDescription ?? null, `${at} withheld description`).toBe(
        expected.pendingDescription ?? null
      );
      expect(page.contentText ?? "", `${at} indexed body text`).toBe(expected.bodyText ?? "");
    }
  },

  series: async (want, adapter) => {
    if (!want.series) return;
    for (const expected of want.series) {
      const page = await pageByTitle(adapter, expected.title);
      const at = expected.title;
      const rule = await adapter.getRecurrenceRule(page.id);
      expect(rule, `the seed dropped the ${at} series`).not.toBeNull();

      expect(page.folderId, `${at} is filed in ${expected.calendar}`).toBe(
        await calendarFolder(adapter, expected.calendar)
      );
      expect(page.syncState, `${at} sync state`).toBe(expected.syncState);
      expect(rule!.rrule, `${at} rule`).toBe(expectedRrule(expected));
      expect(rule!.timezone, `${at} rule zone`).toBe(expectedZone(expected.ruleZone));
      expect(rule!.scheduledStart, `${at} base start`).toBe(resolveInstant(expected.base.start));
      expect(rule!.scheduledEnd ?? null, `${at} base end`).toBe(
        expected.base.end ? resolveInstant(expected.base.end) : null
      );
      // Derived here, stamped by the writer: the head is where the series reads as
      // due, and a floor or an exclusion the mock applies differently shows up here.
      expect(page.scheduledStart, `${at} head start`).toBe(resolveInstant(expected.head.start));
      expect(page.scheduledEnd ?? null, `${at} head end`).toBe(
        expected.head.end ? resolveInstant(expected.head.end) : null
      );
      expect(rule!.rruleExdates, `${at} cancelled occurrences`).toEqual(
        (expected.exdates ?? []).map(resolveInstant)
      );

      const overrides = (await adapter.listPageSchedules(page.id)).filter(
        (s) => s.originalDate != null
      );
      if (!expected.moved) {
        expect(overrides, `${at} has no moved instance`).toHaveLength(0);
      } else {
        expect(overrides, `${at} moved instances`).toHaveLength(1);
        expect(overrides[0]!.scheduledStart, `${at} moved to`).toBe(
          resolveInstant(expected.moved.start)
        );
        expect(overrides[0]!.scheduledEnd, `${at} moved end`).toBe(
          resolveInstant(expected.moved.end)
        );
        expect(overrides[0]!.originalDate, `${at} moved occurrence key`).toBe(
          resolveInstant(expected.moved.original)
        );
        expect(overrides[0]!.timezone ?? null, `${at} moved row zone`).toBe(expected.moved.zone);
      }

      expect(page.syncedSince, `${at} connect day`).toBe(
        formatDateOnly(addDays(new Date(), expected.connectedDay ?? 0))
      );
    }
  },
};

async function apply(adapter: MockStorageAdapter, step: Step): Promise<void> {
  switch (step.op) {
    case "seed":
      await seedSyncedCalendar(adapter);
      return;

    default:
      return unhandledStep("synced-seed", step.op);
  }
}

describe("synced calendar seed conformance", () => {
  it("the table has scenarios", () => {
    expect(table.scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of table.scenarios) {
    it(scenario.name, async () => {
      const adapter = new MockStorageAdapter();
      adapter.clear();
      for (const step of scenario.steps) await apply(adapter, step);

      for (const check of Object.values(CHECKS)) await check(scenario.expect, adapter);
    });
  }
});
