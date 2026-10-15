import type { PageSummary } from "@pikos/core";
import { DEFAULT_METRICS } from "@pikos/core";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { addDays } from "date-fns";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarSettingsProvider } from "@/shared/context/CalendarSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { AllDaySection } from "./AllDaySection";

afterEach(cleanup);

function allDayPage(i: number): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    id: `p${i}`,
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: "2099-01-05",
    scheduleLocked: false,
    sortOrder: i,
    status: "not_started",
    tags: [],
    title: `Event ${i}`,
    updatedAt: "2026-01-01T00:00:00",
  };
}

function renderStrip(pages: PageSummary[], height: number) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(new Date(2099, 0, 5), i));
  renderWithProviders(
    <CalendarSettingsProvider>
      <AllDaySection
        allDayDragHoverIndex={null}
        autoOpenPageId={null}
        createPreview={null}
        days={days}
        draggingPageId={null}
        height={height}
        onAutoOpenConsumed={vi.fn()}
        onChipDragStart={vi.fn()}
        onCreateDragStart={vi.fn()}
        onEdgeResizeStart={vi.fn()}
        onPageDoubleClick={vi.fn()}
        onResizeStart={vi.fn()}
        pages={pages}
        timedDragTarget={null}
      />
    </CalendarSettingsProvider>
  );
}

describe("AllDaySection", () => {
  it("draws the rows in view and reaches the rest by scrolling", () => {
    renderStrip(
      Array.from({ length: 60 }, (_, i) => allDayPage(i)),
      60
    );
    expect(screen.getByRole("button", { name: "Event 0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Event 59" })).toBeNull();

    const strip = screen.getByRole("group", { name: "All-day events" });
    fireEvent.scroll(strip, { target: { scrollTop: 58 * DEFAULT_METRICS.allDayRowHeight } });

    expect(screen.getByRole("button", { name: "Event 59" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Event 0" })).toBeNull();
  });
});
