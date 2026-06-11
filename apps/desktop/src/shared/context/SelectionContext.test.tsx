import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useSelection } from "./SelectionContext";
import { computeRangeSelection } from "./selectionUtils";
import { useUI } from "./UIContext";

function setup() {
  return renderHookWithProviders(() => ({
    selection: useSelection(),
    ui: useUI(),
  }));
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

// ─── computeRangeSelection (pure helper) ────────────────────────────────────

describe("computeRangeSelection", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("selects range from anchor to target (forward)", () => {
    expect(computeRangeSelection(ids, "b", "d")).toEqual(new Set(["b", "c", "d"]));
  });

  it("selects range from anchor to target (backward)", () => {
    expect(computeRangeSelection(ids, "d", "b")).toEqual(new Set(["b", "c", "d"]));
  });

  it("selects single item when anchor equals target", () => {
    expect(computeRangeSelection(ids, "c", "c")).toEqual(new Set(["c"]));
  });

  it("returns empty set when anchor not in list", () => {
    expect(computeRangeSelection(ids, "x", "c")).toEqual(new Set());
  });

  it("returns empty set when target not in list", () => {
    expect(computeRangeSelection(ids, "a", "z")).toEqual(new Set());
  });

  it("selects full range (first to last)", () => {
    expect(computeRangeSelection(ids, "a", "e")).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });
});

// ─── Multi-select state ────────────────────────────────────────────────────

describe("multi-select", () => {
  it("starts with empty selection", () => {
    const { result } = setup();
    expect(result.current.selection.selectedPageIds.size).toBe(0);
    expect(result.current.selection.selectionAnchorId).toBeNull();
  });

  it("togglePageSelection adds and removes pages", () => {
    const { result } = setup();
    act(() => result.current.selection.togglePageSelection("p1"));
    expect(result.current.selection.selectedPageIds.has("p1")).toBe(true);
    expect(result.current.selection.selectionAnchorId).toBe("p1");

    act(() => result.current.selection.togglePageSelection("p2"));
    expect(result.current.selection.selectedPageIds.has("p1")).toBe(true);
    expect(result.current.selection.selectedPageIds.has("p2")).toBe(true);

    // Toggle off
    act(() => result.current.selection.togglePageSelection("p1"));
    expect(result.current.selection.selectedPageIds.has("p1")).toBe(false);
    expect(result.current.selection.selectedPageIds.has("p2")).toBe(true);
  });

  it("setRangeSelection selects a range using anchor", () => {
    const { result } = setup();
    const ids = ["a", "b", "c", "d", "e"];

    // Set anchor
    act(() => result.current.selection.setSelectionAnchorId("b"));
    // Range select to d
    act(() => result.current.selection.setRangeSelection(ids, "d"));

    expect(result.current.selection.selectedPageIds).toEqual(new Set(["b", "c", "d"]));
  });

  it("setRangeSelection with no anchor selects just the target", () => {
    const { result } = setup();
    act(() => result.current.selection.setRangeSelection(["a", "b", "c"], "b"));
    expect(result.current.selection.selectedPageIds).toEqual(new Set(["b"]));
    expect(result.current.selection.selectionAnchorId).toBe("b");
  });

  it("selectAll selects all provided IDs", () => {
    const { result } = setup();
    act(() => result.current.selection.selectAll(["x", "y", "z"]));
    expect(result.current.selection.selectedPageIds).toEqual(new Set(["x", "y", "z"]));
  });

  it("clearSelection resets selection and anchor", () => {
    const { result } = setup();
    act(() => result.current.selection.togglePageSelection("p1"));
    act(() => result.current.selection.togglePageSelection("p2"));
    act(() => result.current.selection.clearSelection());
    expect(result.current.selection.selectedPageIds.size).toBe(0);
    expect(result.current.selection.selectionAnchorId).toBeNull();
  });

  it("setActiveViewId clears selection", () => {
    const { result } = setup();
    act(() => result.current.selection.togglePageSelection("p1"));
    act(() => result.current.selection.setSelectionAnchorId("p1"));
    expect(result.current.selection.selectedPageIds.size).toBe(1);

    act(() => result.current.ui.setActiveViewId("today"));
    expect(result.current.selection.selectedPageIds.size).toBe(0);
    expect(result.current.selection.selectionAnchorId).toBeNull();
  });
});

// ─── useSelection outside provider ───────────────────────────────────────────

describe("useSelection outside provider", () => {
  it("throws when used outside SelectionProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSelection())).toThrow(
      "useSelection must be used within <SelectionProvider>"
    );
    spy.mockRestore();
  });
});
