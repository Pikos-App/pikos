import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Keyboard } from "./registry";
import { useKeyboardShortcut } from "./useKeyboard";

afterEach(() => {
  for (const b of Keyboard.listActiveBindings()) Keyboard.unregister(b.id);
});

describe("useKeyboardShortcut", () => {
  it("re-registers under a new label when the label changes", () => {
    const { rerender } = renderHook(
      ({ label }) => useKeyboardShortcut("ArrowLeft", vi.fn(), { group: "Calendar", label }),
      { initialProps: { label: "Previous week" } }
    );

    rerender({ label: "Previous month" });

    expect(Keyboard.listActiveBindings().map((b) => b.label)).toEqual(["Previous month"]);
  });
});
