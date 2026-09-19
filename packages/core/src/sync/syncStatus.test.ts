import { describe, expect, it } from "vitest";

import { accountConnectionState, calendarSyncDot, STALE_AFTER_MS } from "./syncStatus";

const NOW = new Date("2026-06-19T12:00:00Z");

function cal(enabled: boolean, lastSyncedAt: string | null) {
  return { enabled, lastSyncedAt };
}

describe("calendarSyncDot", () => {
  it("is off when the calendar is disabled, regardless of last sync", () => {
    expect(calendarSyncDot(cal(false, NOW.toISOString()), "synced", NOW).state).toBe("off");
  });

  it("is active for a fresh successful resync result", () => {
    expect(calendarSyncDot(cal(true, null), "synced", NOW).state).toBe("active");
  });

  it("is error when the last resync said reconnect needed", () => {
    expect(calendarSyncDot(cal(true, NOW.toISOString()), "reconnectNeeded", NOW).state).toBe(
      "error"
    );
  });

  it("is stale when the last resync was offline", () => {
    expect(calendarSyncDot(cal(true, NOW.toISOString()), "offline", NOW).state).toBe("stale");
  });

  it("falls back to lastSyncedAt freshness with no result in hand", () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    expect(calendarSyncDot(cal(true, fresh), undefined, NOW).state).toBe("active");
  });

  it("is stale once lastSyncedAt crosses the threshold", () => {
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 1).toISOString();
    expect(calendarSyncDot(cal(true, old), undefined, NOW).state).toBe("stale");
  });

  it("is stale when enabled but never synced", () => {
    expect(calendarSyncDot(cal(true, null), undefined, NOW).state).toBe("stale");
  });

  it("carries a human label for the dot", () => {
    expect(calendarSyncDot(cal(true, null), "reconnectNeeded", NOW).label).toBe("Reconnect needed");
  });
});

describe("accountConnectionState", () => {
  it("is connected with no results", () => {
    expect(accountConnectionState([undefined, undefined])).toBe("connected");
  });

  it("is connected when every calendar synced", () => {
    expect(accountConnectionState(["synced"])).toBe("connected");
  });

  it("is reconnectNeeded if any calendar failed auth", () => {
    expect(accountConnectionState(["synced", "reconnectNeeded"])).toBe("reconnectNeeded");
  });

  // The background pass leaves no result behind, so the stored flag is the only
  // evidence a credential was rejected — and the scheduler has stopped polling.
  it("is reconnectNeeded from the stored flag alone, with no results", () => {
    expect(accountConnectionState([undefined], true)).toBe("reconnectNeeded");
  });
});
