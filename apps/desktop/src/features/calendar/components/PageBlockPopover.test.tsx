// PageBlockPopover — read-only mirror metadata on a synced (locked) event.
// Verifies location + attendees render for a locked page and are absent on a
// native one.

import type { PageSummary } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { PageBlockPopover } from "./PageBlockPopover";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

function makePage(over: Partial<PageSummary>): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    priority: 0,
    scheduledEnd: "2099-01-05T10:00:00",
    scheduledStart: "2099-01-05T09:00:00",
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Standup",
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

function renderPopover(page: PageSummary) {
  return renderWithProviders(
    <AppSettingsProvider>
      <TooltipProvider>
        <PageBlockPopover onClose={vi.fn()} page={page} />
      </TooltipProvider>
    </AppSettingsProvider>
  );
}

describe("PageBlockPopover — mirror metadata", () => {
  it("renders location + attendees read-only on a locked event", () => {
    renderPopover(
      makePage({
        mirrorAttendees: ["alex@example.com", "sam@example.com"],
        mirrorLocation: "Zoom",
        scheduleLocked: true,
        syncState: "active",
      })
    );
    expect(screen.getByText("Zoom")).toBeInTheDocument();
    expect(screen.getByText("2 guests")).toBeInTheDocument();
  });

  it("omits mirror metadata on a native (unlocked) page", () => {
    renderPopover(makePage({ mirrorAttendees: ["alex@example.com"], mirrorLocation: "Zoom" }));
    expect(screen.queryByText("Zoom")).not.toBeInTheDocument();
  });
});
