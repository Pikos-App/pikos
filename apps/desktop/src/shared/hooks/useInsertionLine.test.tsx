// useInsertionLine — given a list of ids, returns the id before which the
// insertion line should render during a drag, or null (after-last), or
// undefined (no line). The hook subscribes to dnd-kit drag events; we mock
// useDndMonitor to drive those events directly.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Listener {
  onDragStart?: (e: { active: { id: string } }) => void;
  onDragOver?: (e: { over: { id: string } | null }) => void;
  onDragEnd?: () => void;
  onDragCancel?: () => void;
}

const monitorListeners: Listener[] = [];

vi.mock("@dnd-kit/core", () => ({
  useDndMonitor(listener: Listener) {
    monitorListeners.push(listener);
  },
}));

import { useInsertionLine } from "./useInsertionLine";

function fireStart(id: string) {
  monitorListeners.forEach((l) => l.onDragStart?.({ active: { id } }));
}
function fireOver(id: string | null) {
  monitorListeners.forEach((l) => l.onDragOver?.({ over: id === null ? null : { id } }));
}
function fireEnd() {
  monitorListeners.forEach((l) => l.onDragEnd?.());
}
function fireCancel() {
  monitorListeners.forEach((l) => l.onDragCancel?.());
}

beforeEach(() => {
  monitorListeners.length = 0;
});
afterEach(() => {
  monitorListeners.length = 0;
});

describe("useInsertionLine — no-line cases", () => {
  it("returns undefined when no drag is active", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when dragging but not over anything", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    // overId is null at this point — no line.
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when over has cleared", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("b"));
    expect(result.current).toBe("c");
    act(() => fireOver(null));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when active item is not in the list", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("z")); // foreign list
    act(() => fireOver("b"));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when over item is not in the list", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("not-in-list"));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when active and over are the same item", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("b"));
    act(() => fireOver("b"));
    expect(result.current).toBeUndefined();
  });
});

describe("useInsertionLine — direction logic", () => {
  it("dragging up: insertion line points at the over item", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c", "d"]));
    act(() => fireStart("c"));
    act(() => fireOver("a"));
    expect(result.current).toBe("a");
  });

  it("dragging down: insertion line points at the item AFTER over", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c", "d"]));
    act(() => fireStart("a"));
    act(() => fireOver("b"));
    expect(result.current).toBe("c");
  });

  it("dragging down onto the last item: returns null (after-last)", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("c"));
    expect(result.current).toBeNull();
  });

  it("dragging up onto first item: returns first item id", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("c"));
    act(() => fireOver("a"));
    expect(result.current).toBe("a");
  });
});

describe("useInsertionLine — lifecycle", () => {
  it("clears when drag ends", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("b"));
    expect(result.current).toBe("c");
    act(() => fireEnd());
    expect(result.current).toBeUndefined();
  });

  it("clears when drag is cancelled", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("b"));
    expect(result.current).toBe("c");
    act(() => fireCancel());
    expect(result.current).toBeUndefined();
  });

  it("dragStart resets overId from a previous drag", () => {
    const { result } = renderHook(() => useInsertionLine(["a", "b", "c"]));
    act(() => fireStart("a"));
    act(() => fireOver("b"));
    expect(result.current).toBe("c");
    // New drag starts; overId must be reset, not stale.
    act(() => fireStart("c"));
    expect(result.current).toBeUndefined();
  });
});
