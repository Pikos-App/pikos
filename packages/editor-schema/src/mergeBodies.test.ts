import { describe, expect, it } from "vitest";

import { mergeBodyJSON } from "./mergeBodies";

function body(...paragraphs: string[]): string {
  return JSON.stringify({
    content: paragraphs.map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ text, type: "text" }] } : {}),
    })),
    type: "doc",
  });
}

function paragraphsOf(json: string | null): string[] {
  const doc = JSON.parse(json ?? "null") as {
    content: { content?: { text: string }[] }[];
  };
  return doc.content.map((p) => (p.content ?? []).map((t) => t.text).join(""));
}

describe("mergeBodyJSON", () => {
  it("keeps an edit from each device when they touched different paragraphs", () => {
    const base = body("Milk", "Eggs");
    const phone = body("Milk", "Eggs and bread");
    const mac = body("Oat milk", "Eggs");

    expect(paragraphsOf(mergeBodyJSON(base, mac, phone))).toEqual(["Oat milk", "Eggs and bread"]);
  });

  it("moves a local edit past text the other device added ahead of it", () => {
    const base = body("Call the dentist");
    const phone = body("Today: Call the dentist");
    const mac = body("Call the dentist at nine");

    expect(paragraphsOf(mergeBodyJSON(base, mac, phone))).toEqual([
      "Today: Call the dentist at nine",
    ]);
  });

  it("keeps a new paragraph from each device", () => {
    const base = body("Agenda");
    const phone = body("Agenda", "Budget");
    const mac = body("Plan", "Agenda");

    expect(paragraphsOf(mergeBodyJSON(base, mac, phone))).toEqual(["Plan", "Agenda", "Budget"]);
  });

  it("reports a conflict when both devices changed the same words", () => {
    const base = body("Milk");
    const phone = body("Oat milk");
    const mac = body("Soy milk");

    expect(mergeBodyJSON(base, mac, phone)).toBeNull();
  });

  it("takes the other device's body when nothing was typed here", () => {
    const base = body("Milk");
    const phone = body("Milk", "Eggs");

    expect(paragraphsOf(mergeBodyJSON(base, base, phone))).toEqual(["Milk", "Eggs"]);
  });

  it("reports a conflict for a body that will not parse", () => {
    expect(mergeBodyJSON("not json", body("a"), body("b"))).toBeNull();
  });
});
