import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";

import { DateTimePicker } from "./DateTimePicker";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pickNextWeekOn(now: string) {
  vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
  const onChange = vi.fn();
  render(
    <AppSettingsProvider>
      <DateTimePicker onChange={onChange} value={null} />
    </AppSettingsProvider>
  );

  fireEvent.click(screen.getByRole("button", { name: "Set schedule" }));
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));

  return onChange;
}

describe("DateTimePicker Next week", () => {
  it("picks the Monday after when today is a Monday", () => {
    expect(pickNextWeekOn("2026-10-19T09:00:00")).toHaveBeenCalledWith("2026-10-26");
  });

  it("picks the next day when today is a Sunday", () => {
    expect(pickNextWeekOn("2026-10-18T09:00:00")).toHaveBeenCalledWith("2026-10-19");
  });
});
