import { MockStorageAdapter } from "@pikos/core/testing";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { NotificationSettings } from "./NotificationSettings";

const listNotificationHistory = vi.spyOn(MockStorageAdapter.prototype, "listNotificationHistory");

afterEach(() => {
  cleanup();
  listNotificationHistory.mockReset();
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
