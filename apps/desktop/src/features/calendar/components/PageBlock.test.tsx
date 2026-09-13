// A detached synced timed block stays a real, editable page: it shows the
// broken-sync glyph but is NOT struck through / dimmed-as-done. Only a `done`
// status applies the done treatment. Neither calendar block renders a CSS
// line-through (done is conveyed via opacity-50); "not done" is the absence of
// that treatment, asserted via the button's class as a last resort since done
// state isn't otherwise exposed accessibly inside the block.

import type { CalendarBlock, PageSummary } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarSettingsProvider } from "@/shared/context/CalendarSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { PageBlock } from "./PageBlock";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

function makePage(over: Partial<PageSummary>): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isRecurring: false,
    priority: 0,
    scheduledEnd: "2099-01-05T10:00:00",
    scheduledStart: "2099-01-05T09:00:00",
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    syncState: "detached",
    tags: [],
    title: "Standup",
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

function makeBlock(page: PageSummary): CalendarBlock {
  return {
    cascadeDepth: 0,
    endDate: new Date("2099-01-05T10:00:00"),
    height: 64,
    isCompact: false,
    leftPct: 0,
    page,
    startDate: new Date("2099-01-05T09:00:00"),
    top: 100,
    widthPct: 100,
  };
}

function renderBlock(page: PageSummary) {
  return renderWithProviders(
    <CalendarSettingsProvider>
      <PageBlock block={makeBlock(page)} folderColor={undefined} onDoubleClick={vi.fn()} />
    </CalendarSettingsProvider>
  );
}

describe("PageBlock — detached synced rendering", () => {
  it("shows the broken-sync glyph and is not struck through when not done", () => {
    renderBlock(makePage({ status: "not_started", syncState: "detached" }));
    expect(screen.getByLabelText("Disconnected from calendar")).toBeInTheDocument();
    expect(screen.getByText("Standup")).toBeInTheDocument();
    const block = screen.getByRole("button", { name: /Standup/ });
    expect(block.className).not.toContain("opacity-50");
  });

  it("applies the done treatment when the page is done", () => {
    renderBlock(makePage({ status: "done", syncState: "detached" }));
    const block = screen.getByRole("button", { name: /Standup/ });
    expect(block.className).toContain("opacity-50");
  });
});
