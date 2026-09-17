import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EditorFontSize } from "./EditorSettingsContext";
import {
  EditorSettingsProvider,
  stepEditorFontSize,
  useEditorSettings,
} from "./EditorSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <EditorSettingsProvider>{children}</EditorSettingsProvider>;
}

function setup() {
  return renderHook(() => useEditorSettings(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("lineWidth", () => {
  it("defaults to 'default'", () => {
    const { result } = setup();
    expect(result.current.lineWidth).toBe("default");
  });

  it("can be set to each option", () => {
    const { result } = setup();
    for (const width of ["narrow", "wide", "full", "default"] as const) {
      act(() => result.current.setLineWidth(width));
      expect(result.current.lineWidth).toBe(width);
    }
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setLineWidth("wide"));
    expect(JSON.parse(localStorage.getItem("pikos:lineWidth")!)).toBe("wide");
  });
});

describe("stepEditorFontSize", () => {
  it("moves one rung in each direction", () => {
    expect(stepEditorFontSize(14, 1)).toBe(16);
    expect(stepEditorFontSize(14, -1)).toBe(12);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(stepEditorFontSize(28, 1)).toBe(28);
    expect(stepEditorFontSize(10, -1)).toBe(10);
  });

  it("steps a size that is not on the ladder to the rung either side of it", () => {
    const offLadder = 17 as EditorFontSize;
    expect(stepEditorFontSize(offLadder, 1)).toBe(18);
    expect(stepEditorFontSize(offLadder, -1)).toBe(16);
  });
});

describe("fontSize", () => {
  it("defaults to 14", () => {
    const { result } = setup();
    expect(result.current.fontSize).toBe(14);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setFontSize(20));
    expect(JSON.parse(localStorage.getItem("pikos:editorFontSize")!)).toBe(20);
  });

  it("steps up and down from the current size", () => {
    const { result } = setup();
    act(() => result.current.stepFontSize(1));
    expect(result.current.fontSize).toBe(16);
    act(() => result.current.stepFontSize(-1));
    expect(result.current.fontSize).toBe(14);
  });

  it("persists a stepped size", () => {
    const { result } = setup();
    act(() => result.current.stepFontSize(1));
    expect(JSON.parse(localStorage.getItem("pikos:editorFontSize")!)).toBe(16);
  });
});
