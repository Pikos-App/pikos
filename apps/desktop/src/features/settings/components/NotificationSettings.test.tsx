import { NoopPlatformAdapter } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setPlatform } from "@/shared/platform";
import { renderWithProviders } from "@/test/renderWithProviders";

import { NotificationSettings } from "./NotificationSettings";

const listNotificationHistory = vi.spyOn(MockStorageAdapter.prototype, "listNotificationHistory");

afterEach(() => {
  cleanup();
  listNotificationHistory.mockReset();
  setPlatform(null);
});

describe("NotificationSettings history", () => {
  // qa: NOTIF-08:4
  it("refresh shows a notification the scheduler logged after the panel opened", async () => {
    listNotificationHistory.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        action: null,
        firedAt: "2026-05-25 08:50:00",
        id: "n1",
        kind: "reminder",
        pageId: "p1",
        pageTitle: "Standup",
        scheduleId: "s1#10",
      },
    ]);
    renderWithProviders(<NotificationSettings />);
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh notification history" }));

    expect(await screen.findByRole("button", { name: "Standup" })).toBeInTheDocument();
  });
});

describe("NotificationSettings permission", () => {
  // qa: NOTIF-09
  it("offers a request when the system blocks notifications, and a retry when the request fails", async () => {
    listNotificationHistory.mockResolvedValue([]);
    const platform = new NoopPlatformAdapter();
    vi.spyOn(platform, "checkNotificationPermission").mockResolvedValue(false);
    vi.spyOn(platform, "requestNotificationPermission")
      .mockRejectedValueOnce(new Error("the shell refused"))
      .mockResolvedValueOnce(true);
    setPlatform(platform);
    renderWithProviders(<NotificationSettings />);

    expect(await screen.findByText("Notifications blocked by your system")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request permission" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.queryByText("Notifications blocked by your system")).not.toBeInTheDocument()
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
