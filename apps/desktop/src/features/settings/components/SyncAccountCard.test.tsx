import type { AccountWithCalendars, SyncCalendar } from "@pikos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncAccountCard } from "./SyncAccountCard";

afterEach(cleanup);

function cal(over: Partial<SyncCalendar> = {}): SyncCalendar {
  return {
    accountId: "a1",
    calendarId: "personal-cal",
    color: "#A8CDB4",
    detachedPages: 0,
    displayName: "Personal",
    enabled: true,
    folderId: "f1",
    id: "c1",
    lastSyncedAt: null,
    ...over,
  };
}

function account(
  calendars: SyncCalendar[],
  over: Partial<AccountWithCalendars> = {}
): AccountWithCalendars {
  return {
    authKind: "basic",
    calendars,
    createdAt: "2026-06-19T00:00:00Z",
    displayName: "me@example.com",
    id: "a1",
    provider: "caldav",
    reconnectNeeded: false,
    ...over,
  };
}

function render_(over?: Partial<Parameters<typeof SyncAccountCard>[0]>) {
  return render(
    <SyncAccountCard
      account={account([cal()])}
      busy={false}
      onDisconnect={() => Promise.resolve()}
      onRecolorCalendar={vi.fn()}
      onReconnect={() => Promise.resolve()}
      onReconnectGoogle={() => Promise.resolve()}
      onRefresh={vi.fn()}
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
    expect(screen.getByText(/Reconnect needed/)).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("shows Reconnect needed from the stored flag, with no resync result in hand", () => {
    render_({ account: account([cal()], { reconnectNeeded: true }) });
    expect(screen.getByText(/Reconnect needed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("opens the reconnect dialog from the status link", () => {
    render_({ account: account([cal()], { reconnectNeeded: true }) });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Reconnect me@example.com");
  });

  it("spins a syncing indicator while the account is busy", () => {
    render_({ busy: true });
    expect(screen.getByText("Syncing…")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("offers a full refresh alongside the incremental resync", async () => {
    const onRefresh = vi.fn();
    const onResync = vi.fn();
    render_({ onRefresh, onResync });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Account actions for me@example.com" }),
      { button: 0, ctrlKey: false }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Refresh from calendar/ }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onResync).not.toHaveBeenCalled();
  });

  it("handles an account with no discovered calendars", () => {
    render_({ account: account([]) });
    expect(screen.getByText("No calendars discovered.")).toBeInTheDocument();
  });
});
