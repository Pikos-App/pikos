import type { AccountWithCalendars, SyncCalendar } from "@pikos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncAccountCard } from "./SyncAccountCard";

afterEach(cleanup);

function cal(over: Partial<SyncCalendar> = {}): SyncCalendar {
  return {
    accountId: "a1",
    calendarId: "personal-cal",
    color: "#A8CDB4",
    displayName: "Personal",
    enabled: true,
    folderId: "f1",
    id: "c1",
    lastSyncedAt: null,
    ...over,
  };
}

function account(calendars: SyncCalendar[]): AccountWithCalendars {
  return {
    authKind: "basic",
    calendars,
    createdAt: "2026-06-19T00:00:00Z",
    displayName: "me@example.com",
    id: "a1",
    provider: "caldav",
  };
}

function render_(over?: Partial<Parameters<typeof SyncAccountCard>[0]>) {
  return render(
    <SyncAccountCard
      account={account([cal()])}
      busy={false}
      onDisconnect={() => Promise.resolve()}
      onRecolorCalendar={vi.fn()}
      onResync={vi.fn()}
      onToggleCalendar={vi.fn()}
      results={{}}
      {...over}
    />
  );
}

describe("SyncAccountCard", () => {
  it("shows Connected by default and lists the account's calendars", () => {
    render_();
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
  });

  it("shows Reconnect needed when a calendar's last resync failed auth", () => {
    // results is keyed by sync_calendar row id (cal() → id "c1").
    render_({ results: { c1: "reconnectNeeded" } });
    expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("spins a syncing indicator while the account is busy", () => {
    render_({ busy: true });
    expect(screen.getByText("Syncing…")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("handles an account with no discovered calendars", () => {
    render_({ account: account([]) });
    expect(screen.getByText("No calendars discovered.")).toBeInTheDocument();
  });
});
