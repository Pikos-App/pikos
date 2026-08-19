import { describe, expect, it } from "vitest";

import type { Folder } from "../types";
import { folderMoveTargets } from "./folderMoveTargets";

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

describe("folderMoveTargets", () => {
  it("excludes external-calendar folders, keeping the rest in order", () => {
    const folders = [
      makeFolder("Work"),
      makeFolder("Fastmail", true),
      makeFolder("Home"),
      makeFolder("iCloud", true),
    ];
    expect(folderMoveTargets(folders).map((f) => f.name)).toEqual(["Work", "Home"]);
  });

  it("returns empty when every folder is external", () => {
    expect(folderMoveTargets([makeFolder("Fastmail", true)])).toEqual([]);
  });
});
