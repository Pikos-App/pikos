import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PageSummary } from "@pikos/core";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { PageListItem } from "./PageListItem";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-07-01T09:00:00Z",
    detachIsReversible: false,
    folderId: null,
    id: "page-1",
    isRecurring: false,
    priority: 0,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Weekly 1:1",
    updatedAt: "2026-07-01T09:00:00Z",
    ...overrides,
  };
}

interface ItemHandlers {
  menuActsOn?: number;
  onDelete?: () => void;
  onSendToDay?: (day: string) => void;
}

function renderItem(page: PageSummary, onRenameStart: () => void, handlers: ItemHandlers = {}) {
  return renderWithProviders(
    <DndContext>
      <SortableContext items={[page.id]} strategy={verticalListSortingStrategy}>
        <PageListItem
          folders={[]}
          isActive={false}
          isRenaming={false}
          isSelected={false}
          menuActsOn={handlers.menuActsOn ?? 1}
          onClearDate={() => {}}
          onDelete={handlers.onDelete ?? (() => {})}
          onMoveToFolder={() => {}}
          onPriorityChange={() => {}}
          onRenameCancel={() => {}}
          onRenameCommit={() => {}}
          onRenameStart={onRenameStart}
          onSelect={() => {}}
          onSendToDay={handlers.onSendToDay ?? (() => {})}
          onStopRepeating={() => {}}
          onToggleStatus={() => {}}
          page={page}
        />
      </SortableContext>
    </DndContext>
  );
}

