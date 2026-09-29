// The history list is the only place a user can see that a reminder happened —
// and the only place a quiet-hours silence is visible at all — so what each row
// says is the behaviour worth pinning.

import type { NotificationHistoryEntry } from "@pikos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationHistory } from "./NotificationHistory";
import { describeEntry, formatFiredAt } from "./notificationHistoryFormat";

// globals: false in vitest config → auto-cleanup never runs.
afterEach(cleanup);

function entry(over: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    action: null,
    firedAt: "2026-05-25 08:50:00",
    id: "n1",
    kind: "reminder",
    pageId: "p1",
    pageTitle: "Standup",
    scheduleId: "s1#10",
    ...over,
  };
}

describe("NotificationHistory", () => {
  it("says so when nothing has fired yet", () => {
    render(<NotificationHistory entries={[]} onOpenPage={vi.fn()} />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("opens the page a delivered reminder was about", () => {
    const onOpenPage = vi.fn();
    render(<NotificationHistory entries={[entry()]} onOpenPage={onOpenPage} />);

    fireEvent.click(screen.getByRole("button", { name: "Standup" }));
    expect(onOpenPage).toHaveBeenCalledWith("p1");
  });

  it("renders a quiet-hours silence as silenced, not as delivered", () => {
    render(<NotificationHistory entries={[entry({ kind: "suppressed" })]} onOpenPage={vi.fn()} />);
    expect(screen.getByText("Silenced by quiet hours")).toBeInTheDocument();
    // Still clickable: the page is the point of knowing it was silenced.
    expect(screen.getByRole("button", { name: "Standup" })).toBeInTheDocument();
  });

  it("marks a reminder the user clicked through", () => {
    render(<NotificationHistory entries={[entry({ action: "opened" })]} onOpenPage={vi.fn()} />);
    expect(screen.getByText("Reminder · opened")).toBeInTheDocument();
  });

  it("renders the page-less daily summary without an open target", () => {
    render(
      <NotificationHistory
        entries={[entry({ kind: "overdue", pageId: null, pageTitle: null, scheduleId: null })]}
        onOpenPage={vi.fn()}
      />
    );
    expect(screen.getByText("Daily summary")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("names a page that has since been deleted rather than rendering a blank row", () => {
    render(<NotificationHistory entries={[entry({ pageTitle: null })]} onOpenPage={vi.fn()} />);
    expect(screen.getByText("Deleted page")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("row formatting", () => {
  it("labels each kind in the user's terms", () => {
    expect(describeEntry(entry())).toBe("Reminder");
    expect(describeEntry(entry({ action: "opened" }))).toBe("Reminder · opened");
    expect(describeEntry(entry({ kind: "suppressed" }))).toBe("Silenced by quiet hours");
    expect(describeEntry(entry({ kind: "overdue" }))).toBe("Daily summary");
  });

  it("reads the scheduler's space-separated local timestamp", () => {
    // Not ISO — `fired_at` is SQLite's `YYYY-MM-DD HH:MM:SS` in local time.
    expect(formatFiredAt("2026-05-25 08:50:00")).toBe("Mon 25 May 8:50am");
  });

  it("drops the date for today and names yesterday", () => {
    const now = new Date();
    const stamp = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")} 08:50:00`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    expect(formatFiredAt(stamp(now))).toBe("8:50am");
    expect(formatFiredAt(stamp(yesterday))).toBe("Yesterday 8:50am");
  });

  it("falls back to the raw value rather than rendering Invalid Date", () => {
    expect(formatFiredAt("not a timestamp")).toBe("not a timestamp");
  });
});
