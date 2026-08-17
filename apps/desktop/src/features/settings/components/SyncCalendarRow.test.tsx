import type { SyncCalendar } from "@pikos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncCalendarRow } from "./SyncCalendarRow";

function cal(over: Partial<SyncCalendar> = {}): SyncCalendar {
  return {
    accountId: "a1",
    calendarId: "personal-cal",
    color: "#A8CDB4",
    detachedPages: 0,
    displayName: "Personal",
    enabled: false,
    folderId: null,
    id: "c1",
    lastSyncedAt: null,
    ...over,
  };
}

function render_(over: Partial<SyncCalendar> = {}, onToggle = vi.fn()) {
  render(<SyncCalendarRow calendar={cal(over)} onRecolor={vi.fn()} onToggle={onToggle} />);
  return onToggle;
}

afterEach(cleanup);

describe("SyncCalendarRow", () => {
  it("turns a calendar on without asking when nothing was left behind", () => {
    const onToggle = render_();
    fireEvent.click(screen.getByRole("switch", { name: "Sync Personal" }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("confirms before reclaiming pages kept from a previous sync", () => {
    const onToggle = render_({ detachedPages: 3 });
    fireEvent.click(screen.getByRole("switch", { name: "Sync Personal" }));

    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("You kept 3 pages");

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("leaves the calendar off when the confirm is cancelled", () => {
    const onToggle = render_({ detachedPages: 1 });
    fireEvent.click(screen.getByRole("switch", { name: "Sync Personal" }));

    expect(screen.getByRole("alertdialog")).toHaveTextContent("You kept 1 page ");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  // Off hard-deletes every mirror the user never actioned; only the ones they did
  // something with detach and survive. It asks every time, where the on direction
  // asks only when pages are waiting.
  it("confirms before turning a calendar off, with nothing left behind", () => {
    const onToggle = render_({ enabled: true, folderId: "f1" });
    fireEvent.click(screen.getByRole("switch", { name: "Sync Personal" }));

    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Turn Personal off?");

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("leaves the calendar on when the off confirm is cancelled", () => {
    const onToggle = render_({ detachedPages: 3, enabled: true, folderId: "f1" });
    fireEvent.click(screen.getByRole("switch", { name: "Sync Personal" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
