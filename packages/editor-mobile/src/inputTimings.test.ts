import { describe, expect, it } from "vitest";

import { createInputTimings } from "./inputTimings";

function harness() {
  let clock = 0;
  const frames: Array<() => void> = [];
  const timings = createInputTimings(
    () => clock,
    (callback) => frames.push(callback)
  );
  return {
    advance: (ms: number) => (clock += ms),
    paint: () => frames.splice(0).forEach((frame) => frame()),
    timings,
  };
}

describe("input timings", () => {
  it("measures from the input to the frame after the update", () => {
    const { advance, paint, timings } = harness();
    timings.start();
    advance(4);
    timings.finishOnNextFrame();
    advance(12);
    paint();
    expect(timings.drain()).toEqual({ count: 1, medianMs: 16, worstMs: 16 });
  });

  it("counts two inputs drawn by one frame once, from the first", () => {
    const { advance, paint, timings } = harness();
    timings.start();
    advance(5);
    timings.start();
    timings.finishOnNextFrame();
    advance(5);
    paint();
    expect(timings.drain()).toEqual({ count: 1, medianMs: 10, worstMs: 10 });
  });

  it("reports the median and the worst, then starts over", () => {
    const { advance, paint, timings } = harness();
    for (const ms of [10, 30, 20]) {
      timings.start();
      timings.finishOnNextFrame();
      advance(ms);
      paint();
    }
    expect(timings.drain()).toEqual({ count: 3, medianMs: 20, worstMs: 30 });
    expect(timings.drain()).toBeNull();
  });

  it("ignores an update no input started, such as the host loading a page", () => {
    const { paint, timings } = harness();
    timings.finishOnNextFrame();
    paint();
    expect(timings.drain()).toBeNull();
  });
});
