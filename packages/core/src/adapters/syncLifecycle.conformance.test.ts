// Sync-lifecycle conformance — the mock half of a table the Rust writers also run.
// Why the table exists, and what a step means: `sync_conformance_tests.rs`, beside
// the fixture.
//
// Realizing a step here is constrained by the mock having no reconciler, so there
// is no "sync resumes" call to make: everything a backfill would converge to has to
// fall out of the adapter methods the app actually calls.

import { beforeEach, describe, expect, it } from "vitest";

import { readConformanceTable, unhandledStep } from "./conformanceTable";
import { MockStorageAdapter } from "./MockStorageAdapter";

interface Step {
  op:
    | "connect"
    | "enable"
    | "syncEvent"
    | "own"
    | "complete"
    | "disable"
    | "disconnect"
    | "nativePage"
    | "movePage"
    | "createPageIn"
    | "nativeFolder"
    | "folderEdit";
  displayName?: string;
  calendars?: string[];
  calendar?: string;
  uid?: string;
  title?: string;
  page?: string;
  folder?: string;
  parent?: string;
  change?: "delete" | "softDelete" | "moveToRoot" | "nestUnder" | "rename";
  target?: "calendarFolder" | "inbox";
  rejectedWith?: string;
}

interface CalExpect {
  name: string;
  enabled: boolean;
  hasFolder: boolean;
  detachedPages: number;
}

interface PageExpect {
  uid: string;
  exists: boolean;
  syncState?: string;
  scheduleLocked?: boolean;
  inCalendarFolder?: boolean;
}

interface Scenario {
  name: string;
  steps: Step[];
  expect: {
    accountVisible?: boolean;
    accountCount?: number;
    folderCount?: number;
    calendars?: CalExpect[];
    folder?: { calendar: string; exists: boolean; isExternalCalendar?: boolean };
    pages?: PageExpect[];
  };
}

const EXPECT_KEYS = [
  "accountVisible",
  "accountCount",
  "folderCount",
  "calendars",
  "folder",
  "pages",
] as const;

const table = readConformanceTable<Scenario>("sync", EXPECT_KEYS);

/** Ids the steps produce and the expectations refer to by name. `folders` outlives
 *  the calendar's own link on purpose — teardown clears it, and a scenario still
 *  needs to ask whether that folder survived and how it is flagged. */
interface World {
  accountId: string;
  calendars: Map<string, string>;
  folders: Map<string, string>;
  pages: Map<string, string>;
}

async function apply(adapter: MockStorageAdapter, world: World, step: Step): Promise<void> {
  switch (step.op) {
    case "connect": {
      const account = await adapter.connectCaldavAccount({
        baseUrl: "https://caldav.example.com",
        displayName: step.displayName!,
        password: "app-password",
        username: "you",
      });
      world.accountId = account.id;
      for (const cal of account.calendars) world.calendars.set(cal.displayName, cal.id);
      return;
    }

    case "enable": {
      const cal = await adapter.toggleSyncCalendar(
        world.calendars.get(step.calendar!)!,
        true,
        null
      );
      if (cal.folderId) world.folders.set(step.calendar!, cal.folderId);
      return;
    }

    case "disable": {
      await adapter.toggleSyncCalendar(world.calendars.get(step.calendar!)!, false, null);
      return;
    }

    case "syncEvent": {
      const folderId = world.folders.get(step.calendar!)!;
      // Re-delivering an event the store already holds is an unchanged-etag no-op.
      // Reactivating here instead would hand the mock a re-link the adapter itself
      // never performs, and the table would pass against a mock that cannot.
      if (world.pages.has(step.uid!)) return;
      const page = await adapter.seedMirrorPage({
        content: "",
        contentText: "",
        folderId,
        priority: 0,
        status: "not_started",
        tags: [],
        title: step.title!,
      });
      adapter.markPageSynced(page.id, { state: "active" });
      world.pages.set(step.uid!, page.id);
      return;
    }

    case "own": {
      await adapter.updatePage(world.pages.get(step.uid!)!, { contentText: "edited" });
      return;
    }

    case "complete": {
      await adapter.setPagesStatus([world.pages.get(step.uid!)!], "done", new Date().toISOString());
      return;
    }

    case "disconnect": {
      await adapter.disconnectSyncAccount(world.accountId);
      return;
    }

    case "nativePage": {
      const page = await adapter.createPage({
        content: "",
        contentText: "",
        folderId: null,
        priority: 0,
        status: "not_started",
        tags: [],
        title: step.title!,
      });
      world.pages.set(step.uid!, page.id);
      return;
    }

    case "movePage": {
      const folderId = step.target === "calendarFolder" ? [...world.folders.values()][0]! : null;
      await verdict(adapter.updatePage(world.pages.get(step.page!)!, { folderId }), step);
      return;
    }

    case "createPageIn": {
      const folderId = step.target === "calendarFolder" ? [...world.folders.values()][0]! : null;
      const created = adapter.createPage({
        content: "",
        contentText: "",
        folderId,
        priority: 0,
        status: "not_started",
        tags: [],
        title: step.title!,
      });
      const page = await verdict(created, step);
      if (page) world.pages.set(step.uid!, page.id);
      return;
    }

    case "nativeFolder": {
      const folder = await adapter.createFolder({ name: step.folder!, parentId: null });
      world.folders.set(step.folder!, folder.id);
      return;
    }

    case "folderEdit": {
      const id = world.folders.get(step.folder!)!;
      const edit = (): Promise<unknown> => {
        switch (step.change!) {
          case "delete":
            return adapter.deleteFolder(id);
          case "softDelete":
            return adapter.softDeleteFolder(id);
          case "moveToRoot":
            return adapter.updateFolder(id, { parentId: null });
          case "nestUnder":
            return adapter.updateFolder(id, { parentId: world.folders.get(step.parent!)! });
          case "rename":
            return adapter.updateFolder(id, { name: "Renamed" });
        }
      };
      await verdict(edit(), step);
      return;
    }

    default:
      return unhandledStep("sync", step.op);
  }
}

