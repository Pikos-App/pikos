import { describe, expect, it } from "vitest";

import type { Folder } from "../types";
import { buildSearchFilter, parseSearchQuery } from "./searchQuery";

// Fixed reference so `due:today` and friends resolve deterministically.
const REF = new Date(2026, 2, 16); // 2026-03-16, a Monday

function folder(id: string, name: string): Folder {
  return {
    createdAt: "2026-01-01T00:00:00",
    id,
    isExternalCalendar: false,
    name,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
  };
}

const FOLDERS = [folder("f-work", "Work"), folder("f-personal", "Personal")];

describe("parseSearchQuery — no operators", () => {
  it("leaves a plain query untouched", () => {
    const parsed = parseSearchQuery("quarterly report", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("quarterly report");
    expect(parsed.tags).toEqual([]);
  });

  it("reports no operators for an empty query", () => {
    const parsed = parseSearchQuery("", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("");
  });

  it("leaves an unknown operator in the text", () => {
    const parsed = parseSearchQuery("ratio:1.5 mix", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("ratio:1.5 mix");
  });

  it("leaves a known key that is part of a longer token in the text", () => {
    const parsed = parseSearchQuery("vintage:2019", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("vintage:2019");
  });

  it("leaves an operator with no value in the text", () => {
    const parsed = parseSearchQuery("tag: alone", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("tag: alone");
  });
});

describe("parseSearchQuery — tag", () => {
  it("lifts a tag out and keeps the residual text", () => {
    const parsed = parseSearchQuery("tag:work report", REF);
    expect(parsed.hasOperators).toBe(true);
    expect(parsed.tags).toEqual(["work"]);
    expect(parsed.text).toBe("report");
  });

  it("accumulates repeated tags", () => {
    const parsed = parseSearchQuery("tag:work tag:urgent", REF);
    expect(parsed.tags).toEqual(["work", "urgent"]);
    expect(parsed.text).toBe("");
  });

  it("accepts a quoted tag with spaces", () => {
    const parsed = parseSearchQuery('tag:"deep work" notes', REF);
    expect(parsed.tags).toEqual(["deep work"]);
    expect(parsed.text).toBe("notes");
  });

  it("keeps words either side of a stripped operator apart", () => {
    const parsed = parseSearchQuery("draft tag:work report", REF);
    expect(parsed.text).toBe("draft report");
  });
});

describe("parseSearchQuery — folder", () => {
  it("lifts a folder name", () => {
    const parsed = parseSearchQuery("folder:work notes", REF);
    expect(parsed.folder).toBe("work");
    expect(parsed.text).toBe("notes");
  });

  it("keeps the last folder when repeated", () => {
    const parsed = parseSearchQuery("folder:work folder:personal", REF);
    expect(parsed.folder).toBe("personal");
  });

  it("accepts a quoted folder name", () => {
    const parsed = parseSearchQuery('folder:"Side Projects"', REF);
    expect(parsed.folder).toBe("Side Projects");
  });
});

describe("parseSearchQuery — is", () => {
  it("maps is:done to the done status", () => {
    expect(parseSearchQuery("is:done", REF).status).toBe("done");
  });

  it("maps is:open to not_started", () => {
    expect(parseSearchQuery("is:open", REF).status).toBe("not_started");
  });

  it("maps is:scheduled to the schedule flag", () => {
    const parsed = parseSearchQuery("is:scheduled", REF);
    expect(parsed.scheduled).toBe(true);
    expect(parsed.status).toBeNull();
  });

  it("leaves an unknown is: value in the text", () => {
    const parsed = parseSearchQuery("is:pending", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("is:pending");
  });

  it("combines is:open with is:scheduled", () => {
    const parsed = parseSearchQuery("is:open is:scheduled", REF);
    expect(parsed.status).toBe("not_started");
    expect(parsed.scheduled).toBe(true);
  });
});

describe("parseSearchQuery — priority", () => {
  it.each([
    ["urgent", 1],
    ["high", 2],
    ["medium", 3],
    ["low", 4],
    ["none", 0],
  ])("maps priority:%s to %i", (word, expected) => {
    expect(parseSearchQuery(`priority:${word}`, REF).priority).toBe(expected);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["0", 0],
  ])("maps the numeric priority:%s to %i", (digit, expected) => {
    expect(parseSearchQuery(`priority:${digit}`, REF).priority).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(parseSearchQuery("priority:URGENT", REF).priority).toBe(1);
  });

  it("leaves an out-of-range priority in the text", () => {
    const parsed = parseSearchQuery("priority:9", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("priority:9");
  });
});

describe("parseSearchQuery — due", () => {
  it("resolves an explicit date to a single inclusive day", () => {
    const parsed = parseSearchQuery("due:2026-04-01", REF);
    expect(parsed.dueFrom).toBe("2026-04-01");
    expect(parsed.dueTo).toBe("2026-04-01T23:59:59");
  });

  it("resolves due:today against the reference date", () => {
    const parsed = parseSearchQuery("due:today", REF);
    expect(parsed.dueFrom).toBe("2026-03-16");
    expect(parsed.dueTo).toBe("2026-03-16T23:59:59");
  });

  it("resolves due:tomorrow and due:yesterday", () => {
    expect(parseSearchQuery("due:tomorrow", REF).dueFrom).toBe("2026-03-17");
    expect(parseSearchQuery("due:yesterday", REF).dueFrom).toBe("2026-03-15");
  });

  it("resolves due:week to today plus six days", () => {
    const parsed = parseSearchQuery("due:week", REF);
    expect(parsed.dueFrom).toBe("2026-03-16");
    expect(parsed.dueTo).toBe("2026-03-22T23:59:59");
  });

  it("resolves due:month to a 30-day window", () => {
    const parsed = parseSearchQuery("due:month", REF);
    expect(parsed.dueFrom).toBe("2026-03-16");
    expect(parsed.dueTo).toBe("2026-04-14T23:59:59");
  });

  it("resolves a date range across both endpoints", () => {
    const parsed = parseSearchQuery("due:2026-03-10..2026-03-12", REF);
    expect(parsed.dueFrom).toBe("2026-03-10");
    expect(parsed.dueTo).toBe("2026-03-12T23:59:59");
  });

  it("mixes keywords and dates in a range", () => {
    const parsed = parseSearchQuery("due:today..2026-03-31", REF);
    expect(parsed.dueFrom).toBe("2026-03-16");
    expect(parsed.dueTo).toBe("2026-03-31T23:59:59");
  });

  it("takes the end of a multi-day keyword as the range end", () => {
    const parsed = parseSearchQuery("due:yesterday..week", REF);
    expect(parsed.dueFrom).toBe("2026-03-15");
    expect(parsed.dueTo).toBe("2026-03-22T23:59:59");
  });

  it("supports an open-ended upper bound", () => {
    const parsed = parseSearchQuery("due:2026-03-10..", REF);
    expect(parsed.dueFrom).toBe("2026-03-10");
    expect(parsed.dueTo).toBeNull();
    expect(parsed.hasOperators).toBe(true);
  });

  it("supports an open-ended lower bound", () => {
    const parsed = parseSearchQuery("due:..2026-03-10", REF);
    expect(parsed.dueFrom).toBeNull();
    expect(parsed.dueTo).toBe("2026-03-10T23:59:59");
  });

  it("leaves a bare '..' in the text", () => {
    const parsed = parseSearchQuery("due:..", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("due:..");
  });

  it("leaves an unparseable date in the text", () => {
    const parsed = parseSearchQuery("due:soon", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("due:soon");
  });

  it("leaves a calendar-impossible date in the text", () => {
    const parsed = parseSearchQuery("due:2026-02-31", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("due:2026-02-31");
  });

  it("leaves a half-broken range in the text", () => {
    const parsed = parseSearchQuery("due:2026-03-10..soon", REF);
    expect(parsed.hasOperators).toBe(false);
    expect(parsed.text).toBe("due:2026-03-10..soon");
  });

  it("keeps the last due when repeated", () => {
    const parsed = parseSearchQuery("due:today due:2026-05-05", REF);
    expect(parsed.dueFrom).toBe("2026-05-05");
  });
});

describe("parseSearchQuery — mixed", () => {
  it("lifts every operator out of a crowded query", () => {
    const parsed = parseSearchQuery(
      "tag:work folder:personal is:done priority:high due:week quarterly review",
      REF
    );
    expect(parsed.tags).toEqual(["work"]);
    expect(parsed.folder).toBe("personal");
    expect(parsed.status).toBe("done");
    expect(parsed.priority).toBe(2);
    expect(parsed.dueFrom).toBe("2026-03-16");
    expect(parsed.text).toBe("quarterly review");
  });

  it("recognises operators wherever they appear in the query", () => {
    const parsed = parseSearchQuery("quarterly tag:work review is:open", REF);
    expect(parsed.tags).toEqual(["work"]);
    expect(parsed.status).toBe("not_started");
    expect(parsed.text).toBe("quarterly review");
  });
});

describe("buildSearchFilter", () => {
  it("returns an empty filter for a query with no operators", () => {
    const { filter, unresolvedFolder } = buildSearchFilter(
      parseSearchQuery("plain text", REF),
      FOLDERS
    );
    expect(filter).toEqual({});
    expect(unresolvedFolder).toBeNull();
  });

  it("maps tags, status and priority", () => {
    const { filter } = buildSearchFilter(
      parseSearchQuery("tag:work tag:urgent is:done priority:low", REF),
      FOLDERS
    );
    expect(filter.tags).toEqual(["work", "urgent"]);
    expect(filter.status).toBe("done");
    expect(filter.priority).toBe(4);
  });

  it("resolves a folder name fuzzily", () => {
    const { filter, unresolvedFolder } = buildSearchFilter(
      parseSearchQuery("folder:wor", REF),
      FOLDERS
    );
    expect(filter.folderId).toBe("f-work");
    expect(unresolvedFolder).toBeNull();
  });

  it("maps folder:inbox to the no-folder pages", () => {
    const { filter } = buildSearchFilter(parseSearchQuery("folder:inbox", REF), FOLDERS);
    expect(filter.folderId).toBeNull();
    expect("folderId" in filter).toBe(true);
  });

  it("reports a folder name nothing matches", () => {
    const { filter, unresolvedFolder } = buildSearchFilter(
      parseSearchQuery("folder:nowhere", REF),
      FOLDERS
    );
    expect(unresolvedFolder).toBe("nowhere");
    expect(filter.folderId).toBeUndefined();
  });

  it("asks for a schedule alongside a due range", () => {
    const { filter } = buildSearchFilter(
      parseSearchQuery("due:2026-03-10..2026-03-12", REF),
      FOLDERS
    );
    expect(filter.scheduledAfter).toBe("2026-03-10");
    expect(filter.scheduledBefore).toBe("2026-03-12T23:59:59");
    expect(filter.hasSchedule).toBe(true);
  });

  it("asks for a schedule for is:scheduled alone", () => {
    const { filter } = buildSearchFilter(parseSearchQuery("is:scheduled", REF), FOLDERS);
    expect(filter.hasSchedule).toBe(true);
    expect(filter.scheduledAfter).toBeUndefined();
  });

  it("never maps residual text onto the filter's LIKE query", () => {
    const { filter } = buildSearchFilter(parseSearchQuery("tag:work report", REF), FOLDERS);
    expect(filter.query).toBeUndefined();
  });
});
