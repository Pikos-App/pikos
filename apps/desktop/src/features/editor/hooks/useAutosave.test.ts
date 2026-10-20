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
  it("calls saveFn after the delay once something is scheduled", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    act(() => result.current.schedule());

    expect(saveFn).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("does not call saveFn when nothing was scheduled", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await result.current.flush();
    });

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("restarts the timer on each schedule, saving once after the last", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    for (let i = 0; i < 3; i++) {
      act(() => result.current.schedule());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }

    expect(saveFn).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("waits the delay a schedule names instead of the hook's", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    act(() => result.current.schedule(3000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });

    expect(saveFn).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("re-renders nothing when scheduled", () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useAutosave(saveFn, { delay: 500 });
    });
    const before = renders;

    act(() => {
      for (let i = 0; i < 50; i++) result.current.schedule();
    });

    expect(renders).toBe(before);
  });
});

describe("flush", () => {
  it("writes immediately without waiting for the debounce timer", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    act(() => result.current.schedule());
    await act(async () => {
      await result.current.flush();
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("does not double-write when timer fires after flush", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    act(() => result.current.schedule());
    await act(async () => {
      await result.current.flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });
});

describe("isSaving", () => {
  it("is true while saveFn is in flight", async () => {
    let resolveSave!: () => void;
    const saveFn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveSave = r;
        })
    );
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 100 }));

    act(() => result.current.schedule());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.isSaving).toBe(true);

    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });

    expect(result.current.isSaving).toBe(false);
  });
});

describe("error propagation", () => {
  it("sets saveError on saveFn rejection", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("save failed"));
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 100 }));

    act(() => result.current.schedule());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.saveError?.message).toBe("save failed");
  });

  it("retries a failed save on the next flush and clears the error", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAutosave(saveFn, { delay: 100 }));

    act(() => result.current.schedule());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.saveError).toBeTruthy();

    await act(async () => {
      await result.current.flush();
    });

    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(result.current.saveError).toBeNull();
  });
});

describe("unmount", () => {
  it("flushes pending save on unmount", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutosave(saveFn, { delay: 500 }));

    act(() => result.current.schedule());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveFn).toHaveBeenCalledOnce();
  });
});
