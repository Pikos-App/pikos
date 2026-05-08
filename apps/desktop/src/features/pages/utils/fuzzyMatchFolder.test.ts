// fuzzyMatchFolder — bridges parser output (folderQuery: string) to the
// schema-level Folder by name. Three-tier precedence: exact (case-insens) →
// prefix → substring. These tests are part of the NL → schema mapping
// contract for QuickAddDialog.

import type { Folder } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { fuzzyMatchFolder } from "./fuzzyMatchFolder";

function makeFolder(name: string, id: string = name.toLowerCase()): Folder {
  return {
    createdAt: "2026-01-01T00:00:00",
    id,
    name,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
  };
}

describe("fuzzyMatchFolder — empty / null inputs", () => {
  it("empty query returns null", () => {
    expect(fuzzyMatchFolder("", [makeFolder("Work")])).toBeNull();
  });

  it("empty folder list returns null", () => {
    expect(fuzzyMatchFolder("work", [])).toBeNull();
  });

  it("query that doesn't match anything returns null", () => {
    expect(fuzzyMatchFolder("nope", [makeFolder("Work"), makeFolder("Home")])).toBeNull();
  });
});

describe("fuzzyMatchFolder — exact match (highest precedence)", () => {
  it("exact match wins over prefix and substring", () => {
    const folders = [
      makeFolder("Work-Stuff"), // would match "work" as prefix
      makeFolder("Work"), // exact match — should win
      makeFolder("Networking"), // would match "work" as substring
    ];
    expect(fuzzyMatchFolder("work", folders)?.name).toBe("Work");
  });

  it("exact match is case-insensitive", () => {
    const folders = [makeFolder("Work")];
    expect(fuzzyMatchFolder("WORK", folders)?.name).toBe("Work");
    expect(fuzzyMatchFolder("WoRk", folders)?.name).toBe("Work");
  });
});

describe("fuzzyMatchFolder — prefix match (second precedence)", () => {
  it("prefix wins over substring", () => {
    const folders = [
      makeFolder("Networking"), // substring match for "work"
      makeFolder("Workshop"), // prefix match for "work"
    ];
    expect(fuzzyMatchFolder("work", folders)?.name).toBe("Workshop");
  });

  it("prefix is case-insensitive", () => {
    const folders = [makeFolder("PROJECTS")];
    expect(fuzzyMatchFolder("proj", folders)?.name).toBe("PROJECTS");
  });

  it("first prefix match in array order wins when multiple folders match", () => {
    const folders = [makeFolder("Workshop"), makeFolder("Working")];
    expect(fuzzyMatchFolder("work", folders)?.name).toBe("Workshop");
  });
});

describe("fuzzyMatchFolder — substring match (lowest precedence)", () => {
  it("substring matches when no exact or prefix match", () => {
    const folders = [makeFolder("Networking"), makeFolder("Home")];
    expect(fuzzyMatchFolder("work", folders)?.name).toBe("Networking");
  });

  it("substring is case-insensitive", () => {
    const folders = [makeFolder("MyArchive")];
    expect(fuzzyMatchFolder("archive", folders)?.name).toBe("MyArchive");
  });
});

describe("fuzzyMatchFolder — typical NL → schema flows", () => {
  it("'Engineering' query maps to the Engineering folder", () => {
    const folders = [
      makeFolder("Personal", "f1"),
      makeFolder("Engineering", "f2"),
      makeFolder("Engineering Notes", "f3"),
    ];
    const match = fuzzyMatchFolder("Engineering", folders);
    expect(match?.id).toBe("f2");
  });

  it("'eng' partial maps to first prefix-matching folder", () => {
    const folders = [makeFolder("Personal", "f1"), makeFolder("Engineering", "f2")];
    expect(fuzzyMatchFolder("eng", folders)?.id).toBe("f2");
  });

  it("a folder named 'inbox' is matched if it exists (caller often special-cases inbox before calling)", () => {
    // Behavior contract: fuzzyMatchFolder doesn't treat "inbox" specially.
    // QuickAddDialog handles the inbox shortcut by checking the query string
    // before falling back to the match result. Verify that if a real folder
    // is named "Inbox", it matches normally.
    const folders = [makeFolder("Inbox", "inbox-folder-id")];
    expect(fuzzyMatchFolder("inbox", folders)?.id).toBe("inbox-folder-id");
  });
});
