// RecurrencePopover — same-freq re-click guard.
// A "3rd Friday" monthly rule (BYDAY=FR;BYSETPOS=3) is a custom shape, so the
// custom editor's freq menu is visible. Re-clicking the already-selected freq
// must be a no-op: optionsForFreq's MONTHLY whitelist keeps only bymonthday, so
// a re-emit would silently strip BYDAY/BYSETPOS. A different freq still emits.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";

import { RecurrencePopover } from "./RecurrencePopover";

afterEach(cleanup);

function renderPopover(onChange: (rrule: string | null) => void) {
  return render(
    <AppSettingsProvider>
      <TooltipProvider>
        <RecurrencePopover
          anchorDate="2026-07-06T09:00:00" // a Monday — keeps "3rd Friday" a custom shape
          onChange={onChange}
          rrule="FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3"
        />
      </TooltipProvider>
    </AppSettingsProvider>
  );
}

function openFreqMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Recurrence:/ }));
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
}

describe("RecurrencePopover freq re-click", () => {
  it("re-clicking the current freq is a no-op", () => {
    const onChange = vi.fn();
    renderPopover(onChange);

    openFreqMenu();
    // Two "Month" buttons now: the menu trigger and the menu option. The option
    // is the last in DOM order (nested portal appended after the trigger).
    const monthButtons = screen.getAllByRole("button", { name: "Month" });
    const menuOption = monthButtons[monthButtons.length - 1];
    if (!menuOption) throw new Error("freq menu did not render a Month option");
    fireEvent.click(menuOption);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("selecting a different freq still emits", () => {
    const onChange = vi.fn();
    renderPopover(onChange);

    openFreqMenu();
    fireEvent.click(screen.getByRole("button", { name: "Week" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("FREQ=WEEKLY"));
  });
});

describe("RecurrencePopover BYDAY-ordinal lock", () => {
  // A BYDAY ordinal (BYDAY=3TU) is dropped by the RecurrenceOptions round-trip, so
  // editing it here would silently degrade "3rd Tuesday" to a plain weekly. The
  // chip is locked read-only instead. (Contrast: the BYSETPOS form above round-
  // trips cleanly and stays editable — proven by the freq-menu tests.)
  it("does not open the editor for a BYDAY-ordinal rule", () => {
    const onChange = vi.fn();
    render(
      <AppSettingsProvider>
        <TooltipProvider>
          <RecurrencePopover
            anchorDate="2026-07-06T09:00:00"
            onChange={onChange}
            rrule="FREQ=MONTHLY;BYDAY=3TU"
          />
        </TooltipProvider>
      </AppSettingsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /Recurrence:/ }));

    expect(screen.queryByRole("button", { name: "Month" })).toBeNull();
    expect(screen.queryByText("Stop repeating")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
