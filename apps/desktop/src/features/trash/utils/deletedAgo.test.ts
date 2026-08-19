import { describe, expect, it } from "vitest";

import { daysSince, deletedAgoLabel } from "./deletedAgo";

const NOW = new Date("2026-06-10T12:00:00Z");

function ago(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

describe("deletedAgoLabel", () => {
  it("names today, yesterday, then counts days", () => {
    expect(deletedAgoLabel(ago(0, 3), NOW)).toBe("Deleted today");
    expect(deletedAgoLabel(ago(1), NOW)).toBe("Deleted yesterday");
    expect(deletedAgoLabel(ago(12), NOW)).toBe("Deleted 12 days ago");
  });

  it("reads a stamp from the future as today rather than a negative count", () => {
    expect(deletedAgoLabel(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe(
      "Deleted today"
    );
  });

  it("survives a stamp it cannot parse", () => {
    expect(daysSince("not a date", NOW)).toBe(0);
  });
});
