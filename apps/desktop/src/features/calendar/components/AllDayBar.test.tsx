// A detached synced all-day bar stays a real, editable page: it shows the
// broken-sync glyph but is NOT struck through / dimmed-as-done. Only a `done`
// status applies the done treatment. Neither component renders a CSS
// line-through (done is conveyed via opacity-50); the user-visible "not done"
// signal is the absence of that treatment, asserted via the button's class as a
// last resort since done state isn't otherwise exposed accessibly inside the bar.

import type { PageSummary } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import type { AllDayBar as AllDayBarData } from "../utils/allDayLayout";
import { AllDayBar } from "./AllDayBar";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

function makePage(over: Partial<PageSummary>): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: "2099-01-05",
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    syncState: "detached",
    tags: [],
    title: "Conference",
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

function makeBar(page: PageSummary): AllDayBarData {
  return {
    continuesLeft: false,
    continuesRight: false,
    key: "k1",
    page,
    row: 0,
    span: 1,
    startCol: 0,
  };
}

function renderBar(page: PageSummary) {
  return renderWithProviders(
    <AllDayBar
      bar={makeBar(page)}
      draggingPageId={null}
      folderColor={undefined}
      onDoubleClick={vi.fn()}
      onDragStart={vi.fn()}
      position={{}}
    />
  );
}

describe("AllDayBar — detached synced rendering", () => {
  it("shows the broken-sync glyph and is not struck through when not done", () => {
    renderBar(makePage({ status: "not_started", syncState: "detached" }));
    expect(screen.getByLabelText("Disconnected from calendar")).toBeInTheDocument();
    expect(screen.getByText("Conference")).toBeInTheDocument();
    const bar = screen.getByRole("button", { name: "Conference" });
    expect(bar.className).not.toContain("opacity-50");
  });

  it("applies the done treatment when the page is done", () => {
    renderBar(makePage({ status: "done", syncState: "detached" }));
    const bar = screen.getByRole("button", { name: "Conference" });
    expect(bar.className).toContain("opacity-50");
  });
});
