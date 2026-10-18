import type { StorageAdapter } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WriteMirror } from "@/shared/viewCache/writeMirror";

import { usePageWriteQueue } from "./usePageWriteQueue";

afterEach(() => {
  vi.useRealTimers();
});

function setUp() {
  const updatePage = vi.fn(() => Promise.resolve());
  const adapter = { updatePage } as unknown as StorageAdapter;
  const mirror = {
    capture: (apply: () => void) => {
      apply();
      return [];
    },
    confirm: vi.fn(),
    fail: vi.fn(),
    patch: vi.fn(),
  } as unknown as WriteMirror;
  const hook = renderHook(() => usePageWriteQueue({ adapter, emit: vi.fn(), mirror }));
  return { hook, updatePage };
}

describe("usePageWriteQueue", () => {
  it("writes an edit still waiting on its debounce when the queue goes away", async () => {
    vi.useFakeTimers();
    const { hook, updatePage } = setUp();

    hook.result.current.updatePage("p1", { title: "Renamed" });
    hook.unmount();
    await vi.advanceTimersByTimeAsync(0);

    expect(updatePage).toHaveBeenCalledWith("p1", { title: "Renamed" });
  });

  it("writes it once, not again when its timer would have fired", async () => {
    vi.useFakeTimers();
    const { hook, updatePage } = setUp();

    hook.result.current.updatePage("p1", { title: "Renamed" });
    hook.unmount();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(updatePage).toHaveBeenCalledTimes(1);
  });
});
