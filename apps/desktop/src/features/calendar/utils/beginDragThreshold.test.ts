import { afterEach, describe, expect, it, vi } from "vitest";

import { beginDragThreshold } from "./beginDragThreshold";

function move(clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
}

function release() {
  window.dispatchEvent(new MouseEvent("mouseup"));
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

  it("sets the body cursor on mousedown and clears it on a click-release", () => {
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
});
