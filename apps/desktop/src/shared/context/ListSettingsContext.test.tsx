import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ListSettingsProvider, useListSettings } from "./ListSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <ListSettingsProvider>{children}</ListSettingsProvider>;
}

function setup() {
  return renderHook(() => useListSettings(), { wrapper });
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
