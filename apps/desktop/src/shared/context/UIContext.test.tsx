import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIProvider, useUI } from "./UIContext";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <UIProvider>{children}</UIProvider>;
}

function setup() {
  return renderHook(() => useUI(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

// ─── setActivePage ──────────────────────────────────────────────────────────

describe("setActivePage", () => {
  it("accepts null to clear", () => {
    const { result } = setup();
    act(() => result.current.setActivePage("some-id"));
    expect(result.current.activePageId).toBe("some-id");
    act(() => result.current.setActivePage(null));
    expect(result.current.activePageId).toBeNull();
  });

  it("accepts a string ID", () => {
    const { result } = setup();
    act(() => result.current.setActivePage("page-123"));
    expect(result.current.activePageId).toBe("page-123");
  });

  it("accepts a PageSummary-like object and extracts id", () => {
    const { result } = setup();
    act(() => result.current.setActivePage({ id: "page-456" } as never));
    expect(result.current.activePageId).toBe("page-456");
  });
});

// ─── setRightPanel — smart panel switching ──────────────────────────────────

describe("setRightPanel — smart panel switching", () => {
  it("switching to calendar saves current page and clears activePageId", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    expect(result.current.activePageId).toBe("page-1");

    act(() => result.current.setRightPanel("calendar"));
    expect(result.current.rightPanel).toBe("calendar");
    expect(result.current.activePageId).toBeNull();
    expect(result.current.lastEditorPageId).toBe("page-1");
  });

  it("switching back to editor restores lastEditorPageId", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("calendar"));
    act(() => result.current.setRightPanel("editor"));

    expect(result.current.rightPanel).toBe("editor");
    expect(result.current.activePageId).toBe("page-1");
  });

  it("switching calendar→calendar is a no-op (no double save)", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("calendar"));
    // Now activePageId is null, lastEditorPageId is "page-1"
    act(() => result.current.setRightPanel("calendar"));
    // Should not save null over "page-1"
    expect(result.current.lastEditorPageId).toBe("page-1");
  });

  it("switching editor→editor is a no-op", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("editor"));
    // No change
    expect(result.current.activePageId).toBe("page-1");
  });
});

// ─── openPage ─────────────────────────────────────────────────────────────────

describe("openPage", () => {
  it("sets activePageId and switches to editor panel atomically", () => {
    const { result } = setup();

    // Start on calendar
    act(() => result.current.setRightPanel("calendar"));
    expect(result.current.rightPanel).toBe("calendar");

    act(() => result.current.openPage("page-99"));
    expect(result.current.activePageId).toBe("page-99");
    expect(result.current.rightPanel).toBe("editor");
  });

  it("accepts a PageSummary-like object", () => {
    const { result } = setup();
    act(() => result.current.openPage({ id: "page-obj" } as never));
    expect(result.current.activePageId).toBe("page-obj");
  });
});

// ─── getSortMode / setSortMode ──────────────────────────────────────────────

describe("sort modes", () => {
  it("defaults to 'manual' for unknown viewId", () => {
    const { result } = setup();
    expect(result.current.getSortMode("unknown-view")).toBe("manual");
  });

  it("persists sort mode per viewId", () => {
    const { result } = setup();
    act(() => result.current.setSortMode("inbox", "date"));
    expect(result.current.getSortMode("inbox")).toBe("date");
    expect(result.current.getSortMode("today")).toBe("manual"); // other views unaffected
  });
});

// ─── sidebarCollapsed ──────────────────────────────────────────────────────

describe("sidebarCollapsed", () => {
  it("defaults to false", () => {
    const { result } = setup();
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("toggles via setter", () => {
    const { result } = setup();
    act(() => result.current.setSidebarCollapsed(true));
    expect(result.current.sidebarCollapsed).toBe(true);
  });
});

// ─── openDialog ─────────────────────────────────────────────────────────────

describe("openDialog", () => {
  it("defaults to null", () => {
    const { result } = setup();
    expect(result.current.openDialog).toBeNull();
  });

  it("sets and clears dialog", () => {
    const { result } = setup();
    act(() => result.current.setOpenDialog("quick-add"));
    expect(result.current.openDialog).toBe("quick-add");
    act(() => result.current.setOpenDialog(null));
    expect(result.current.openDialog).toBeNull();
  });
});

// ─── referenceDate ──────────────────────────────────────────────────────────

describe("referenceDate", () => {
  it("returns a valid Date", () => {
    const { result } = setup();
    expect(result.current.referenceDate).toBeInstanceOf(Date);
    expect(Number.isNaN(result.current.referenceDate.getTime())).toBe(false);
  });

  it("updates when setReferenceDate is called", () => {
    const { result } = setup();
    const target = new Date(2026, 5, 15);
    act(() => result.current.setReferenceDate(target));
    expect(result.current.referenceDate.toISOString()).toBe(target.toISOString());
  });
});

// ─── externalDragUpdater ────────────────────────────────────────────────────

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

// ─── useUI outside provider ─────────────────────────────────────────────────

describe("useUI outside provider", () => {
  it("throws when used outside UIProvider", () => {
    // Suppress console.error from React for the expected error
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useUI())).toThrow("useUI must be used within <UIProvider>");
    spy.mockRestore();
  });
});
