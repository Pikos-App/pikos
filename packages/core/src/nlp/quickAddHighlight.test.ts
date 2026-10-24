import { describe, expect, it } from "vitest";

import { parseInput } from "./parser";
import { quickAddHighlightTokens } from "./quickAddHighlight";

function read(line: string, title: string): [string, string][] {
  return quickAddHighlightTokens(line, title).map((token) => [
    line.slice(token.start, token.end),
    token.kind,
  ]);
}

describe("quickAddHighlightTokens", () => {
  it("marks the words the parser took by what they are", () => {
    expect(
      read("Call the dentist tomorrow at 3pm !high #health ~Personal", "Call the dentist")
    ).toEqual([
      ["tomorrow", "when"],
      ["at", "when"],
      ["3pm", "when"],
      ["!high", "priority"],
      ["#health", "tag"],
      ["~Personal", "folder"],
    ]);
  });

  it("finds a marker in the middle of the title where it was typed", () => {
    expect(read("Buy #home milk", "Buy milk")).toEqual([["#home", "tag"]]);
  });

  it("does not mark a title word that repeats a date word", () => {
    expect(read("Plan tomorrow tomorrow", "Plan tomorrow")).toEqual([["tomorrow", "when"]]);
  });

  it("keeps a title word whose case or accent the parser changed", () => {
    expect(read("call Mom today", "Call mom")).toEqual([["today", "when"]]);
    expect(read("Café today", "cafe")).toEqual([["today", "when"]]);
  });

  it("reads everything after the note marker as the note", () => {
    expect(read("Groceries today // eggs, milk", "Groceries")).toEqual([
      ["today", "when"],
      ["// eggs, milk", "note"],
    ]);
  });

  it("marks nothing on a line the parser left alone", () => {
    expect(read("Water the plants", "Water the plants")).toEqual([]);
    expect(read("", "")).toEqual([]);
  });

  it("agrees with the parser on the line the phone is tested with", () => {
    const line = "Call the dentist tomorrow at 3pm !high #health";
    const result = parseInput(line, new Date(2026, 2, 16));
    const title = result.type === "finite" ? (result.inputs[0]?.title ?? "") : result.input.title;

    expect(read(line, title).map(([word]) => word)).toEqual([
      "tomorrow",
      "at",
      "3pm",
      "!high",
      "#health",
    ]);
  });
});
