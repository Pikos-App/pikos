// Quick Add folder resolution, run against the table `fuzzy_match_folder` also runs.
// The parser hands both binaries the same `folderQuery` out of the same workspace,
// so a tier that exists on one side only files the string differently depending on
// which one the user typed it into.

import { describe, expect, it } from "vitest";

import { readFixture } from "../adapters/conformanceTable";
import type { Folder } from "../types";
import { fuzzyMatchFolder } from "./fuzzyMatchFolder";

interface Case {
  name: string;
  query: string;
  folders: string[];
  match: string | null;
}

const KEYS = ["name", "query", "folders", "match"];

const { cases } = readFixture<{ cases: Case[] }>("folder-matching.json");

function folder(name: string): Folder {
  return {
    color: null,
    createdAt: "2026-01-01T00:00:00",
    icon: null,
    id: name,
    isExternalCalendar: false,
    name,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
  };
}

describe("folder matching conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$name", (testCase) => {
    expect(Object.keys(testCase).sort()).toEqual([...KEYS].sort());
    expect(fuzzyMatchFolder(testCase.query, testCase.folders.map(folder))?.name ?? null).toBe(
      testCase.match
    );
  });
});
