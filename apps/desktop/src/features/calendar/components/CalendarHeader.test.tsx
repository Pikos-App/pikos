import type { CalendarDayCount } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders } from "@/test/renderWithProviders";

import { CalendarHeader } from "./CalendarHeader";

function renderWeek(now: string, referenceDate: string, dayCount: CalendarDayCount = 7) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  renderWithProviders(
    <TooltipProvider>
      <CalendarHeader
        dayCount={dayCount}
        onNextWeek={() => {}}
        onPrevWeek={() => {}}
        onToday={() => {}}
        onViewModeChange={() => {}}
        referenceDate={new Date(referenceDate)}
        viewMode="time"
      />
    </TooltipProvider>
  );
  return screen.getByRole("button", { name: "Jump to current week" });
}

describe("CalendarHeader's jump to the current week", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // qa: CAL-12:2
  it("stays available from last week on the first day of this week", () => {
    expect(renderWeek("2026-10-05T09:00:00", "2026-09-28T12:00:00")).toBeEnabled();
  });

  it("is off on this week, from its first day to its last", () => {
    expect(renderWeek("2026-10-05T00:00:00", "2026-10-07T12:00:00")).toBeDisabled();
    cleanup();
    expect(renderWeek("2026-10-11T23:59:00", "2026-10-07T12:00:00")).toBeDisabled();
  });
});

describe("CalendarHeader's range label", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("names the one day when it shows one, not a range that starts and ends on it", () => {
    renderWeek("2026-09-15T09:00:00", "2026-09-15T12:00:00", 1);
    expect(screen.getByRole("heading", { name: "Visible week" })).toHaveTextContent(
      "Tue, Sep 15, 2026"
    );
  });

  it("names a week inside one month as a range of days", () => {
    renderWeek("2026-09-15T09:00:00", "2026-09-15T12:00:00");
    expect(screen.getByRole("heading", { name: "Visible week" })).toHaveTextContent(
      /^Sep \d+ – \d+, 2026$/
    );
  });
});
