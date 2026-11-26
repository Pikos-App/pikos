import type { Folder } from "@pikos/core";
import { PALETTE_COLORS } from "@pikos/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InterfaceSettingsProvider } from "@/shared/context/InterfaceSettingsContext";
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
    <InterfaceSettingsProvider>
      <ExternalCalendarItem
        folder={makeFolder()}
        isActive={false}
        onColorChange={onColorChange}
        onSelect={onSelect}
        {...props}
      />
    </InterfaceSettingsProvider>
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
    const tealItem = await screen.findByRole("menuitemradio", { name: "Teal" });
    fireEvent.click(tealItem);

    expect(onColorChange).toHaveBeenCalledWith(teal.value);
  });

  it("marks the calendar's current colour, and only that one, in the Color submenu", async () => {
    const blue = PALETTE_COLORS.find((c) => c.label === "Blue")!;
    renderItem({ folder: makeFolder({ color: blue.value }) });

    const [row] = screen.getAllByRole("button", { name: "Work Calendar" });
    fireEvent.contextMenu(row!);
    const colorTrigger = await screen.findByText("Color");
    fireEvent.pointerMove(colorTrigger);
    fireEvent.click(colorTrigger);

    const checked = (await screen.findAllByRole("menuitemradio")).filter(
      (item) => item.getAttribute("aria-checked") === "true"
    );
    expect(checked.map((item) => item.textContent)).toEqual(["Blue"]);
  });

  it("offers no rename affordance — no rename input is ever rendered", () => {
    renderItem();

    for (const row of screen.getAllByRole("button", { name: "Work Calendar" })) {
      fireEvent.doubleClick(row);
    }

    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
