import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EditorSettingsProvider, useEditorSettings } from "./EditorSettingsContext";

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

describe("spellCheck", () => {
  it("defaults to false", () => {
    const { result } = setup();
    expect(result.current.spellCheck).toBe(false);
  });

  it("can be toggled on", () => {
    const { result } = setup();
    act(() => result.current.setSpellCheck(true));
    expect(result.current.spellCheck).toBe(true);
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setSpellCheck(true));
    expect(JSON.parse(localStorage.getItem("pikos:spellCheck")!)).toBe(true);
  });

  it("reads persisted value on mount", () => {
    localStorage.setItem("pikos:spellCheck", "true");
    const { result } = setup();
    expect(result.current.spellCheck).toBe(true);
  });
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
