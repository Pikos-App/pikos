import { renderHook, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePanelWidthMotion } from "@/features/layout/hooks/usePanelWidthMotion";

import { followReducedMotion } from "./reducedMotion";

function stubReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    matches: initial,
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query)
  );

  return {
    set(reduce: boolean) {
      query.matches = reduce;
      listeners.forEach((listener) => listener());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  MotionGlobalConfig.skipAnimations = false;
});

describe("followReducedMotion", () => {
  it("closes a panel at once when the system asks for reduced motion", async () => {
    stubReducedMotion(true);
    const stop = followReducedMotion();
    const { rerender, result } = renderHook(
      ({ hidden }: { hidden: boolean }) => usePanelWidthMotion(240, hidden),
      { initialProps: { hidden: false } }
    );

    rerender({ hidden: true });

    expect(result.current.isAnimating()).toBe(false);
    await waitFor(() => expect(result.current.get()).toBe(0));
    stop();
  });

  it("springs again once the setting is turned off", () => {
    const media = stubReducedMotion(true);
    const stop = followReducedMotion();
    media.set(false);
    const { rerender, result } = renderHook(
      ({ hidden }: { hidden: boolean }) => usePanelWidthMotion(240, hidden),
      { initialProps: { hidden: false } }
    );

    rerender({ hidden: true });

    expect(result.current.isAnimating()).toBe(true);
    stop();
  });
});
