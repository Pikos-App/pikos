// ExternalCalendarItem — a synced calendar's sidebar row. Two contract points
// this app relies on: the context-menu Color submenu recolours via onColorChange
// with a Pikos-palette value (never the provider hex), and the row exposes NO
// rename affordance (the calendar's display name is authoritative).

import type { Folder } from "@pikos/core";
import { PALETTE_COLORS } from "@pikos/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ListSettingsProvider } from "@/shared/context/ListSettingsContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { ExternalCalendarItem } from "./ExternalCalendarItem";

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    color: "#539BF5",
    createdAt: "2026-01-01T00:00:00",
    id: "cal-1",
    isExternalCalendar: true,
    name: "Work Calendar",
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

function renderItem(props: Partial<Parameters<typeof ExternalCalendarItem>[0]> = {}) {
  const onColorChange = vi.fn();
  const onSelect = vi.fn();
  renderWithProviders(
    <ListSettingsProvider>
      <ExternalCalendarItem
        folder={makeFolder()}
        isActive={false}
        onColorChange={onColorChange}
        onSelect={onSelect}
        {...props}
      />
    </ListSettingsProvider>
  );
  return { onColorChange, onSelect };
}

describe("ExternalCalendarItem", () => {
  it("recolours via the Color submenu with a palette value", async () => {
    const { onColorChange } = renderItem();

    const [row] = screen.getAllByRole("button", { name: "Work Calendar" });
    fireEvent.contextMenu(row!);

    const colorTrigger = await screen.findByText("Color");
    fireEvent.pointerMove(colorTrigger);
    fireEvent.click(colorTrigger);

    const teal = PALETTE_COLORS.find((c) => c.label === "Teal")!;
    const tealItem = await screen.findByRole("menuitem", { name: "Teal" });
    fireEvent.click(tealItem);

    expect(onColorChange).toHaveBeenCalledWith(teal.value);
  });

  it("offers no rename affordance — no rename input is ever rendered", () => {
    renderItem();

    // Double-click is the inline-rename trigger on SidebarListItem; here the
    // handlers are NOOP, so it must not surface an editable field.
    for (const row of screen.getAllByRole("button", { name: "Work Calendar" })) {
      fireEvent.doubleClick(row);
    }

    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
