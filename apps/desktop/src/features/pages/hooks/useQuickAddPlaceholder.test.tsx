import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUICK_ADD_PLACEHOLDER_EXAMPLES, useQuickAddPlaceholder } from "./useQuickAddPlaceholder";

const KEY = "pikos:quickAddPlaceholderIndex";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useQuickAddPlaceholder", () => {
  it("shows the first example before the dialog has ever opened", () => {
    const hook = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: false },
    });

    expect(hook.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[0]);
  });

  it("advances to the next example on each open transition", () => {
    const hook = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: false },
    });

    act(() => hook.rerender({ open: true }));
    expect(hook.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[0]);

    act(() => hook.rerender({ open: false }));
    act(() => hook.rerender({ open: true }));
    expect(hook.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[1]);

    act(() => hook.rerender({ open: false }));
    act(() => hook.rerender({ open: true }));
    expect(hook.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[2]);
  });

  it("cycles back to the first example after the end of the list", () => {
    localStorage.setItem(KEY, JSON.stringify(QUICK_ADD_PLACEHOLDER_EXAMPLES.length - 1));

    const hook = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: false },
    });

    act(() => hook.rerender({ open: true }));
    expect(hook.result.current).toBe(
      QUICK_ADD_PLACEHOLDER_EXAMPLES[QUICK_ADD_PLACEHOLDER_EXAMPLES.length - 1]
    );

    act(() => hook.rerender({ open: false }));
    act(() => hook.rerender({ open: true }));
    expect(hook.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[0]);
  });

  it("persists the cursor across hook remounts", () => {
    const first = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: false },
    });
    act(() => first.rerender({ open: true }));
    act(() => first.rerender({ open: false }));
    act(() => first.rerender({ open: true }));
    expect(first.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[1]);
    first.unmount();

    const second = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: true },
    });
    expect(second.result.current).toBe(QUICK_ADD_PLACEHOLDER_EXAMPLES[2]);
  });

  it("recovers from a corrupted index by falling back to a valid position", () => {
    localStorage.setItem(KEY, JSON.stringify(-7));

    const hook = renderHook(({ open }: { open: boolean }) => useQuickAddPlaceholder(open), {
      initialProps: { open: true },
    });

    expect(QUICK_ADD_PLACEHOLDER_EXAMPLES).toContain(hook.result.current);
  });
});
