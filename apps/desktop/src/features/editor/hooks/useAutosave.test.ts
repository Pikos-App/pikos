import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutosave } from "./useAutosave";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounce", () => {
  it("calls saveFn after the delay when value changes", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ value }) => useAutosave(value, saveFn, { delay: 500 }), {
      initialProps: { value: "initial" },
    });

    rerender({ value: "updated" });

    expect(saveFn).not.toHaveBeenCalled();

    // Advance past the debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveFn).toHaveBeenCalledOnce();
    expect(saveFn).toHaveBeenCalledWith("updated");
  });

  it("does not call saveFn if value hasn't changed", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutosave("stable", saveFn, { delay: 500 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("resets the timer on rapid value changes (only saves latest)", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ value }) => useAutosave(value, saveFn, { delay: 500 }), {
      initialProps: { value: "v0" },
    });

    rerender({ value: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    rerender({ value: "v2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    rerender({ value: "v3" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveFn).toHaveBeenCalledOnce();
    expect(saveFn).toHaveBeenCalledWith("v3");
  });
});

describe("flush", () => {
  it("writes immediately without waiting for the debounce timer", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 500 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "flushed" });

    await act(async () => {
      await result.current.flush();
    });

    expect(saveFn).toHaveBeenCalledOnce();
    expect(saveFn).toHaveBeenCalledWith("flushed");
  });

  it("does not double-write when timer fires after flush", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 500 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "once" });

    await act(async () => {
      await result.current.flush();
    });

    // Advance past the original debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });
});

describe("isDirty and isSaving", () => {
  it("isDirty is true when value differs from saved value", () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, result } = renderHook(({ value }) => useAutosave(value, saveFn), {
      initialProps: { value: "initial" },
    });

    expect(result.current.isDirty).toBe(false);

    rerender({ value: "changed" });
    expect(result.current.isDirty).toBe(true);
  });

  it("isDirty becomes false after save completes", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 100 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "saved" });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // After save completes, the setIsSaving(false) triggers a re-render
    // which recomputes isDirty = value !== savedValue.current
    // Trigger one more re-render to ensure React flushes
    rerender({ value: "saved" });
    expect(result.current.isDirty).toBe(false);
  });

  it("isSaving is true while saveFn is in flight", async () => {
    let resolveSave!: () => void;
    const saveFn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveSave = r;
        })
    );

    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 100 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "saving" });

    // Trigger the debounced save
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.isSaving).toBe(true);

    act(() => {
      resolveSave();
    });
    // Let microtasks settle so isSaving flips
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isSaving).toBe(false);
  });
});

describe("error propagation", () => {
  it("sets saveError on saveFn rejection", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("save failed"));
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 100 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "doomed" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.saveError).toBeInstanceOf(Error);
    expect(result.current.saveError?.message).toBe("save failed");
  });

  it("clears saveError on next successful save", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);

    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 100 }),
      { initialProps: { value: "v0" } }
    );

    rerender({ value: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.saveError).toBeTruthy();

    rerender({ value: "v2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.saveError).toBeNull();
  });
});

describe("unmount", () => {
  it("flushes pending save on unmount", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutosave(value, saveFn, { delay: 500 }),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "unsaved" });

    // Unmount before the timer fires
    unmount();

    // The unmount effect should fire-and-forget the save
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveFn).toHaveBeenCalledWith("unsaved");
  });
});
