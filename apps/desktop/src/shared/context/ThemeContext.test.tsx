import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "./ThemeContext";

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function setup() {
  return renderHook(() => useTheme(), { wrapper });
}

let matchMediaListeners: Array<() => void>;
let matchMediaMatches: boolean;

beforeEach(() => {
  localStorage.clear();
  matchMediaListeners = [];
  matchMediaMatches = false;

  // Mock matchMedia
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      addEventListener: (_event: string, fn: () => void) => matchMediaListeners.push(fn),
      matches: matchMediaMatches,
      removeEventListener: (_event: string, fn: () => void) => {
        matchMediaListeners = matchMediaListeners.filter((l) => l !== fn);
      },
    })),
  });
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark", "theme-transitioning");
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("ThemeContext", () => {
  it("defaults to dark mode", () => {
    const { result } = setup();
    expect(result.current.mode).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("reads stored mode from localStorage", () => {
    localStorage.setItem("pikos-theme", "light");
    const { result } = setup();
    expect(result.current.mode).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("falls back to dark for unknown localStorage values", () => {
    localStorage.setItem("pikos-theme", "garbage");
    const { result } = setup();
    expect(result.current.mode).toBe("dark");
  });

  it("setTheme persists to localStorage and updates state", () => {
    const { result } = setup();

    act(() => result.current.setTheme("light"));

    expect(result.current.mode).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
    expect(localStorage.getItem("pikos-theme")).toBe("light");
  });

  it("applies .dark class to document.documentElement", () => {
    setup();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes .dark class when switching to light", () => {
    const { result } = setup();
    act(() => result.current.setTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("adds theme-transitioning class during theme switch", async () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.setTheme("light"));
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(true);

    await act(() => vi.advanceTimersByTime(250));
    expect(document.documentElement.classList.contains("theme-transitioning")).toBe(false);

    vi.useRealTimers();
  });

  it("updates meta theme-color tag", () => {
    const { result } = setup();
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute("content")).toBe("#161613");

    act(() => result.current.setTheme("light"));
    expect(meta?.getAttribute("content")).toBe("#ffffff");
  });

  it("resolves system mode using matchMedia", () => {
    matchMediaMatches = true; // prefers-color-scheme: dark
    const { result } = setup();

    act(() => result.current.setTheme("system"));
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("reacts to OS preference changes in system mode", () => {
    const { result } = setup();

    act(() => result.current.setTheme("system"));

    // Simulate OS switching to light
    matchMediaMatches = false;
    act(() => {
      for (const fn of matchMediaListeners) fn();
    });

    expect(result.current.resolvedTheme).toBe("light");
  });

  it("does not listen for OS changes when not in system mode", () => {
    setup();
    // In dark mode (default) — no listeners should be registered
    expect(matchMediaListeners).toHaveLength(0);
  });

  it("throws when useTheme is called outside provider", () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      "useTheme must be used within <ThemeProvider>"
    );
  });
});
