import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";

import { RecurrencePopover } from "./RecurrencePopover";

afterEach(cleanup);

// A Monday anchor keeps "on Fridays" / "on the 15th" off the generated presets.
// It is also July's *first* Monday, so the by-position preset reads "1st Mon".
const ANCHOR = "2026-07-06T09:00:00";
// July 2026's last Monday — in the final seven days, so the ordinal is -1, not 4.
const LAST_MONDAY = "2026-07-27T09:00:00";

const MONTHLY_ON_FRIDAYS = "FREQ=MONTHLY;BYDAY=FR";
const MONTHLY_ON_THE_15TH = "FREQ=MONTHLY;BYMONTHDAY=15";
const MONTHLY_ON_THE_LAST_DAY = "FREQ=MONTHLY;BYMONTHDAY=-1";
const THIRD_FRIDAY_BYSETPOS = "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3";
const THIRD_TUESDAY_BYDAY = "FREQ=MONTHLY;BYDAY=3TU";
const FIRST_MONDAY_BYDAY = "FREQ=MONTHLY;BYDAY=1MO";
const FIFTEENTH_OF_MARCH = "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15";

// Outside the engine's envelope, so no round-trip can carry them.
const LOSSY_RULES = [
  ["BYWEEKNO", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"],
  ["sub-daily BY* term", "FREQ=DAILY;BYHOUR=9"],
] as const;

const CARRIED_RULES = [
  ["BYDAY ordinal", THIRD_TUESDAY_BYDAY, "BYDAY=3TU"],
  ["BYMONTH", FIFTEENTH_OF_MARCH, "BYMONTH=3"],
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

describe("RecurrencePopover degrade lock", () => {
  it.each(LOSSY_RULES)("does not open the editor for a %s rule", (_term, rrule) => {
    const onChange = vi.fn();
    renderPopover(rrule, onChange);

    openTrigger();

    expect(screen.queryByRole("button", { name: "Month" })).toBeNull();
    expect(screen.queryByText("Stop repeating")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(LOSSY_RULES)("explains the lock on a %s rule", async (_term, rrule) => {
    renderPopover(rrule, vi.fn());

    fireEvent.pointerMove(screen.getByRole("button", { name: /Recurrence:/ }), {
      pointerType: "mouse",
    });

    expect((await screen.findAllByText("This repeat can't be edited here")).length).toBeGreaterThan(
      0
    );
  });

  it("opens the editor for a BYSETPOS rule, which round-trips losslessly", () => {
    renderPopover(THIRD_FRIDAY_BYSETPOS, vi.fn());

    openTrigger();

    expect(screen.getByText("Stop repeating")).toBeInTheDocument();
  });

  it.each(CARRIED_RULES)("opens the editor for a %s rule, which round-trips", (_term, rrule) => {
    renderPopover(rrule, vi.fn());

    openTrigger();

    expect(screen.getByText("Stop repeating")).toBeInTheDocument();
  });
});

describe("RecurrencePopover preset matching", () => {
  it("leaves plain Monthly inactive for a monthly-on-the-last-day rule", () => {
    renderPopover(MONTHLY_ON_THE_LAST_DAY, vi.fn());

    openTrigger();

    expect(screen.getByRole("button", { name: "Monthly, 6th" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("authors a by-position rule from the anchor's place in its month", () => {
    const onChange = vi.fn();
    renderPopover("FREQ=DAILY", onChange);

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Monthly, 1st Mon" }));

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("BYDAY=1MO"));
  });

  it("offers the last weekday, not a 5th, for a month-end anchor", () => {
    const onChange = vi.fn();
    render(
      <AppSettingsProvider>
        <TooltipProvider>
          <RecurrencePopover anchorDate={LAST_MONDAY} onChange={onChange} rrule="FREQ=DAILY" />
        </TooltipProvider>
      </AppSettingsProvider>
    );

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Monthly, last Mon" }));

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("BYDAY=-1MO"));
  });

  it("marks the by-position preset active for a provider rule that matches it", () => {
    renderPopover(FIRST_MONDAY_BYDAY, vi.fn());

    openTrigger();

    expect(screen.getByRole("button", { name: "Monthly, 1st Mon" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Monthly, 6th" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("re-clicking the active preset is a no-op", () => {
    const onChange = vi.fn();
    renderPopover("FREQ=DAILY", onChange);

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));

    expect(onChange).not.toHaveBeenCalled();
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

  // The Ends handler dropping BYSETPOS is what motivated locking it in the first place;
  // unlocking is only safe while this holds.
  it("keeps a BYSETPOS position when the end condition changes", () => {
    const onChange = vi.fn();
    renderPopover(THIRD_FRIDAY_BYSETPOS, onChange);

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "After" }));

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("BYSETPOS=3"));
  });

  it.each(CARRIED_RULES)("keeps %s when the end condition changes", (_term, rrule, kept) => {
    const onChange = vi.fn();
    renderPopover(rrule, onChange);

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "After" }));

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining(kept));
  });
});
