import { describe, expect, it } from "vitest";

import { saveDelayFor } from "./saveDelay";

describe("saveDelayFor", () => {
  it("saves an ordinary page 800 ms after typing stops", () => {
    expect(saveDelayFor(0)).toBe(800);
    expect(saveDelayFor(120_000)).toBe(800);
  });

  it("waits longer the longer the page", () => {
    expect(saveDelayFor(1_000_000)).toBe(2000);
    expect(saveDelayFor(2_000_000)).toBe(4000);
  });

  it("never waits more than 5 s, however long the page", () => {
    expect(saveDelayFor(3_000_000)).toBe(5000);
    expect(saveDelayFor(50_000_000)).toBe(5000);
  });
});
