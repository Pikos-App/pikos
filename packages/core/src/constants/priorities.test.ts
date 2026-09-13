// priorities — shared NLP priority mapping + UI labels. Tests pin the
// contract between the parser's PagePriority strings and the schema's
// numeric priority values.

import { describe, expect, it } from "vitest";

import { NLP_PRIORITY_MAP, PRIORITY_COLORS, PRIORITY_LABELS } from "./priorities";

describe("NLP_PRIORITY_MAP", () => {
  it("maps every parser-produced priority string to a numeric PagePriority", () => {
    // Source of truth: the parser's PagePriority union ('urgent' | 'high' | 'medium' | 'low').
    const parserStrings = ["urgent", "high", "medium", "low"] as const;
    for (const s of parserStrings) {
      expect(NLP_PRIORITY_MAP[s]).toBeDefined();
      expect([1, 2, 3, 4]).toContain(NLP_PRIORITY_MAP[s]);
    }
  });

  it("urgent < high < medium < low in numeric ordering (1 = highest urgency)", () => {
    expect(NLP_PRIORITY_MAP["urgent"]).toBeLessThan(NLP_PRIORITY_MAP["high"]!);
    expect(NLP_PRIORITY_MAP["high"]).toBeLessThan(NLP_PRIORITY_MAP["medium"]!);
    expect(NLP_PRIORITY_MAP["medium"]).toBeLessThan(NLP_PRIORITY_MAP["low"]!);
  });

  it("does not map 'none' or unknown words", () => {
    expect(NLP_PRIORITY_MAP["none"]).toBeUndefined();
    expect(NLP_PRIORITY_MAP["asdf"]).toBeUndefined();
  });
});

describe("PRIORITY_LABELS", () => {
  it("covers every numeric priority 0..4", () => {
    for (const n of [0, 1, 2, 3, 4] as const) {
      expect(PRIORITY_LABELS[n]).toBeDefined();
      expect(typeof PRIORITY_LABELS[n]).toBe("string");
    }
  });

  it("0 → 'None' (the default / cleared state)", () => {
    expect(PRIORITY_LABELS[0]).toBe("None");
  });

  it("matches the inverse of NLP_PRIORITY_MAP for 1..4", () => {
    expect(PRIORITY_LABELS[NLP_PRIORITY_MAP["urgent"]!]).toBe("Urgent");
    expect(PRIORITY_LABELS[NLP_PRIORITY_MAP["high"]!]).toBe("High");
    expect(PRIORITY_LABELS[NLP_PRIORITY_MAP["medium"]!]).toBe("Medium");
    expect(PRIORITY_LABELS[NLP_PRIORITY_MAP["low"]!]).toBe("Low");
  });
});

describe("PRIORITY_COLORS", () => {
  it("covers every numeric priority 0..4", () => {
    for (const n of [0, 1, 2, 3, 4] as const) {
      expect(PRIORITY_COLORS[n]).toMatch(/^text-/);
    }
  });
});
