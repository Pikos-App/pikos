import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePanelWidthMotion } from "./usePanelWidthMotion";

function renderPanel(width: number, hidden: boolean) {
  return renderHook(
    ({ hidden, width }: { hidden: boolean; width: number }) => usePanelWidthMotion(width, hidden),
    { initialProps: { hidden, width } }
  );
}

describe("usePanelWidthMotion", () => {
  it("starts at the width, or at zero when hidden", () => {
    expect(renderPanel(240, false).result.current.get()).toBe(240);
    expect(renderPanel(240, true).result.current.get()).toBe(0);
  });

  it("moves to a new width at once, without animating", () => {
    const { rerender, result } = renderPanel(240, false);

    rerender({ hidden: false, width: 480 });

    expect(result.current.get()).toBe(480);
    expect(result.current.isAnimating()).toBe(false);
  });

  it("springs when the panel closes and opens", () => {
    const { rerender, result } = renderPanel(240, false);

    rerender({ hidden: true, width: 240 });
    expect(result.current.isAnimating()).toBe(true);
    expect(result.current.get()).toBe(240);

    rerender({ hidden: false, width: 240 });
    expect(result.current.isAnimating()).toBe(true);
  });

  it("stays closed when the width changes while hidden", () => {
    const { rerender, result } = renderPanel(240, true);

    rerender({ hidden: true, width: 480 });

    expect(result.current.get()).toBe(0);
  });
});
