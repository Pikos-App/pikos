// useInlineRename — focuses the rename input when isRenaming flips true,
// and lets a context-menu trigger suppress Radix's focus-restore.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInlineRename } from "./useInlineRename";

beforeEach(() => {
  vi.useFakeTimers();
  // Make rAF a fake-timer-driven scheduler so we can advance time deterministically.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useInlineRename — focus on activate", () => {
  it("does not focus when isRenaming is false", async () => {
    const input = document.createElement("input");
    input.value = "hello";
    document.body.appendChild(input);
    const focusSpy = vi.spyOn(input, "focus");

    const { result } = renderHook(() => useInlineRename(false));
    (result.current.inputRef as { current: HTMLInputElement | null }).current = input;

    await act(() => vi.advanceTimersByTime(200));
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("focuses the input on the first rAF when isRenaming is true", async () => {
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    const focusSpy = vi.spyOn(input, "focus");

    const { result } = renderHook(() => useInlineRename(true));
    // The hook scheduled an rAF in its mount effect; wire up the ref before it fires.
    (result.current.inputRef as { current: HTMLInputElement | null }).current = input;

    await act(() => vi.advanceTimersByTime(20));
    expect(focusSpy).toHaveBeenCalled();
  });

  it("places the caret at end-of-value on an HTMLInputElement", async () => {
    const input = document.createElement("input");
    input.value = "weeklong";
    document.body.appendChild(input);
    const setSelSpy = vi.spyOn(input, "setSelectionRange");

    const { result } = renderHook(() => useInlineRename(true));
    (result.current.inputRef as { current: HTMLInputElement | null }).current = input;

    await act(() => vi.advanceTimersByTime(20));
    expect(setSelSpy).toHaveBeenCalledWith(8, 8);
  });

  it("collapses the selection to end on a non-input (contentEditable) element", async () => {
    const span = document.createElement("span");
    span.contentEditable = "true";
    span.textContent = "hello-world";
    document.body.appendChild(span);

    const { result } = renderHook(() => useInlineRename(true));
    (result.current.inputRef as { current: HTMLSpanElement | null }).current = span;

    await act(() => vi.advanceTimersByTime(20));

    const sel = window.getSelection();
    expect(sel?.rangeCount).toBeGreaterThan(0);
    const range = sel!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    // The collapsed range sits at the end of the span's content.
    expect(range.startContainer === span || range.startContainer === span.firstChild).toBe(true);
  });

  it("retries across rAF frames until the ref attaches", async () => {
    const input = document.createElement("input");
    input.value = "lazy";
    document.body.appendChild(input);
    const focusSpy = vi.spyOn(input, "focus");

    const { result } = renderHook(() => useInlineRename(true));
    const ref = result.current.inputRef as { current: HTMLInputElement | null };

    // Two frames pass with the ref still null — focus must NOT have fired.
    await act(() => vi.advanceTimersByTime(40));
    expect(focusSpy).not.toHaveBeenCalled();

    // Attach the ref. The next scheduled rAF retry should pick it up.
    ref.current = input;
    await act(() => vi.advanceTimersByTime(60));
    expect(focusSpy).toHaveBeenCalled();
  });
});

describe("useInlineRename — context menu suppress", () => {
  it("prepareRenameFromMenu invokes onRenameStart synchronously", () => {
    const onRenameStart = vi.fn();
    const { result } = renderHook(() => useInlineRename(false));

    act(() => {
      result.current.prepareRenameFromMenu(onRenameStart);
    });

    expect(onRenameStart).toHaveBeenCalledTimes(1);
  });

  it("contextMenuContentProps.onCloseAutoFocus prevents focus restore once after a menu trigger", () => {
    const { result } = renderHook(() => useInlineRename(false));

    act(() => {
      result.current.prepareRenameFromMenu(() => {});
    });

    const ev = new Event("test", { cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    result.current.contextMenuContentProps.onCloseAutoFocus(ev);
    expect(preventSpy).toHaveBeenCalled();

    // Subsequent close (without another prepareRenameFromMenu) does NOT preventDefault.
    const ev2 = new Event("test", { cancelable: true });
    const preventSpy2 = vi.spyOn(ev2, "preventDefault");
    result.current.contextMenuContentProps.onCloseAutoFocus(ev2);
    expect(preventSpy2).not.toHaveBeenCalled();
  });

  it("does not preventDefault when rename was started outside the menu", () => {
    const { result } = renderHook(() => useInlineRename(false));

    const ev = new Event("test", { cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    result.current.contextMenuContentProps.onCloseAutoFocus(ev);
    expect(preventSpy).not.toHaveBeenCalled();
  });
});
