// PageBlockPopover — read-only mirror metadata on a synced (locked) event, and
// the reminder bell's one real boundary (timed vs all-day, on every origin).

import type { PageRecurrenceRule, PageSummary } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { PageBlockPopover } from "./PageBlockPopover";

const mocks = vi.hoisted(() => ({ recurrenceRules: [] as PageRecurrenceRule[] }));

vi.mock("@/shared/context/PagesContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/context/PagesContext")>()),
  usePages: () => ({
    clearSchedule: vi.fn(),
    createFolder: vi.fn(),
    createRecurrence: vi.fn(),
    deleteRecurrence: vi.fn(),
    folders: [],
    maybeToggleRecurringOccurrence: vi.fn(),
    recurrenceRules: mocks.recurrenceRules,
    scheduleOnce: vi.fn(),
    uncompleteRecurringOrFlip: vi.fn(),
    updatePage: vi.fn(),
    updateRecurrence: vi.fn(),
  }),
}));

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

beforeEach(() => {
  mocks.recurrenceRules = [];
});

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

  // The lock icon is the only thing explaining the read-only title — the title
  // itself is deliberately not a tooltip trigger, so nothing else says why.
  it("marks a locked title with the read-only lock hint", () => {
    renderPopover(makePage({ scheduleLocked: true, syncState: "active" }));
    expect(screen.getByRole("img", { name: /are read-only for synced pages/ })).toBeInTheDocument();
  });

  it("leaves an unlocked title unmarked", () => {
    renderPopover(makePage({}));
    expect(
      screen.queryByRole("img", { name: /are read-only for synced pages/ })
    ).not.toBeInTheDocument();
  });

  it("names the position of a locked BYSETPOS series", () => {
    mocks.recurrenceRules = [
      { id: "r1", pageId: "p1", rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3" } as PageRecurrenceRule,
    ];
    renderPopover(makePage({ scheduleLocked: true, syncState: "active" }));
    expect(screen.getByText("every month on the 3rd Friday")).toBeInTheDocument();
  });
});

describe("PageBlockPopover — reminder bell", () => {
  const rule = { id: "r1", pageId: "p1" } as PageRecurrenceRule;

  it("offers reminders on a locked timed recurring series", () => {
    mocks.recurrenceRules = [rule];
    renderPopover(
      makePage({ scheduleLocked: true, syncState: "active", timezone: "Europe/Berlin" })
    );
    expect(screen.getByLabelText("Page reminders")).toBeInTheDocument();
  });

  it("hides the bell on a locked all-day recurring series", () => {
    mocks.recurrenceRules = [rule];
    renderPopover(
      makePage({
        scheduledEnd: "2099-01-06",
        scheduledStart: "2099-01-05",
        scheduleLocked: true,
        syncState: "active",
      })
    );
    expect(screen.queryByLabelText("Page reminders")).not.toBeInTheDocument();
  });
});
