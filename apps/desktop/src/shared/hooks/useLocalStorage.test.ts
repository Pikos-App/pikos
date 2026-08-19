import { MemoryKeyValueStore } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setKeyValueStore } from "@/shared/kv";

import { useLocalStorage } from "./useLocalStorage";

afterEach(() => {
  localStorage.clear();
  setKeyValueStore(null);
});

describe("useLocalStorage", () => {
  it("returns the default value when key is missing", () => {
    const { result } = renderHook(() => useLocalStorage("missing", 42));
    expect(result.current[0]).toBe(42);
  });

  it("reads an existing value from localStorage", () => {
    localStorage.setItem("existing", JSON.stringify("hello"));
    const { result } = renderHook(() => useLocalStorage("existing", "fallback"));
    expect(result.current[0]).toBe("hello");
  });

  it("falls back to default on invalid JSON", () => {
    localStorage.setItem("bad", "{not json");
    const { result } = renderHook(() => useLocalStorage("bad", "safe"));
    expect(result.current[0]).toBe("safe");
  });

  it("persists value to localStorage on set", () => {
    const { result } = renderHook(() => useLocalStorage("key", 0));

    act(() => {
      result.current[1](99);
    });

    expect(result.current[0]).toBe(99);
    expect(JSON.parse(localStorage.getItem("key")!)).toBe(99);
  });

  it("supports updater function form", () => {
    const { result } = renderHook(() => useLocalStorage("counter", 10));

    act(() => {
      result.current[1]((prev) => prev + 5);
    });

    expect(result.current[0]).toBe(15);
    expect(JSON.parse(localStorage.getItem("counter")!)).toBe(15);
  });

  it("serializes objects", () => {
    const { result } = renderHook(() => useLocalStorage("obj", { a: 1 }));

    act(() => {
      result.current[1]({ a: 2 });
    });

    expect(result.current[0]).toEqual({ a: 2 });
    expect(JSON.parse(localStorage.getItem("obj")!)).toEqual({ a: 2 });
  });

  // The hook is the only writer the app has; the store under it is swappable so
  // a host with no window.localStorage (a phone) can back the same keys.
  it("writes through whatever key-value store is installed", () => {
    const store = new MemoryKeyValueStore();
    setKeyValueStore(store);

    const { result } = renderHook(() => useLocalStorage("injected", 1));
    act(() => {
      result.current[1](7);
    });

    expect(store.getItem("injected")).toBe("7");
    expect(localStorage.getItem("injected")).toBeNull();
  });

  it("reads the installed store rather than window.localStorage", () => {
    const store = new MemoryKeyValueStore();
    store.setItem("injected", JSON.stringify("from-store"));
    localStorage.setItem("injected", JSON.stringify("from-window"));
    setKeyValueStore(store);

    const { result } = renderHook(() => useLocalStorage("injected", "fallback"));
    expect(result.current[0]).toBe("from-store");
  });
});
