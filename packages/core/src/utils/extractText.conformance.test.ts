// The same table `extract_text_from_tiptap` runs: the reconciler compares the two implementations
// byte for byte, so they share one expectation. Rust owns the why, at
// `CONTENT_TEXT_PROJECTION_VERSION`.

import { describe, expect, it } from "vitest";

import { readFixture } from "../adapters/conformanceTable";
import { extractText } from "./extractText";

interface Case {
  name: string;
  doc: unknown;
  text: string;
}

const KEYS = ["name", "doc", "text"];

const { cases } = readFixture<{ cases: Case[] }>("content-text-projection.json");

describe("content_text projection conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // A key this runner never reads would pass here while the Rust runner enforces it.
  it.each(cases)("$name", (testCase) => {
    expect(Object.keys(testCase).sort()).toEqual([...KEYS].sort());
    expect(extractText(testCase.doc)).toBe(testCase.text);
  });
});
