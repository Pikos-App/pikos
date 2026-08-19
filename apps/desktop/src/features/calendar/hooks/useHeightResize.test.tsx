// useHeightResize — vertical analog of usePanelResize. Covers clamping,
// persistence, and listener cleanup. The drag handle moves on the Y axis;
// height grows when the pointer moves down.
//
// Pointer events, not mouse events: the hook takes pointer capture on the
// handle and listens there, so the test dispatches at that element. jsdom has
// no pointer capture — src/test/setup.ts stands the three methods in.

import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHeightResize } from "./useHeightResize";

const POINTER_ID = 1;
let handle: HTMLElement;

afterEach(() => {
  // Drain any leaked drag listeners from a prior test.
  handle?.dispatchEvent(pointer("pointerup"));
  localStorage.clear();
  vi.restoreAllMocks();
});

function pointer(type: string, clientY = 0): PointerEvent {
  return new PointerEvent(type, { clientY, isPrimary: true, pointerId: POINTER_ID });
}

function press(clientY: number): ReactPointerEvent<HTMLElement> {
  handle = document.createElement("div");
  return {
    clientY,
    currentTarget: handle,
    isPrimary: true,
    pointerId: POINTER_ID,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLElement>;
}

function dispatchMove(clientY: number) {
  handle.dispatchEvent(pointer("pointermove", clientY));
}
function dispatchUp() {
  handle.dispatchEvent(pointer("pointerup"));
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
    const ev = { ...press(100), preventDefault } as unknown as ReactPointerEvent<HTMLElement>;
    act(() => result.current.onResizeStart(ev));
    expect(preventDefault).toHaveBeenCalled();
  });

  it("takes pointer capture on the handle so the drag survives leaving it", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    const ev = press(100);
    const capture = vi.spyOn(ev.currentTarget, "setPointerCapture");
    act(() => result.current.onResizeStart(ev));
    expect(capture).toHaveBeenCalledWith(POINTER_ID);
  });

  it("ignores a non-primary pointer so a second finger can't hijack the drag", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    const ev = { ...press(100), isPrimary: false } as unknown as ReactPointerEvent<HTMLElement>;
    act(() => result.current.onResizeStart(ev));
    act(() => dispatchMove(140));
    expect(result.current.height).toBe(80);
  });

  it("grows height as the pointer moves down", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(100)));

    act(() => dispatchMove(140)); // +40 → 120
    expect(result.current.height).toBe(120);
  });

  it("shrinks height as the pointer moves up", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 120, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(200)));

    act(() => dispatchMove(170)); // -30 → 90
    expect(result.current.height).toBe(90);
  });

  it("clamps height to min", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(200)));

    // Far above start: 80 + (50 - 200) = -70 → clamps to 40
    act(() => dispatchMove(50));
    expect(result.current.height).toBe(40);
  });

  it("clamps height to max", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 200, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(100)));

    // Far below: 200 + 1000 = 1200 → clamps to 240
    act(() => dispatchMove(1100));
    expect(result.current.height).toBe(240);
  });

  it("persists the resized height to localStorage", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(100)));
    act(() => dispatchMove(150));

    expect(JSON.parse(localStorage.getItem("pikos:test:height")!)).toBe(130);
  });

  it("removes the pointer listeners on release", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    const ev = press(100);
    const removeSpy = vi.spyOn(ev.currentTarget, "removeEventListener");
    act(() => result.current.onResizeStart(ev));
    act(() => dispatchUp());

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain("pointermove");
    expect(removed).toContain("pointerup");
    expect(removed).toContain("pointercancel");
  });

  it("stops tracking when the platform cancels the gesture", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );
    act(() => result.current.onResizeStart(press(100)));
    act(() => dispatchMove(150)); // 80 + 50 → 130
    act(() => {
      handle.dispatchEvent(pointer("pointercancel"));
    });
    act(() => dispatchMove(300));

    // The last committed height stands; the cancelled move is ignored.
    expect(result.current.height).toBe(130);
  });

  it("subsequent resize uses the latest height as the new baseline", () => {
    const { result } = renderHook(() =>
      useHeightResize({ defaultHeight: 80, max: 240, min: 40, storageKey: "pikos:test:height" })
    );

    act(() => result.current.onResizeStart(press(100)));
    act(() => dispatchMove(150)); // 80 + 50 → 130
    act(() => dispatchUp());

    act(() => result.current.onResizeStart(press(200)));
    act(() => dispatchMove(220)); // 130 + 20 → 150
    expect(result.current.height).toBe(150);
  });
});
