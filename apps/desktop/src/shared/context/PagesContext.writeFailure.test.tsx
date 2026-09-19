// A failed write has to reach the person who made it.
//
// `pageErrors` has one consumer, the editor's MetadataHeader, and it only reads
// the entry for the page currently open. So ticking a task done from a list, the
// calendar or a search result rolled back in silence, and writes that carry no
// `errorIds` at all (reorders, folder moves) had no surface whatsoever. With no
// telemetry, a failure nobody is shown is a failure nobody can report.

import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { subscribeNotices } from "@/shared/events/noticeBus";
import { renderHookWithProviders } from "@/test/renderWithProviders";

async function setup() {
  const hook = renderHookWithProviders(() => ({
    pages: usePages(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

/** Collect every toast raised while a test runs. */
function captureNotices() {
  const seen: string[] = [];
  const off = subscribeNotices((label) => void seen.push(label));
  return { off, seen };
}

afterEach(() => vi.restoreAllMocks());

describe("PagesContext — a failed write is surfaced", () => {
  // Ticking a page done bypasses the debounce, so its only report was the editor's
  // inline indicator for whichever page happened to be open.
  it("raises a notice when a status tick fails away from the editor", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    const { off, seen } = captureNotices();
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      hook.result.current.pages.updatePage(id, { status: "done" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/updating status/);
    off();
  });

  it("rolls the optimistic status back when the write fails", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    const { off } = captureNotices();
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      hook.result.current.pages.updatePage(id, { status: "done" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(hook.result.current.pages.pages.find((p) => p.id === id)?.status).toBe("not_started");
    off();
  });

  // A rethrowing write is awaited by a caller that reports it (the calendar's
  // create path). Raising one here too is how a failure gets toasted twice.
  it("stays quiet when the caller is the one reporting", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    const { off, seen } = captureNotices();
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      hook.result.current.pages.updatePage(id, { title: "B" });
      await hook.result.current.pages.flushPage(id).catch(() => undefined);
    });

    expect(seen).toEqual([]);
    off();
  });

  it("names what the user was doing when a reorder fails", async () => {
    const hook = await setup();
    const ids: string[] = [];
    await act(async () => {
      for (const title of ["A", "B"]) {
        const p = await hook.result.current.pages.createPage({ title });
        ids.push(p.id);
      }
    });

    const { off, seen } = captureNotices();
    vi.spyOn(MockStorageAdapter.prototype, "reorderPages").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      await hook.result.current.pages.reorderPages(null, [...ids].reverse());
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/reordering pages/);
    off();
  });
});
