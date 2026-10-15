import { describe, expect, it } from "vitest";

import { readFixture } from "../adapters/conformanceTable";
import { resolveAssetPath } from "./assetPath";

interface Case {
  name: string;
  stored: string;
  resolved: string;
}

const KEYS = ["name", "stored", "resolved"];

const { assetsDir, cases } = readFixture<{ assetsDir: string; cases: Case[] }>("asset-paths.json");

describe("asset path conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$name", (testCase) => {
    expect(Object.keys(testCase).sort()).toEqual([...KEYS].sort());
    expect(resolveAssetPath(testCase.stored, assetsDir)).toBe(testCase.resolved);
  });
});
