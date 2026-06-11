// useHeightResize — vertical analog of usePanelResize. Covers clamping,
// persistence, and listener cleanup. The drag handle moves on the Y axis;
// height grows when the cursor moves down.

import { act, renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHeightResize } from "./useHeightResize";

afterEach(() => {
  // Drain any leaked drag listeners from a prior test.
  document.dispatchEvent(new MouseEvent("mouseup"));
  localStorage.clear();
  vi.restoreAllMocks();
});

function makeMouseDown(clientY: number): ReactMouseEvent {
  return {
    clientY,
    preventDefault: vi.fn(),
  } as unknown as ReactMouseEvent;
}

function dispatchMove(clientY: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientY }));
}
function dispatchUp() {
  document.dispatchEvent(new MouseEvent("mouseup"));
}

describe("useHeightResize", () => {
  it("returns the default height when no value is stored", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    expect(result.current.height).toBe(80);
  });

  it("reads an existing persisted height from localStorage", () => {
    localStorage.setItem("pikos:test:height", JSON.stringify(120));
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    expect(result.current.height).toBe(120);
  });

  it("preventDefault is called on resize start", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    const preventDefault = vi.fn();
    const ev = { clientY: 100, preventDefault } as unknown as ReactMouseEvent;
    act(() => result.current.onResizeStart(ev));
    expect(preventDefault).toHaveBeenCalled();
  });

  it("grows height as cursor moves down", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(100)));

    act(() => dispatchMove(140)); // +40 → 120
    expect(result.current.height).toBe(120);
  });

  it("shrinks height as cursor moves up", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 120, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(200)));

    act(() => dispatchMove(170)); // -30 → 90
    expect(result.current.height).toBe(90);
  });

  it("clamps height to min", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(200)));

    // Far above start: 80 + (50 - 200) = -70 → clamps to 40
    act(() => dispatchMove(50));
    expect(result.current.height).toBe(40);
  });

  it("clamps height to max", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 200, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(100)));

    // Far below: 200 + 1000 = 1200 → clamps to 240
    act(() => dispatchMove(1100));
    expect(result.current.height).toBe(240);
  });

  it("persists the resized height to localStorage", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(100)));
    act(() => dispatchMove(150));

    expect(JSON.parse(localStorage.getItem("pikos:test:height")!)).toBe(130);
  });

  it("removes mousemove/mouseup listeners on mouseup", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(makeMouseDown(100)));
    act(() => dispatchUp());

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain("mousemove");
    expect(removed).toContain("mouseup");
  });

  it("subsequent resize uses the latest height as the new baseline", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );

    act(() => result.current.onResizeStart(makeMouseDown(100)));
    act(() => dispatchMove(150)); // 80 + 50 → 130
    act(() => dispatchUp());

    act(() => result.current.onResizeStart(makeMouseDown(200)));
    act(() => dispatchMove(220)); // 130 + 20 → 150
    expect(result.current.height).toBe(150);
  });
});
