// `pageErrors` is read only for the editor's open page, so a failed write from a list, the
// calendar or a search result, or one with no `errorIds` (reorders, folder moves), would roll
// back in silence. With no telemetry, a failure nobody is shown is a failure nobody can report.

import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { subscribeNotices } from "@/shared/events/noticeBus";
import { renderHookWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

async function setup() {
  const hook = renderHookWithProviders(() => ({
    pages: usePagesNow(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

function captureNotices() {
  const seen: string[] = [];
  const off = subscribeNotices((label) => void seen.push(label));
  return { off, seen };
}

afterEach(() => vi.restoreAllMocks());

describe("PagesContext — a failed write is surfaced", () => {
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

  // A rethrowing write is awaited by a caller that reports it; raising one here too toasts twice.
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

  // `scheduleOnce` rethrows for the one caller that deletes a page whose schedule never landed; keying
  // the report to `rethrow` would leave a failed calendar drag, date pick and date clear silent.
  it("reports a failed schedule even though the write also rethrows", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "A" });
      id = p.id;
    });

    const { off, seen } = captureNotices();
    vi.spyOn(MockStorageAdapter.prototype, "createPageSchedule").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      await hook.result.current.pages.scheduleOnce(id, "2026-09-18").catch(() => undefined);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/scheduling this page/);
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
