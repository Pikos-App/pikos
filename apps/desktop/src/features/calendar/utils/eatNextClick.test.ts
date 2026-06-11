import { afterEach, describe, expect, it, vi } from "vitest";

import { eatNextClick } from "./eatNextClick";

function dispatchClick(): { stopped: boolean } {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  const result = { stopped: false };
  const orig = ev.stopPropagation.bind(ev);
  vi.spyOn(ev, "stopPropagation").mockImplementation(() => {
    result.stopped = true;
    orig();
  });
  window.dispatchEvent(ev);
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("eatNextClick", () => {
  it("swallows the drag's synthetic click (fires within the window)", () => {
    let t = 1000;
    eatNextClick(() => t);
    t = 1050; // 50ms after the drag mouseup — the synthetic click
    expect(dispatchClick().stopped).toBe(true);
  });

  it("lets a later deliberate click through (the move-then-checkbox case)", () => {
    // Regression: a move-drag emits no synthetic click, so the guard used to
    // linger and swallow the user's next deliberate click — the "first checkbox
    // click after moving a block does nothing" bug.
    let t = 1000;
    eatNextClick(() => t);
    t = 1600; // 600ms later — the user deliberately clicking a checkbox
    expect(dispatchClick().stopped).toBe(false);
  });

  it("only guards a single click, then tears its listener down", () => {
    let t = 1000;
    eatNextClick(() => t);
    t = 1010;
    expect(dispatchClick().stopped).toBe(true); // first click eaten
    t = 1020;
    expect(dispatchClick().stopped).toBe(false); // listener already removed
  });
});
