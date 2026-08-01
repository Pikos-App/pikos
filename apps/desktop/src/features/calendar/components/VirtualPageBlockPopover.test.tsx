// VirtualPageBlockPopover — Date is the one editable row on a virtual occurrence,
// and a synced series' schedule is provider-owned. Drag and resize are already
// suppressed on a locked block, so an unguarded picker here is the only path that
// could reach `ensure_rule_row_unlocked` and surface a raw Conflict.

import type { PageRecurrenceRule, VirtualOccurrence } from "@pikos/core";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { syncedScheduleLabel } from "@/shared/utils/syncedScheduleLabel";
import { renderWithProviders } from "@/test/renderWithProviders";

import { VirtualPageBlockPopover } from "./VirtualPageBlockPopover";

const mocks = vi.hoisted(() => ({
  recurrenceRules: [] as PageRecurrenceRule[],
  rescheduleVirtualOccurrence: vi.fn(),
}));

vi.mock("@/shared/context/PagesContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/context/PagesContext")>()),
  usePages: () => ({
    folders: [],
    recurrenceRules: mocks.recurrenceRules,
    rescheduleVirtualOccurrence: mocks.rescheduleVirtualOccurrence,
  }),
}));

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

function makeOccurrence(over: Partial<VirtualOccurrence>): VirtualOccurrence {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isVirtual: true,
    originalDate: "2099-01-05",
    priority: 0,
    ruleId: "r1",
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

function renderPopover(page: VirtualOccurrence) {
  return renderWithProviders(
    <AppSettingsProvider>
      <TooltipProvider>
        <VirtualPageBlockPopover onClose={vi.fn()} onSkip={vi.fn()} page={page} />
      </TooltipProvider>
    </AppSettingsProvider>
  );
}

describe("VirtualPageBlockPopover — schedule lock", () => {
  beforeEach(() => {
    mocks.recurrenceRules = [
      {
        id: "r1",
        pageId: "p1",
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2099-01-05T09:00:00",
      } as PageRecurrenceRule,
    ];
  });

  it("renders the synced schedule read-only on a locked series", () => {
    const page = makeOccurrence({
      scheduleLocked: true,
      syncState: "active",
      timezone: "Europe/Berlin",
    });
    renderPopover(page);

    const label = syncedScheduleLabel(page);
    expect(label).not.toBeNull();
    expect(screen.getByText(String(label))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Scheduled:/ })).not.toBeInTheDocument();
  });

  it("still offers the date picker on a native series", () => {
    renderPopover(makeOccurrence({}));

    expect(screen.getByRole("button", { name: /^Scheduled:/ })).toBeInTheDocument();
  });
});
