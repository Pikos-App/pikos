import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useCalendarDnD } from "./CalendarDnDContext";

function setup() {
  return renderHookWithProviders(() => useCalendarDnD());
}

describe("externalDragUpdater", () => {
  it("returns null when no updater is registered", () => {
    const { result } = setup();
    expect(result.current.callExternalDragUpdater(0, 0, undefined)).toBeNull();
  });

  it("calls the registered updater and returns its result", () => {
    const { result } = setup();
    const updater = vi.fn().mockReturnValue({ start: "2026-03-15T10:00:00" });

    act(() => result.current.registerExternalDragUpdater(updater));
    const out = result.current.callExternalDragUpdater(100, 200, "#ff0000", 3600000, "Test", false);

    expect(updater).toHaveBeenCalledWith(100, 200, "#ff0000", 3600000, "Test", false);
    expect(out).toEqual({ start: "2026-03-15T10:00:00" });
  });

  it("returns null after unregistering", () => {
    const { result } = setup();
    const updater = vi.fn().mockReturnValue({ start: "2026-03-15T10:00:00" });

    act(() => result.current.registerExternalDragUpdater(updater));
    act(() => result.current.registerExternalDragUpdater(null));

    expect(result.current.callExternalDragUpdater(0, 0, undefined)).toBeNull();
    expect(updater).not.toHaveBeenCalled();
  });
});

describe("isDraggingOverCalendar", () => {
  it("defaults to false", () => {
    const { result } = setup();
    expect(result.current.isDraggingOverCalendar).toBe(false);
  });

  it("toggles via setter", () => {
    const { result } = setup();
    act(() => result.current.setIsDraggingOverCalendar(true));
    expect(result.current.isDraggingOverCalendar).toBe(true);
    act(() => result.current.setIsDraggingOverCalendar(false));
    expect(result.current.isDraggingOverCalendar).toBe(false);
  });
});

describe("useCalendarDnD outside provider", () => {
  it("throws when used outside CalendarDnDProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useCalendarDnD())).toThrow(
      "useCalendarDnD must be used within <CalendarDnDProvider>"
    );
    spy.mockRestore();
  });
});