describe("PageListItem mirror-lock gating", () => {
  // globals: false in vitest config → @testing-library's auto-cleanup never runs.
  afterEach(cleanup);

  it("double-click starts a rename on a native page", () => {
    const onRenameStart = vi.fn();
    renderItem(makePage(), onRenameStart);

    fireEvent.doubleClick(screen.getByLabelText("Weekly 1:1"));

    expect(onRenameStart).toHaveBeenCalledTimes(1);
  });

  it("double-click does nothing on a schedule-locked (synced) page", () => {
    const onRenameStart = vi.fn();
    renderItem(makePage({ scheduleLocked: true, syncState: "active" }), onRenameStart);

    fireEvent.doubleClick(screen.getByLabelText("Weekly 1:1"));

    expect(onRenameStart).not.toHaveBeenCalled();
  });

  it("context menu offers Rename for a native page", () => {
    renderItem(makePage(), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.getByText("Rename")).toBeInTheDocument();
  });

  it("context menu omits Rename for a schedule-locked (synced) page", () => {
    renderItem(makePage({ scheduleLocked: true, syncState: "active" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("context menu offers Move to Folder for a native page", () => {
    renderItem(makePage(), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.getByText("Move to folder")).toBeInTheDocument();
  });

  it("context menu omits Move to Folder for a schedule-locked (synced) page", () => {
    renderItem(makePage({ scheduleLocked: true, syncState: "active" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.queryByText("Move to folder")).not.toBeInTheDocument();
  });

  it("context menu offers No date for a scheduled native page", () => {
    renderItem(makePage({ scheduledStart: "2026-08-10" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "When" }));

    expect(screen.getByText("No date")).toBeInTheDocument();
  });

  it("context menu omits When for a schedule-locked (synced) page", () => {
    renderItem(
      makePage({ scheduledStart: "2026-08-10", scheduleLocked: true, syncState: "active" }),
      vi.fn()
    );

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.queryByText("When")).not.toBeInTheDocument();
  });

  it("context menu keeps Move to Folder on a detached page", () => {
    renderItem(makePage({ scheduleLocked: false, syncState: "detached" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.getByText("Move to folder")).toBeInTheDocument();
  });
});

describe("PageListItem menu", () => {
  afterEach(cleanup);

  function menuItems(): string[] {
    return within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
  }

  it("lists the commonest edits first and Rename and Delete last, as the phone does", () => {
    renderItem(makePage({ scheduledStart: "2026-08-10" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(menuItems()).toEqual([
      "Complete",
      "Today",
      "Tomorrow",
      "Priority",
      "When",
      "Move to folder",
      "Rename",
      "Export as Markdown",
      "Delete",
    ]);
  });

  it("offers Reopen on a done page", () => {
    renderItem(makePage({ status: "done" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(screen.getByRole("menuitem", { name: "Reopen" })).toBeInTheDocument();
  });

  it("keeps a repeating page on its rule's dates and offers to stop it", () => {
    renderItem(makePage({ isRecurring: true, scheduledStart: "2026-08-10" }), vi.fn());

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(menuItems()).toEqual([
      "Complete",
      "Priority",
      "Move to folder",
      "Stop repeating",
      "Rename",
      "Export as Markdown",
      "Delete",
    ]);
  });

  it("leaves a calendar's page only what is the user's", () => {
    renderItem(
      makePage({ scheduledStart: "2026-08-10", scheduleLocked: true, syncState: "active" }),
      vi.fn()
    );

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(menuItems()).toEqual(["Complete", "Priority", "Export as Markdown", "Delete"]);
  });

  it("sends the page to tomorrow", () => {
    const onSendToDay = vi.fn();
    renderItem(makePage(), vi.fn(), { onSendToDay });

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tomorrow" }));

    expect(onSendToDay).toHaveBeenCalledWith("send-tomorrow");
  });

  it("drops what names one page and counts the pages when it acts on a selection", () => {
    renderItem(makePage({ scheduledStart: "2026-08-10" }), vi.fn(), { menuActsOn: 3 });

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));

    expect(menuItems()).toEqual([
      "Today",
      "Tomorrow",
      "Priority",
      "When",
      "Move to folder",
      "Delete 3 pages",
    ]);
  });

  it("hands Delete to the list, which decides whether to ask", () => {
    const onDelete = vi.fn();
    renderItem(makePage({ isRecurring: true, scheduledStart: "2026-08-10" }), vi.fn(), {
      onDelete,
    });

    fireEvent.contextMenu(screen.getByLabelText("Weekly 1:1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

// The row and the calendar block draw the same event, so they have to agree.
// Reading the stored wall-clock made a London 5pm meeting read as still to come
// long after it ran at 9am here, and put a Tokyo morning on the wrong day.
// Vitest pins TZ=UTC, so these offsets are relative to UTC.
describe("PageListItem — a synced event shows the viewer's time", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function syncedPage(start: string, timezone: string): PageSummary {
    return makePage({
      detachIsReversible: false,
      scheduledStart: start,
      scheduleLocked: true,
      syncState: "active",
      timezone,
    });
  }

  function dateLabel(): string {
    return screen.getByRole("button", { name: /Toggle date format/ }).textContent ?? "";
  }

  it("files a Tokyo morning under the day it happens here", () => {
    // 06:00 on the 8th in Tokyo (UTC+9) is 21:00 on the 7th in UTC.
    renderItem(syncedPage("2026-08-08T06:00:00", "Asia/Tokyo"), vi.fn());

    expect(dateLabel()).toContain("Aug 7");
  });

  it("shows a New York standup at the hour it runs here", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T09:00:00Z"));
    // 11:00 in New York (UTC-4 in August) is 15:00 UTC.
    renderItem(syncedPage("2026-08-07T11:00:00", "America/New_York"), vi.fn());

    expect(dateLabel()).toContain("3:00pm");
  });

  it("leaves a page with no zone on its stored time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T09:00:00Z"));
    renderItem(makePage({ scheduledStart: "2026-08-07T11:00:00" }), vi.fn());

    expect(dateLabel()).toContain("11:00am");
  });

  it("says on hover that its calendar sets the date, which is why a bulk move leaves it", () => {
    renderItem(syncedPage("2026-08-07T11:00:00", "America/New_York"), vi.fn());

    expect(screen.getByTitle(/Its calendar sets this date/)).toBeTruthy();
  });

  it("says nothing about a calendar on a page the user dates", () => {
    renderItem(makePage({ scheduledStart: "2026-08-07T11:00:00" }), vi.fn());

    expect(screen.queryByTitle(/Its calendar sets this date/)).toBeNull();
  });
});
