// useScrollPersist — covers initial restore (saved value → corresponding
// scrollTop), smart-start fallback when no usable saved value, debounced
// persistence on scroll, and one-shot restore (no re-pin on geometry change).
//
// The hook reads container height via ResizeObserver; jsdom doesn't ship one,
// so we install a manual mock per test. A small Harness component attaches
// the hook's scrollRef to a real div whose clientHeight we control.

import { act, render } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCollapseGeometry, type CollapseGeometry } from "../utils/calendarGeometry";
import { useScrollPersist } from "./useScrollPersist";

const STORAGE_KEY = "pikos:test:scrollHour";

// Geometry with both bands expanded so mapHourToY(h, geometry) === h * hourHeight.
// 9am → 9 × 64 = 576 px, easy to read in assertions.
function makeGeometry(): CollapseGeometry {
  return buildCollapseGeometry(
    { bottomCollapsed: false, bottomHour: 22, topCollapsed: false, topHour: 6 },
    64
  );
}

interface ProbeRef {
  scrollEl: HTMLDivElement | null;
  containerHeight: number;
}

function Harness({
  calendarScrollRequest = null,
  geometry,
  onProbe,
  rightPanel = "calendar",
  storageKey = STORAGE_KEY,
}: {
  calendarScrollRequest?: { hour: number; token: number } | null;
  geometry: CollapseGeometry;
  onProbe: (snapshot: ProbeRef) => void;
  rightPanel?: string;
  storageKey?: string;
}): ReactNode {
  const { containerHeight, scrollRef } = useScrollPersist({
    calendarScrollRequest,
    geometry,
    rightPanel,
    storageKey,
  });
  // Push the live values out via effect — react-hooks/refs disallows reading
  // `.current` during render.
  useEffect(() => {
    onProbe({ containerHeight, scrollEl: scrollRef.current });
  });
  return <div data-testid="scroll" ref={scrollRef} style={{ height: "100%" }} />;
}

/** Create a probe + a setter the harness uses to push live values out. */
function makeProbe() {
  const probe: ProbeRef = { containerHeight: 0, scrollEl: null };
  function update(next: ProbeRef) {
    probe.containerHeight = next.containerHeight;
    probe.scrollEl = next.scrollEl;
  }
  return { probe, update };
}

/** Install a mock ResizeObserver + clientHeight stub. The clientHeight stub is
 * scoped to elements rendered AFTER `install` and reverts on `restore`. */
function installResizeObserver(initialHeight: number) {
  const observers: Array<{
    target: Element;
    cb: ResizeObserverCallback;
  }> = [];

  class MockResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      observers.push({ cb: this.cb, target });
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);

  // jsdom's HTMLElement.clientHeight is 0; override the prototype getter so
  // every freshly created div reports `initialHeight`.
  const proto = Object.getPrototypeOf(document.createElement("div")) as HTMLElement;
  const original = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() {
      return initialHeight;
    },
  });

  return {
    /** Push a resize entry to all live observers. */
    pushResize(height: number) {
      const entry = {
        contentRect: { height },
      } as unknown as ResizeObserverEntry;
      for (const o of observers) o.cb([entry], {} as ResizeObserver);
    },
    restore() {
      if (original) Object.defineProperty(proto, "clientHeight", original);
      else delete (proto as unknown as { clientHeight?: number }).clientHeight;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useScrollPersist — initial restore", () => {
  it("measures container height on mount", () => {
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    expect(probe.containerHeight).toBe(800);
    ro.restore();
  });

  it("restores saved scroll hour as a pixel scrollTop once container has height", () => {
    localStorage.setItem(STORAGE_KEY, "9");
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    expect(probe.scrollEl?.scrollTop).toBe(9 * 64);
    ro.restore();
  });

  it("smart-starts at max(7am, currentHour − 1) when no saved value", () => {
    const ro = installResizeObserver(800);
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0));
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    // 10am → currentHour−1 = 9 > 7 → expect 9.
    expect(probe.scrollEl?.scrollTop).toBe(9 * 64);
    ro.restore();
  });

  it("treats saved values under 0.5h as unset (legacy bug fix)", () => {
    localStorage.setItem(STORAGE_KEY, "0");
    const ro = installResizeObserver(800);
    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 0));
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    // 8am → currentHour−1 = 7, floor 7 → expect 7.
    expect(probe.scrollEl?.scrollTop).toBe(7 * 64);
    ro.restore();
  });

  it("does not restore while containerHeight is still 0", () => {
    localStorage.setItem(STORAGE_KEY, "9");
    const ro = installResizeObserver(0);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    expect(probe.scrollEl?.scrollTop ?? 0).toBe(0);
    ro.restore();
  });
});

describe("useScrollPersist — re-render semantics", () => {
  it("does not re-pin scroll after geometry changes mid-session", () => {
    localStorage.setItem(STORAGE_KEY, "9");
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    const initialGeom = makeGeometry();
    const { rerender } = render(<Harness geometry={initialGeom} onProbe={update} />);
    expect(probe.scrollEl?.scrollTop).toBe(576);

    // User scrolls; then geometry recomputes (density flip, band toggle…).
    if (probe.scrollEl) probe.scrollEl.scrollTop = 1200;
    rerender(<Harness geometry={makeGeometry()} onProbe={update} />);
    // Restore must NOT re-fire — the in-session scroll position is preserved.
    expect(probe.scrollEl?.scrollTop).toBe(1200);
    ro.restore();
  });
});

describe("useScrollPersist — persistence on scroll", () => {
  it("writes the saved hour to localStorage after the debounce window", () => {
    vi.useFakeTimers();
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);

    const el = probe.scrollEl!;
    el.scrollTop = 11 * 64; // 11am
    el.dispatchEvent(new Event("scroll"));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(Number(localStorage.getItem(STORAGE_KEY))).toBeCloseTo(11);
    ro.restore();
  });

  it("does not write until the debounce window elapses", () => {
    vi.useFakeTimers();
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);

    const el = probe.scrollEl!;
    el.scrollTop = 11 * 64;
    el.dispatchEvent(new Event("scroll"));

    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Restore only reads; the scroll handler is the sole writer and its
    // debounce hasn't elapsed yet, so the key must still be unset.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
    ro.restore();
  });
});

describe("useScrollPersist — container height tracking", () => {
  it("updates containerHeight when ResizeObserver fires", () => {
    const ro = installResizeObserver(800);
    const { probe, update } = makeProbe();
    render(<Harness geometry={makeGeometry()} onProbe={update} />);
    expect(probe.containerHeight).toBe(800);

    // Update the clientHeight stub as well so the rightPanel resync effect
    // doesn't fight the ResizeObserver-driven setState.
    ro.restore();
    const ro2 = installResizeObserver(1024);
    act(() => {
      ro.pushResize(1024);
    });
    expect(probe.containerHeight).toBe(1024);
    ro2.restore();
  });
});