/** `rejectedWith` present means the mock must refuse with that exact message,
 *  absent means it must allow the write and hand back its result. */
async function verdict<T>(work: Promise<T>, step: Step): Promise<T | undefined> {
  if (step.rejectedWith) {
    await expect(work).rejects.toThrow(step.rejectedWith);
    return undefined;
  }
  return await work;
}

describe("sync lifecycle conformance", () => {
  let adapter: MockStorageAdapter;

  beforeEach(() => {
    adapter = new MockStorageAdapter();
    adapter.clear();
  });

  it("the table has scenarios", () => {
    expect(table.scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of table.scenarios) {
    it(scenario.name, async () => {
      const world: World = {
        accountId: "",
        calendars: new Map(),
        folders: new Map(),
        pages: new Map(),
      };
      for (const step of scenario.steps) await apply(adapter, world, step);

      const { expect: want } = scenario;
      const status = await adapter.getSyncStatus();

      if (want.accountVisible !== undefined) {
        expect(status.some((a) => a.id === world.accountId)).toBe(want.accountVisible);
      }

      if (want.accountCount !== undefined) {
        expect(status).toHaveLength(want.accountCount);
      }

      if (want.folderCount !== undefined) {
        expect(await adapter.listFolders()).toHaveLength(want.folderCount);
      }

      if (want.calendars) {
        const rows = await adapter.listSyncCalendars(world.accountId);
        for (const wantCal of want.calendars) {
          const row = rows.find((c) => c.displayName === wantCal.name);
          expect(row, `no calendar named ${wantCal.name}`).toBeDefined();
          expect(row!.enabled).toBe(wantCal.enabled);
          expect(row!.folderId != null).toBe(wantCal.hasFolder);
          expect(row!.detachedPages).toBe(wantCal.detachedPages);
        }
      }

      if (want.folder) {
        const folderId = world.folders.get(want.folder.calendar)!;
        const folder = (await adapter.listFolders()).find((f) => f.id === folderId);
        expect(folder !== undefined).toBe(want.folder.exists);
        if (want.folder.isExternalCalendar !== undefined && folder) {
          expect(folder.isExternalCalendar ?? false).toBe(want.folder.isExternalCalendar);
        }
      }

      for (const wantPage of want.pages ?? []) {
        const page = await adapter.getPage(world.pages.get(wantPage.uid)!);
        expect(page !== null, `${wantPage.uid} exists`).toBe(wantPage.exists);
        if (!page) continue;

        if (wantPage.syncState !== undefined) {
          expect(page.syncState).toBe(wantPage.syncState);
        }
        if (wantPage.scheduleLocked !== undefined) {
          expect(page.scheduleLocked ?? false).toBe(wantPage.scheduleLocked);
        }
        if (wantPage.inCalendarFolder !== undefined) {
          const inCalendarFolder = [...world.folders.values()].includes(page.folderId ?? "");
          expect(inCalendarFolder).toBe(wantPage.inCalendarFolder);
        }
      }
    });
  }
});
