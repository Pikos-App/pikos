import { describe, expect, it } from "vitest";

import type { Folder } from "../types";
import { folderIdForNewPage, folderIdForRestoredPage, writableFolders } from "./writableFolders";

function makeFolder(name: string, isExternalCalendar = false): Folder {
  return {
    createdAt: "2026-01-01T00:00:00",
    id: name.toLowerCase(),
    isExternalCalendar,
    name,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
  };
}

const FOLDERS = [
  makeFolder("Work"),
  makeFolder("Fastmail", true),
  makeFolder("Home"),
  makeFolder("iCloud", true),
];

describe("writableFolders", () => {
  it("excludes external-calendar folders, keeping the rest in order", () => {
    expect(writableFolders(FOLDERS).map((f) => f.name)).toEqual(["Work", "Home"]);
  });

  it("returns empty when every folder is external", () => {
    expect(writableFolders([makeFolder("Fastmail", true)])).toEqual([]);
  });
});

describe("folderIdForNewPage", () => {
  it("uses the active folder when a page may be placed there", () => {
    expect(folderIdForNewPage("work", FOLDERS, "home")).toBe("work");
  });

  it("falls back to the default when the active view is a synced calendar", () => {
    expect(folderIdForNewPage("fastmail", FOLDERS, "home")).toBe("home");
  });

  it("falls back to the default when the active view is a smart view", () => {
    expect(folderIdForNewPage("today", FOLDERS, "home")).toBe("home");
  });

  it("falls back to Inbox when the default is itself a synced calendar", () => {
    expect(folderIdForNewPage("fastmail", FOLDERS, "icloud")).toBeNull();
  });

  it("falls back to Inbox when the default names a folder that is gone", () => {
    expect(folderIdForNewPage("today", FOLDERS, "deleted")).toBeNull();
  });

  it("returns Inbox when there is no default", () => {
    expect(folderIdForNewPage("today", FOLDERS, null)).toBeNull();
  });
});

describe("folderIdForRestoredPage", () => {
  it("leaves a page where it was when its folder is still there", () => {
    expect(folderIdForRestoredPage("work", FOLDERS, "home")).toBe("work");
  });

  // The folder went to the trash with the page, or was emptied from it while the
  // page waited. Either way the remembered id names nothing.
  it("falls to the default when the remembered folder is gone", () => {
    expect(folderIdForRestoredPage("deleted", FOLDERS, "home")).toBe("home");
  });

  it("falls to Inbox when the default is gone too", () => {
    expect(folderIdForRestoredPage("deleted", FOLDERS, "also-gone")).toBeNull();
  });

  it("falls to Inbox when there is no default", () => {
    expect(folderIdForRestoredPage("deleted", FOLDERS, null)).toBeNull();
  });

  it("leaves a page already in Inbox in Inbox", () => {
    expect(folderIdForRestoredPage(null, FOLDERS, "home")).toBeNull();
  });

  // A synced page's calendar folder is deliberately unwritable. Judging the keep
  // test by writability would evict every mirror from the calendar it belongs to.
  it("keeps a synced page in its calendar folder", () => {
    expect(folderIdForRestoredPage("fastmail", FOLDERS, "home")).toBe("fastmail");
  });

  it("never parks a page in a calendar folder when its own is gone", () => {
    expect(folderIdForRestoredPage("deleted", FOLDERS, "fastmail")).toBeNull();
  });
});
