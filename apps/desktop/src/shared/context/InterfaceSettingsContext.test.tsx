import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InterfaceSettingsProvider, useInterfaceSettings } from "./InterfaceSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <InterfaceSettingsProvider>{children}</InterfaceSettingsProvider>;
}

function setup() {
  return renderHook(() => useInterfaceSettings(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("density", () => {
  it("defaults to 'cozy'", () => {
    const { result } = setup();
    expect(result.current.density).toBe("cozy");
  });

  it("can be set to each option", () => {
    const { result } = setup();
    for (const d of ["compact", "cozy", "spacious"] as const) {
      act(() => result.current.setDensity(d));
      expect(result.current.density).toBe(d);
    }
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDensity("spacious"));
    expect(JSON.parse(localStorage.getItem("pikos:listDensity")!)).toBe("spacious");
  });
});

describe("text scale", () => {
  it("defaults to 1, so the app renders exactly as it did before the setting existed", () => {
    const { result } = setup();
    expect(result.current.textScale).toBe(1);
  });

  it("steps up and down the ladder", () => {
    const { result } = setup();
    act(() => result.current.stepTextScale(1));
    expect(result.current.textScale).toBe(1.15);
    act(() => result.current.stepTextScale(-1));
    expect(result.current.textScale).toBe(1);
  });

  it("holds at each end rather than wrapping or overshooting", () => {
    const { result } = setup();
    act(() => result.current.setTextScale(2));
    act(() => result.current.stepTextScale(1));
    expect(result.current.textScale).toBe(2);
    act(() => result.current.setTextScale(0.85));
    act(() => result.current.stepTextScale(-1));
    expect(result.current.textScale).toBe(0.85);
  });

  it("steps a value an older ladder persisted instead of stranding it", () => {
    localStorage.setItem("pikos:interfaceTextScale", "1.05");
    const { result } = setup();
    act(() => result.current.stepTextScale(1));
    expect(result.current.textScale).toBe(1.15);
  });
});
