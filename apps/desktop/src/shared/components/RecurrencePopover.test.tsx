import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";

import { RecurrencePopover } from "./RecurrencePopover";

afterEach(cleanup);

// A Monday anchor keeps "on Fridays" / "on the 15th" off the generated presets.
const ANCHOR = "2026-07-06T09:00:00";

const MONTHLY_ON_FRIDAYS = "FREQ=MONTHLY;BYDAY=FR";
const MONTHLY_ON_THE_15TH = "FREQ=MONTHLY;BYMONTHDAY=15";
const THIRD_FRIDAY_BYSETPOS = "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3";
const THIRD_TUESDAY_BYDAY = "FREQ=MONTHLY;BYDAY=3TU";

const ORDINAL_SPELLINGS = [
  ["BYDAY ordinal", THIRD_TUESDAY_BYDAY],
  ["BYSETPOS", THIRD_FRIDAY_BYSETPOS],
] as const;

function renderPopover(rrule: string, onChange: (rrule: string | null) => void) {
  return render(
    <AppSettingsProvider>
      <TooltipProvider>
        <RecurrencePopover anchorDate={ANCHOR} onChange={onChange} rrule={rrule} />
      </TooltipProvider>
    </AppSettingsProvider>
  );
}

function openTrigger() {
  fireEvent.click(screen.getByRole("button", { name: /Recurrence:/ }));
}

function openFreqMenu() {
  openTrigger();
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
}

describe("RecurrencePopover freq re-click", () => {
  it("re-clicking the current freq is a no-op", () => {
    const onChange = vi.fn();
    renderPopover(MONTHLY_ON_FRIDAYS, onChange);

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
    renderPopover(MONTHLY_ON_FRIDAYS, onChange);

    openFreqMenu();
    fireEvent.click(screen.getByRole("button", { name: "Week" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("FREQ=WEEKLY"));
  });
});

describe("RecurrencePopover ordinal-cadence lock", () => {
  it.each(ORDINAL_SPELLINGS)("does not open the editor for a %s rule", (_spelling, rrule) => {
    const onChange = vi.fn();
    renderPopover(rrule, onChange);

    openTrigger();

    expect(screen.queryByRole("button", { name: "Month" })).toBeNull();
    expect(screen.queryByText("Stop repeating")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(ORDINAL_SPELLINGS)("explains the lock on a %s rule", async (_spelling, rrule) => {
    renderPopover(rrule, vi.fn());

    fireEvent.pointerMove(screen.getByRole("button", { name: /Recurrence:/ }), {
      pointerType: "mouse",
    });

    expect((await screen.findAllByText("This repeat can't be edited here")).length).toBeGreaterThan(
      0
    );
  });
});

describe("RecurrencePopover Ends editor", () => {
  it("keeps a BYMONTHDAY cadence when the end condition changes", () => {
    const onChange = vi.fn();
    renderPopover(MONTHLY_ON_THE_15TH, onChange);

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "After" }));

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("BYMONTHDAY=15"));
  });
});
