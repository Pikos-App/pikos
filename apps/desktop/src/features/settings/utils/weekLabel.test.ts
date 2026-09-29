import { describe, expect, it } from "vitest";

import { weekLabel } from "./weekLabel";

function weeks(...labels: string[]) {
  return labels.map((week) => ({ completed: 0, created: 0, edited: 0, focus_minutes: 0, week }));
}

describe("weekLabel", () => {
  it("names the newest bucket for the present, not its Monday", () => {
    const w = weeks("Jun 1", "Jun 8", "Aug 17");
    expect(weekLabel(w, 2)).toBe("This week");
    expect(weekLabel(w, 0)).toBe("Jun 1");
  });

  it("names a lone bucket for the present too", () => {
    expect(weekLabel(weeks("Aug 17"), 0)).toBe("This week");
  });

  it("is empty for an index the data doesn't reach", () => {
    expect(weekLabel(weeks(), 0)).toBe("");
  });
});
