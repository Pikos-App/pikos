import { describe, expect, it } from "vitest";

import type { AccountWithCalendars } from "../types";
import {
  accountConnectionState,
  accountsNotSyncing,
  calendarSyncDot,
  NOT_SYNCING_AFTER_MS,
  STALE_AFTER_MS,
} from "./syncStatus";

const NOW = new Date("2026-06-19T12:00:00Z");

function cal(enabled: boolean, lastSyncedAt: string | null) {
  return { enabled, lastSyncedAt };
}

describe("calendarSyncDot", () => {
  it("is off when the calendar is disabled, regardless of last sync", () => {
    expect(calendarSyncDot(cal(false, NOW.toISOString()), "synced", NOW).state).toBe("off");
  });

  // qa: SYNC-09:5
  it("is active for a fresh successful resync result", () => {
    expect(calendarSyncDot(cal(true, null), "synced", NOW).state).toBe("active");
  });

  it("is error when the last resync said reconnect needed", () => {
    expect(calendarSyncDot(cal(true, NOW.toISOString()), "reconnectNeeded", NOW).state).toBe(
      "error"
    );
  });

  // qa: SYNC-09:5
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

  // A background pass leaves no result, so the stored flag is the only evidence a credential was
  // rejected.
  it("is reconnectNeeded from the stored flag alone, with no results", () => {
    expect(accountConnectionState([undefined], true)).toBe("reconnectNeeded");
  });
});

describe("accountsNotSyncing", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const HOUR = NOT_SYNCING_AFTER_MS;

  function account(
    calendars: { enabled: boolean; lastSyncedAt: string | null }[],
    reconnectNeeded = false
  ): AccountWithCalendars {
    return {
      authKind: "oauth",
      calendars: calendars.map((c, i) => ({
        accountId: "a",
        calendarId: `cal-${i}`,
        color: null,
        detachedPages: 0,
        displayName: `Calendar ${i}`,
        enabled: c.enabled,
        folderId: c.enabled ? `folder-${i}` : null,
        id: `row-${i}`,
        lastSyncedAt: c.lastSyncedAt,
      })),
      createdAt: ago(30 * 24 * HOUR),
      displayName: "me@work.example",
      id: "a",
      provider: "google",
      reconnectNeeded,
    };
  }

  // qa: SYNC-37:5
  it("names an account that needs reconnecting, before any pass has run", () => {
    const found = accountsNotSyncing([account([cal(true, ago(3 * HOUR))], true)], null, NOW);
    expect(found.map((f) => f.reason)).toEqual(["reconnectNeeded"]);
    expect(found[0]?.lastSyncedAt).toBe(ago(3 * HOUR));
  });

  it("leaves out an account with no calendar switched on, as it shows no events", () => {
    expect(accountsNotSyncing([account([cal(false, ago(3 * HOUR))], true)], null, NOW)).toEqual([]);
  });

  // qa: SYNC-38:3
  it("names an account a pass failed to update for over an hour", () => {
    const found = accountsNotSyncing([account([cal(true, ago(HOUR + 60_000))])], NOW, NOW);
    expect(found.map((f) => f.reason)).toEqual(["unreachable"]);
  });

  // qa: SYNC-38:3
  it("says nothing after the Mac wakes until a pass has failed", () => {
    // The last pass ended when the last sync did, hours ago, before the Mac slept.
    const slept = ago(8 * HOUR);
    expect(accountsNotSyncing([account([cal(true, slept)])], new Date(slept), NOW)).toEqual([]);
  });

  it("says nothing within the hour, though a pass missed the calendar", () => {
    expect(accountsNotSyncing([account([cal(true, ago(HOUR - 60_000))])], NOW, NOW)).toEqual([]);
  });

  it("says nothing for a calendar that has never synced yet", () => {
    expect(accountsNotSyncing([account([cal(true, null)])], NOW, NOW)).toEqual([]);
  });

  it("gives the oldest last sync of the account's calendars", () => {
    const found = accountsNotSyncing(
      [account([cal(true, ago(2 * HOUR)), cal(true, ago(5 * HOUR)), cal(false, ago(9 * HOUR))])],
      NOW,
      NOW
    );
    expect(found[0]?.lastSyncedAt).toBe(ago(5 * HOUR));
  });
});
