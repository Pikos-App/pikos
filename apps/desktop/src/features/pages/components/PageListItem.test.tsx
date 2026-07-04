import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PageSummary } from "@pikos/core";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { PageListItem } from "./PageListItem";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-07-01T09:00:00Z",
    folderId: null,
    id: "page-1",
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

function renderItem(page: PageSummary, onRenameStart: () => void) {
  return renderWithProviders(
    <DndContext>
      <SortableContext items={[page.id]} strategy={verticalListSortingStrategy}>
        <PageListItem
          folders={[]}
          isActive={false}
          isRenaming={false}
          isSelected={false}
          onDelete={() => {}}
          onMoveToFolder={() => {}}
          onPriorityChange={() => {}}
          onRenameCancel={() => {}}
          onRenameCommit={() => {}}
          onRenameStart={onRenameStart}
          onSelect={() => {}}
          onToggleStatus={() => {}}
          page={page}
        />
      </SortableContext>
    </DndContext>
  );
}

describe("PageListItem rename gating", () => {
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

    expect(screen.getByText("Move to Folder")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });
});
