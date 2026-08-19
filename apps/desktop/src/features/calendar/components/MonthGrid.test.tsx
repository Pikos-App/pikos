// MonthGrid — what the month view puts on screen (day numbers, chips, the
// "+K more" pill) and where each click goes. The popover seam is asserted via
// the chip's own trigger; navigation is asserted through the injected
// `onOpenDay`, which CalendarView wires to referenceDate + view mode.

import type { MonthCell, PageSummary } from "@pikos/core";
import { buildMonthGrid } from "@pikos/core";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { MonthGrid } from "./MonthGrid";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

beforeEach(() => {
  // Prime UIContext's persisted rightPanel so the block-popover hook's
  // force-close branch (rightPanel !== "calendar" → close) doesn't fire.
  localStorage.clear();
  localStorage.setItem("pikos:rightPanel", JSON.stringify("calendar"));
});

const FOLDERS = [{ color: "#ff0000", id: "f1", name: "Work" }];

vi.mock("@/shared/context/PagesContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/context/PagesContext")>()),
  usePages: () => ({
    clearSchedule: vi.fn(),
    createRecurrence: vi.fn(),
    deleteRecurrence: vi.fn(),
    folders: FOLDERS,
    recurrenceRules: [],
    scheduleOnce: vi.fn(),
    updatePage: vi.fn(),
    updateRecurrence: vi.fn(),
  }),
}));

function makePage(over: Partial<PageSummary> & { id: string }): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    syncState: null,
    tags: [],
    title: over.id,
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

// March 2026 (Monday-anchored) → Feb 23 … Apr 5.
const WEEKS: MonthCell[][] = buildMonthGrid(new Date(2026, 2, 15), 1, new Date(2026, 2, 15));

function renderGrid(
  pages: PageSummary[],
  handlers: Partial<{ onOpenDay: ReturnType<typeof vi.fn> }> = {}
) {
  const onOpenDay = handlers.onOpenDay ?? vi.fn();
  const onPageDoubleClick = vi.fn();
  renderWithProviders(
    <AppSettingsProvider>
      <TooltipProvider>
        <MonthGrid
          onOpenDay={onOpenDay}
          onPageDoubleClick={onPageDoubleClick}
          pages={pages}
          weeks={WEEKS}
        />
      </TooltipProvider>
    </AppSettingsProvider>
  );
  return { onOpenDay, onPageDoubleClick };
}

const cell = (label: string) => screen.getByLabelText(`Events on ${label}`);

describe("MonthGrid — grid rendering", () => {
  it("renders every cell of the padded grid with weekday headers", () => {
    renderGrid([]);
    expect(screen.getByRole("region", { name: "Month calendar" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Events on /)).toHaveLength(WEEKS.length * 7);
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
  });

  it("mutes the day number on out-of-month padding cells", () => {
    renderGrid([]);
    const padding = screen.getByRole("button", { name: "Go to Monday February 23, 2026" });
    const inMonth = screen.getByRole("button", { name: "Go to Sunday March 15, 2026" });
    expect(padding.className).toContain("text-muted-foreground");
    expect(inMonth.className).not.toContain("text-muted-foreground");
  });

  it("marks today's cell on its day number", () => {
    renderGrid([]);
    const today = screen.getByRole("button", { name: "Go to Sunday March 15, 2026" });
    expect(today.className).toContain("bg-primary");
  });
});

describe("MonthGrid — event chips", () => {
  it("renders a timed event with its start time in the cell it belongs to", () => {
    renderGrid([makePage({ id: "Standup", scheduledStart: "2026-03-10T09:00:00" })]);
    const chip = screen.getByRole("button", { name: "9 AM Standup" });
    expect(cell("Tuesday March 10, 2026")).toContainElement(chip);
  });

  it("colours a chip from its folder, matching the week grid's source", () => {
    renderGrid([makePage({ folderId: "f1", id: "Review", scheduledStart: "2026-03-10T09:00:00" })]);
    const chip = screen.getByRole("button", { name: /Review/ });
    expect(chip.getAttribute("style")).toContain("#ff0000");
  });

  it("draws a multi-day event as a chip in every covered cell", () => {
    renderGrid([
      makePage({ id: "Offsite", scheduledEnd: "2026-03-12", scheduledStart: "2026-03-10" }),
    ]);
    const chips = screen.getAllByRole("button", { name: "Offsite" });
    expect(chips).toHaveLength(3);
    expect(cell("Wednesday March 11, 2026")).toContainElement(chips[1]!);
  });

  it("shows events on padding cells too — they are real days of the grid", () => {
    renderGrid([makePage({ id: "Kickoff", scheduledStart: "2026-02-24" })]);
    expect(cell("Tuesday February 24, 2026")).toContainElement(
      screen.getByRole("button", { name: "Kickoff" })
    );
  });

  it("opens the page popover on a single click of a chip", () => {
    vi.useFakeTimers();
    try {
      renderGrid([makePage({ id: "Standup", scheduledStart: "2026-03-10T09:00:00" })]);
      fireEvent.click(screen.getByRole("button", { name: "9 AM Standup" }));
      // The chip discriminates click from double-click on a timer.
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByPlaceholderText("Untitled")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MonthGrid — overflow and click routing", () => {
  const crowd = Array.from({ length: 5 }, (_, i) =>
    makePage({ id: `Event ${i}`, scheduledStart: `2026-03-10T0${i + 1}:00:00` })
  );

  it("caps the chips and collapses the rest into a +K more pill", () => {
    renderGrid(crowd);
    expect(screen.getByRole("button", { name: "1 AM Event 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 AM Event 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "4 AM Event 3" })).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("routes a +K more click to that day", () => {
    const { onOpenDay } = renderGrid(crowd);
    fireEvent.click(screen.getByText("+2 more"));
    expect(onOpenDay).toHaveBeenCalledOnce();
    expect(onOpenDay.mock.calls[0]?.[0]).toEqual(new Date(2026, 2, 10));
  });

  it("routes a day-number click to that day", () => {
    const { onOpenDay } = renderGrid([]);
    fireEvent.click(screen.getByRole("button", { name: "Go to Wednesday March 4, 2026" }));
    expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 2, 4));
  });

  it("routes a click on a cell's empty space to that day", () => {
    const { onOpenDay } = renderGrid([]);
    fireEvent.click(cell("Thursday March 5, 2026"));
    expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 2, 5));
  });

  it("routes Enter on a focused cell to that day", () => {
    const { onOpenDay } = renderGrid([]);
    fireEvent.keyDown(cell("Thursday March 5, 2026"), { key: "Enter" });
    expect(onOpenDay).toHaveBeenCalledWith(new Date(2026, 2, 5));
  });

  it("does not navigate when a chip inside the cell is clicked", () => {
    const { onOpenDay } = renderGrid([
      makePage({ id: "Standup", scheduledStart: "2026-03-10T09:00:00" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "9 AM Standup" }));
    expect(onOpenDay).not.toHaveBeenCalled();
  });
});
