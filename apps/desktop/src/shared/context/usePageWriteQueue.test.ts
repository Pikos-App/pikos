import type { StorageAdapter } from "@pikos/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { onFlushPending } from "@/shared/pendingWrites";
import type { WriteMirror } from "@/shared/viewCache/writeMirror";

import { usePageWriteQueue } from "./usePageWriteQueue";

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;

const closeHandlers: CloseHandler[] = [];
const destroy = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy,
    onCloseRequested: (handler: CloseHandler) => {
      closeHandlers.push(handler);
      return Promise.resolve(() => {});
    },
  }),
}));

const mirror = {
  capture: (fn: () => void) => {
    fn();
    return [];
  },
  confirm: () => Promise.resolve(),
  confirmRow: () => {},
  fail: () => {},
  patch: () => {},
} as unknown as WriteMirror;

beforeEach(() => {
  vi.stubEnv("VITE_TEST_MODE", "false");
  closeHandlers.length = 0;
  destroy.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("closing the window writes an edit still waiting in the editor's autosave before it goes", async () => {
  const updatePage = vi.fn((id: string) => Promise.resolve({ id }));
  const adapter = { updatePage } as unknown as StorageAdapter;
  const { result } = renderHook(() => usePageWriteQueue({ adapter, emit: vi.fn(), mirror }));
  const off = onFlushPending(() => {
    result.current.updatePage("p1", { content: "typed just before quitting" });
  });

  await waitFor(() => expect(closeHandlers).toHaveLength(1));
  await act(() => closeHandlers[0]!({ preventDefault: () => {} }));
  off();

  expect(updatePage).toHaveBeenCalledWith("p1", { content: "typed just before quitting" });
  expect(destroy).toHaveBeenCalledOnce();
  expect(updatePage.mock.invocationCallOrder[0]!).toBeLessThan(
    destroy.mock.invocationCallOrder[0]!
  );
});

it("typing that coalesces with a body still waiting is saved over the body stored, not the waiting one", async () => {
  const updatePage = vi.fn((id: string) => Promise.resolve({ id }));
  const adapter = { updatePage } as unknown as StorageAdapter;
  const { result } = renderHook(() => usePageWriteQueue({ adapter, emit: vi.fn(), mirror }));

  result.current.updatePage("p1", { baseContent: "stored", content: "first" });
  result.current.updatePage("p1", { baseContent: "first", content: "second" });
  await act(() => result.current.flushPage("p1"));

  expect(updatePage).toHaveBeenCalledWith("p1", { baseContent: "stored", content: "second" });
});

it("a save the database merged with a newer body says what was typed and what was saved", async () => {
  const updatePage = vi.fn((id: string) => Promise.resolve({ content: "merged", id }));
  const adapter = { updatePage } as unknown as StorageAdapter;
  const emit = vi.fn();
  const { result } = renderHook(() => usePageWriteQueue({ adapter, emit, mirror }));

  result.current.updatePage("p1", { baseContent: "loaded", content: "typed" });
  await act(() => result.current.flushPage("p1"));

  expect(emit).toHaveBeenCalledWith("page:merged", {
    page: { content: "merged", id: "p1" },
    typed: "typed",
  });
});
