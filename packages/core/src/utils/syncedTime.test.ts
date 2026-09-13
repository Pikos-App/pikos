import { describe, expect, it } from "vitest";

import { cloneWallClock, resolveSyncedInstant } from "./syncedTime";

// Vitest pins TZ=UTC, so a Date's UTC fields ARE the viewer-zone wall clock the
// calendar reads — exactly the production "device zone = viewer zone" case.
describe("resolveSyncedInstant", () => {
  it("resolves a PT wall-clock to its absolute instant (shifts +7h for a UTC viewer)", () => {
    // 3:00pm Los_Angeles in June (PDT, -07:00) = 22:00 UTC.
    const instant = resolveSyncedInstant("2026-06-15T15:00:00", "America/Los_Angeles");
    expect(instant.toISOString()).toBe("2026-06-15T22:00:00.000Z");
  });

  it("does not shift when the source zone matches the viewer (UTC test runner)", () => {
    const instant = resolveSyncedInstant("2026-06-15T15:00:00", "UTC");
    expect(instant.toISOString()).toBe("2026-06-15T15:00:00.000Z");
  });

  it("applies the correct per-occurrence DST offset", () => {
    // New York: January is EST (-05:00), July is EDT (-04:00).
    expect(resolveSyncedInstant("2026-01-15T12:00:00", "America/New_York").toISOString()).toBe(
      "2026-01-15T17:00:00.000Z"
    );
    expect(resolveSyncedInstant("2026-07-15T12:00:00", "America/New_York").toISOString()).toBe(
      "2026-07-15T16:00:00.000Z"
    );
  });
});

describe("cloneWallClock", () => {
  it("re-expresses a timed zoned occurrence in the viewer's zone (UTC runner)", () => {
    expect(cloneWallClock("2026-06-15T15:00:00", "America/Los_Angeles")).toBe(
      "2026-06-15T22:00:00"
    );
  });

  it("keeps an all-day occurrence's date untouched", () => {
    expect(cloneWallClock("2026-06-15", "America/Los_Angeles")).toBe("2026-06-15");
  });

  it("keeps a floating (no-zone) occurrence's wall-clock untouched", () => {
    expect(cloneWallClock("2026-06-15T15:00:00", null)).toBe("2026-06-15T15:00:00");
    expect(cloneWallClock("2026-06-15T15:00:00", undefined)).toBe("2026-06-15T15:00:00");
  });
});
