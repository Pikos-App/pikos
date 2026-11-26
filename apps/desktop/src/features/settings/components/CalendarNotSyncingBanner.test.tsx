import type { AccountWithCalendars } from "@pikos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarSyncState } from "../hooks/useCalendarSync";
import { CalendarNotSyncingBanner } from "./CalendarNotSyncingBanner";

const NOW = new Date("2026-11-26T17:00:00Z");
const HOUR = 60 * 60 * 1000;

const sync = vi.hoisted(() => ({ state: {} as Partial<CalendarSyncState> }));
vi.mock("../hooks/useCalendarSync", () => ({ useCalendarSync: () => sync.state }));

function account(reconnectNeeded: boolean, lastSyncedAt: string): AccountWithCalendars {
  return {
    authKind: "oauth",
    calendars: [
      {
        accountId: "a",
        calendarId: "primary",
        color: null,
        detachedPages: 0,
        displayName: "Work",
        enabled: true,
        folderId: "f",
        id: "row",
        lastSyncedAt,
      },
    ],
    createdAt: "2026-10-12T18:00:00Z",
    displayName: "me@work.example",
    id: "a",
    provider: "google",
    reconnectNeeded,
  };
}

function given(state: Partial<CalendarSyncState>) {
  sync.state = {
    accounts: [],
    busyAccountId: null,
    lastPassAt: null,
    reconnect: vi.fn(),
    reconnectGoogle: vi.fn(),
    resync: vi.fn(),
    ...state,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CalendarNotSyncingBanner", () => {
  it("says nothing while every calendar syncs", () => {
    given({ accounts: [account(false, NOW.toISOString())], lastPassAt: NOW });
    render(<CalendarNotSyncingBanner />);
    expect(screen.queryByRole("region", { name: "Calendar not syncing" })).toBeNull();
  });

  // qa: SYNC-37:2
  it("names an account that needs signing in again, and Reconnect opens its dialog", () => {
    given({ accounts: [account(true, new Date(NOW.getTime() - 3 * HOUR).toISOString())] });
    render(<CalendarNotSyncingBanner />);

    const banner = screen.getByRole("region", { name: "Calendar not syncing" });
    expect(banner).toHaveTextContent(
      "me@work.example needs you to sign in again, so its events and reminders may be out of date. Last synced about 3 hours ago."
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByRole("dialog", { name: "Reconnect me@work.example" })).toBeInTheDocument();
  });

  // qa: SYNC-38:3
  it("says a calendar can't be reached once a pass missed it for an hour, and tries again", () => {
    const resync = vi.fn();
    given({
      accounts: [account(false, new Date(NOW.getTime() - 2 * HOUR).toISOString())],
      lastPassAt: NOW,
      resync,
    });
    render(<CalendarNotSyncingBanner />);

    expect(screen.getByRole("region", { name: "Calendar not syncing" })).toHaveTextContent(
      "Pikos can't reach me@work.example"
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(resync).toHaveBeenCalledWith("a");
  });

  // qa: SYNC-37:3
  it("hides until the app opens again", () => {
    given({ accounts: [account(true, NOW.toISOString())] });
    const { unmount } = render(<CalendarNotSyncingBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Hide until Pikos opens again" }));
    expect(screen.queryByRole("region", { name: "Calendar not syncing" })).toBeNull();

    unmount();
    render(<CalendarNotSyncingBanner />);
    expect(screen.getByRole("region", { name: "Calendar not syncing" })).toBeInTheDocument();
  });
});
