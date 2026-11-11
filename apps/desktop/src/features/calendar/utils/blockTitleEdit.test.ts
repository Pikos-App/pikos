import type { Folder, PageSummary } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { blockTitleEdit } from "./blockTitleEdit";

function makeFolder(id: string, name: string, isExternalCalendar = false): Folder {
  return {
    createdAt: "2026-01-01T00:00:00",
    id,
    isExternalCalendar,
    name,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
  };
}

const page: PageSummary = {
  createdAt: "2026-01-01T00:00:00",
  detachIsReversible: false,
  folderId: null,
  id: "p1",
  isRecurring: false,
  priority: 0,
  scheduledEnd: "2026-10-19T09:30:00",
  scheduledStart: "2026-10-19T09:00:00",
  scheduleLocked: false,
  sortOrder: 0,
  status: "not_started",
  tags: ["meetings"],
  title: "",
  updatedAt: "2026-01-01T00:00:00",
};

const folders = [makeFolder("f-work", "Work"), makeFolder("f-cal", "Calendar", true)];

describe("blockTitleEdit", () => {
  it("adds the typed tags to the page's own", () => {
    expect(blockTitleEdit("standup #work", "", page, folders).patch).toEqual({
      tags: ["meetings", "work"],
      title: "standup",
    });
  });

  it("sets the priority a token names, and clears it on !0", () => {
    expect(blockTitleEdit("standup !high", "", page, folders).patch.priority).toBe(2);
    expect(blockTitleEdit("standup !0", "", page, folders).patch.priority).toBe(0);
  });

  it("files into the folder a token names, never into a synced calendar", () => {
    expect(blockTitleEdit("standup ~work", "", page, folders).patch.folderId).toBe("f-work");
    expect(blockTitleEdit("standup ~inbox", "", page, folders).patch.folderId).toBeNull();
    expect(blockTitleEdit("standup ~calendar", "", page, folders).patch).not.toHaveProperty(
      "folderId"
    );
  });

  it("returns the repeat to anchor on the block's slot", () => {
    expect(blockTitleEdit("standup every weekday", "", page, folders)).toEqual({
      patch: { title: "standup" },
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    });
  });

  it("leaves a date in the title, since the slot already set one", () => {
    expect(blockTitleEdit("prep for tomorrow", "", page, folders)).toEqual({
      patch: { title: "prep for tomorrow" },
      rrule: null,
    });
  });

  it("keeps the opening title when every typed word was a token", () => {
    expect(blockTitleEdit("#work", "Standup", page, folders).patch.title).toBe("Standup");
  });
});
