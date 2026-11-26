import type { Folder } from "@pikos/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { FolderChip } from "./FolderChip";

function makeFolder(overrides: Partial<Folder>): Folder {
  return {
    color: null,
    createdAt: "2026-01-01T00:00:00",
    id: "f-1",
    isExternalCalendar: false,
    name: "Folder",
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

describe("FolderChip", () => {
  it("lists each folder with the colour dot the sidebar shows for it", async () => {
    const folders = [
      makeFolder({ color: "#D9577A", id: "f-work", name: "Work" }),
      makeFolder({ color: "#539BF5", id: "f-home", name: "Home", sortOrder: 1 }),
    ];
    renderWithProviders(<FolderChip folders={folders} onChange={() => {}} value={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Folder: Inbox" }));

    const work = await screen.findByRole("button", { name: "Work" });
    const home = screen.getByRole("button", { name: "Home" });
    expect(within(work).getByTestId("folder-color")).toHaveStyle({
      backgroundColor: "#D9577A",
    });
    expect(within(home).getByTestId("folder-color")).toHaveStyle({
      backgroundColor: "#539BF5",
    });
  });
});
