import { act, renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePanelResize } from "./usePanelResize";

afterEach(() => {
  // Ensure no drag listeners leak from a test that didn't end its own drag.
  document.dispatchEvent(new MouseEvent("mouseup"));
  localStorage.clear();
  vi.restoreAllMocks();
});

function makeMouseDown(handle: HTMLElement, clientX: number): ReactMouseEvent {
  return {
    clientX,
    currentTarget: handle,
    preventDefault: vi.fn(),
  } as unknown as ReactMouseEvent;
}

function dispatchMove(clientX: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}
function dispatchUp() {
  document.dispatchEvent(new MouseEvent("mouseup"));
}

describe("usePanelResize", () => {
  it("returns the default width when no value is stored", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 240, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    expect(result.current.width).toBe(240);
  });

  it("reads an existing persisted width from localStorage", () => {
    localStorage.setItem("pikos:test:width", JSON.stringify(320));
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 240, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    expect(result.current.width).toBe(320);
  });

  it("preventDefault is called on resize start", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    const preventDefault = vi.fn();
    const ev = {
      clientX: 100,
      currentTarget: handle,
      preventDefault,
    } as unknown as ReactMouseEvent;
    act(() => result.current.onResizeStart(ev));
    expect(preventDefault).toHaveBeenCalled();
  });

  it("sets data-dragging on the handle while resizing and clears on mouseup", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));

    expect(handle.dataset["dragging"]).toBe("true");

    act(() => dispatchUp());
    expect(handle.dataset["dragging"]).toBeUndefined();
  });

  it("updates width as the cursor moves right", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));

    act(() => dispatchMove(150)); // +50 → 250
    expect(result.current.width).toBe(250);
  });

  it("updates width as the cursor moves left", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 300, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 200)));

    act(() => dispatchMove(150)); // -50 → 250
    expect(result.current.width).toBe(250);
  });

  it("clamps width to the configured min", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 150, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 200)));

    // Move far left: would compute 150 + (50 - 200) = 0, clamps to 100
    act(() => dispatchMove(50));
    expect(result.current.width).toBe(100);
  });

  it("clamps width to the configured max", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 400, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));

    // Would compute 400 + 1000 = 1400; clamp to 500
    act(() => dispatchMove(1100));
    expect(result.current.width).toBe(500);
  });

  it("persists the resized width to localStorage", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));
    act(() => dispatchMove(180)); // +80 → 280

    expect(JSON.parse(localStorage.getItem("pikos:test:width")!)).toBe(280);
  });

  it("removes mousemove/mouseup listeners on mouseup", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));
    act(() => dispatchUp());

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain("mousemove");
    expect(removed).toContain("mouseup");
  });

  it("does not update width after mouseup (listener removed)", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");
    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));
    act(() => dispatchMove(150));
    const after = result.current.width;
    act(() => dispatchUp());

    // A "stray" mousemove after release should not change the width.
    act(() => dispatchMove(400));
    expect(result.current.width).toBe(after);
  });

  it("subsequent resize uses the latest width as the new baseline", () => {
    const { result } = renderHook(() =>
      usePanelResize({ defaultWidth: 200, max: 500, min: 100, storageKey: "pikos:test:width" })
    );
    const handle = document.createElement("div");

    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));
    act(() => dispatchMove(150)); // 200 → 250
    act(() => dispatchUp());

    act(() => result.current.onResizeStart(makeMouseDown(handle, 100)));
    act(() => dispatchMove(120)); // 250 + 20 → 270
    expect(result.current.width).toBe(270);
  });
});
