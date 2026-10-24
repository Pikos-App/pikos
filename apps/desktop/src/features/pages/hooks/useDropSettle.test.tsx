import { act, renderHook } from "@testing-library/react";
import type { AnimationEvent } from "react";
import { describe, expect, it } from "vitest";

import { useDropSettle } from "./useDropSettle";

function animationEndOn(target: object, currentTarget: object) {
  return { currentTarget, target } as unknown as AnimationEvent;
}

describe("useDropSettle", () => {
  it("stays still for a row that was never dragged", () => {
    const { result } = renderHook(() => useDropSettle(false));

    expect(result.current.isSettling).toBe(false);
  });

  it("settles a row once its drag ends", () => {
    const { rerender, result } = renderHook(({ dragging }) => useDropSettle(dragging), {
      initialProps: { dragging: false },
    });

    rerender({ dragging: true });
    expect(result.current.isSettling).toBe(false);

    rerender({ dragging: false });
    expect(result.current.isSettling).toBe(true);
  });

  it("stops settling when the row's own animation ends, not a child's", () => {
    const { rerender, result } = renderHook(({ dragging }) => useDropSettle(dragging), {
      initialProps: { dragging: true },
    });
    rerender({ dragging: false });
    const row = {};

    act(() => result.current.onAnimationEnd(animationEndOn({}, row)));
    expect(result.current.isSettling).toBe(true);

    act(() => result.current.onAnimationEnd(animationEndOn(row, row)));
    expect(result.current.isSettling).toBe(false);
  });
});
