import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppSettingsProvider, useAppSettings } from "./AppSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <AppSettingsProvider>{children}</AppSettingsProvider>;
}

function setup() {
  return renderHook(() => useAppSettings(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("weekStart", () => {
  it("defaults to 1 (Monday)", () => {
    const { result } = setup();
    expect(result.current.weekStart).toBe(1);
  });

  it("can be set to 0 (Sunday)", () => {
    const { result } = setup();
    act(() => result.current.setWeekStart(0));
    expect(result.current.weekStart).toBe(0);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setWeekStart(0));
    expect(JSON.parse(localStorage.getItem("pikos:weekStart")!)).toBe(0);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:weekStart", "0");
    const { result } = setup();
    expect(result.current.weekStart).toBe(0);
  });
});

describe("defaultFolderId", () => {
  it("defaults to null (Inbox)", () => {
    const { result } = setup();
    expect(result.current.defaultFolderId).toBeNull();
  });

  it("can be set to a folder ID", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-123"));
    expect(result.current.defaultFolderId).toBe("folder-123");
  });

  it("can be reset to null", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-123"));
    act(() => result.current.setDefaultFolderId(null));
    expect(result.current.defaultFolderId).toBeNull();
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDefaultFolderId("folder-abc"));
    expect(JSON.parse(localStorage.getItem("pikos:defaultFolderId")!)).toBe("folder-abc");
  });
});
