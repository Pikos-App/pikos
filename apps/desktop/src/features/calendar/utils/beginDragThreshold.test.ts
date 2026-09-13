import { afterEach, describe, expect, it, vi } from "vitest";

import { beginDragThreshold } from "./beginDragThreshold";

function move(clientX: number, clientY: number) {
  window.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, isPrimary: true }));
}

function release() {
  window.dispatchEvent(new PointerEvent("pointerup", { isPrimary: true }));
}

function cancel() {
  window.dispatchEvent(new PointerEvent("pointercancel", { isPrimary: true }));
}

afterEach(() => {
  document.documentElement.className = "";
  release();
});

describe("beginDragThreshold", () => {
  it("stays quiet until the cursor leaves the threshold box", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(100, 100, { onCrossed });

    move(104, 104); // exactly at DRAG_THRESHOLD — not past it
    expect(onCrossed).not.toHaveBeenCalled();

    move(105, 100);
    expect(onCrossed).toHaveBeenCalledTimes(1);
  });

  it("crosses on vertical movement too, then disconnects", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(0, 0, { onCrossed });

    move(0, -20);
    move(0, 200);
    expect(onCrossed).toHaveBeenCalledTimes(1);
  });

  it("sets the body cursor on pointerdown and clears it on a click-release", () => {
    beginDragThreshold(0, 0, { bodyCursor: "dragging-grab", onCrossed: vi.fn() });
    expect(document.documentElement.classList.contains("dragging-grab")).toBe(true);

    release();
    expect(document.documentElement.classList.contains("dragging-grab")).toBe(false);
  });

  it("leaves the body cursor to the caller once the drag starts", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(0, 0, { bodyCursor: "dragging-resize", onCrossed });

    move(50, 0);
    release();
    expect(onCrossed).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("dragging-resize")).toBe(true);
  });

  it("ignores a release with no listeners left to tear down", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(0, 0, { onCrossed });

    release();
    move(500, 500);
    expect(onCrossed).not.toHaveBeenCalled();
  });

  it("ignores a non-primary pointer so a second finger can't cross the threshold", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(0, 0, { onCrossed });

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 500, isPrimary: false }));
    expect(onCrossed).not.toHaveBeenCalled();
  });

  it("tears down on pointercancel like a release below the threshold", () => {
    const onCrossed = vi.fn();
    beginDragThreshold(0, 0, { bodyCursor: "dragging-grab", onCrossed });

    cancel();
    expect(document.documentElement.classList.contains("dragging-grab")).toBe(false);

    move(500, 500);
    expect(onCrossed).not.toHaveBeenCalled();
  });
});
