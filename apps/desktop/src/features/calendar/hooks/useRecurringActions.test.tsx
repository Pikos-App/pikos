// useRecurringActions — routes recurring-page interactions on calendar blocks.
//
// Verifies the branches the hook's caller (PageBlock, AllDayBar) cares about:
// a status toggle with and without a rule; which blocks offer a checkbox at all;
// and where the delete gesture lands — one occurrence for anything rendered as
// one, the page trash for a real page.

import type { PageSummary, VirtualOccurrence } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import { act } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useRecurringActions } from "./useRecurringActions";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Render the workspace + actions hook in the same provider tree so they
 * share the same WorkspaceContext instance. `targetPage` is set after the
 * workspace seeds a page so useRecurringActions sees the real one.
 */
function setup() {
  let setTargetPage!: (p: PageSummary) => void;
  const TARGET_INITIAL: PageSummary = {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "placeholder",
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "placeholder",
    updatedAt: "2026-01-01T00:00:00",
  };

  return renderHookWithProviders(() => {
    const [target, setTarget] = useState<PageSummary>(TARGET_INITIAL);
    setTargetPage = setTarget;
    const workspace = useWorkspace();
    const pages = usePages();
    const undo = useUndoDelete();
    const actions = useRecurringActions(target);
    return {
      actions,
      pages,
      setTargetPage: (p: PageSummary) => setTargetPage(p),
      undo,
      workspace,
    };
  });
}

describe("useRecurringActions", () => {
  it("isVirtual is false for plain (non-virtual) pages", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    expect(hook.result.current.actions.isVirtual).toBe(false);
    expect(hook.result.current.actions.showsCheckbox).toBe(true);
  });

  it("a native virtual shows the repeat glyph, not a checkbox", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    const virtual: VirtualOccurrence = {
      createdAt: "2026-01-01T00:00:00",
      folderId: null,
      id: "page-1",
      isRecurring: false,
      isVirtual: true,
      originalDate: "2026-03-09",
      priority: 0,
      ruleId: "rule-1",
      scheduledEnd: "2026-03-09T10:00:00",
      scheduledStart: "2026-03-09T09:00:00",
      scheduleLocked: false,
      sortOrder: 0,
      status: "not_started",
      tags: [],
      title: "Standup",
      updatedAt: "2026-01-01T00:00:00",
    };

    act(() => {
      hook.result.current.setTargetPage(virtual);
    });

    expect(hook.result.current.actions.isVirtual).toBe(true);
    expect(hook.result.current.actions.showsCheckbox).toBe(false);
  });

  it("a synced-origin virtual shows a checkbox — it resolves per instance", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    const virtual: VirtualOccurrence = {
      createdAt: "2026-01-01T00:00:00",
      folderId: null,
      id: "page-1",
      isRecurring: false,
      isVirtual: true,
      originalDate: "2026-03-09",
      priority: 0,
      ruleId: "rule-1",
      scheduledEnd: "2026-03-09T10:00:00",
      scheduledStart: "2026-03-09T09:00:00",
      scheduleLocked: true,
      sortOrder: 0,
      status: "not_started",
      syncState: "active",
      tags: [],
      title: "Team standup",
      updatedAt: "2026-01-01T00:00:00",
    };

    act(() => {
      hook.result.current.setTargetPage(virtual);
    });

    expect(hook.result.current.actions.showsCheckbox).toBe(true);
  });

  it("toggleStatus does NOT route through completeRecurringPage when the page has no rule", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    act(() => {
      hook.result.current.actions.toggleStatus();
    });

    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("toggleStatus routes through completeRecurringPage when the head has a rule", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Standup" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    await act(async () => {
      hook.result.current.actions.toggleStatus();
      // Allow completeRecurringPage's awaited adapter calls to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ pageId }));
  });

  it("deleting a virtual dismisses it to the skip-set and registers an undoable toast", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    let ruleId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Standup" });
      pageId = p.id;
      const rule = await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    const virtual: VirtualOccurrence = {
      createdAt: "2026-01-01T00:00:00",
      folderId: null,
      id: pageId,
      isRecurring: false,
      isVirtual: true,
      originalDate: "2099-01-12",
      priority: 0,
      ruleId,
      scheduledEnd: null,
      scheduledStart: "2099-01-12T09:00:00",
      scheduleLocked: false,
      sortOrder: 0,
      status: "not_started",
      tags: [],
      title: "Standup",
      updatedAt: "2026-01-01T00:00:00",
    };

    act(() => {
      hook.result.current.setTargetPage(virtual);
    });

    await act(async () => {
      hook.result.current.actions.deleteBlock();
      await Promise.resolve();
      await Promise.resolve();
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId);
    expect(page?.skippedOccurrences).toEqual(["2099-01-12"]);
    // The toast queue holds the undo action so the user can dismiss-or-undo.
    expect(hook.result.current.undo.toastItems.length).toBeGreaterThan(0);
  });

  it("routes a scheduleLocked recurring toggle through the unified command with the client occurrence", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Synced standup" });
      pageId = p.id;
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    // A locked (active-synced) recurring head. The completion reads lockedness off
    // the stored row, not the toggle's input page, so mark it synced for real —
    // faking `scheduleLocked` on the target alone leaves the store native.
    await act(async () => {
      const storage = hook.result.current.workspace.storage as MockStorageAdapter;
      storage.markPageSynced(pageId, { state: "active", timezone: "America/New_York" });
      await hook.result.current.workspace.reload();
    });
    const base = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(base);
    });

    await act(async () => {
      hook.result.current.actions.toggleStatus();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Routed as synced: the one unified command is called with the client-supplied
    // occurrence, not the bare native shape.
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceDate: "2099-01-05", pageId })
    );
  });

  it("un-checking a done recurring head rewinds the last occurrence, not a plain flip", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Standup" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    // Complete once so the head carries a completed occurrence to rewind.
    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    const uncompleteSpy = vi.spyOn(MockStorageAdapter.prototype, "uncompleteRecurringOccurrence");
    const liveHead = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage({ ...liveHead, status: "done" });
    });

    await act(async () => {
      hook.result.current.actions.toggleStatus();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(uncompleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceDate: "2099-01-05", pageId })
    );
  });

  it("un-checking a recurring head with nothing completed falls back to a plain flip", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Standup" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    const uncompleteSpy = vi.spyOn(MockStorageAdapter.prototype, "uncompleteRecurringOccurrence");
    const liveHead = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage({ ...liveHead, status: "done" });
    });

    await act(async () => {
      hook.result.current.actions.toggleStatus();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No completed occurrence to rewind → the plain-flip fallback runs instead.
    expect(uncompleteSpy).not.toHaveBeenCalled();
    expect(hook.result.current.pages.pages.find((p) => p.id === pageId)?.status).toBe(
      "not_started"
    );
  });

  it("deleting a real page trashes the page", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const deleteSpy = vi.spyOn(MockStorageAdapter.prototype, "softDeletePage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    await act(async () => {
      hook.result.current.actions.deleteBlock();
      await Promise.resolve();
    });

    expect(deleteSpy).toHaveBeenCalledWith(pageId);
  });

  it("deleting a moved synced instance dismisses that occurrence, never the series", async () => {
    // A moved instance is shaped from its series page, so a page-level delete here
    // would trash the whole series — every other occurrence with it.
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const deleteSpy = vi.spyOn(MockStorageAdapter.prototype, "softDeletePage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Team standup" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      const storage = hook.result.current.workspace.storage as MockStorageAdapter;
      storage.markPageSynced(p.id, { state: "active", timezone: "America/New_York" });
      await hook.result.current.workspace.reload();
    });

    const series = hook.result.current.pages.pages.find((p) => p.id === pageId)!;
    act(() => {
      // No `isVirtual`: a materialised override renders as the page itself, moved.
      hook.result.current.setTargetPage({
        ...series,
        originalDate: "2099-01-12",
        scheduledStart: "2099-01-14T09:00:00",
      } as PageSummary);
    });

    await act(async () => {
      hook.result.current.actions.deleteBlock();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(
      hook.result.current.pages.pages.find((p) => p.id === pageId)?.skippedOccurrences
    ).toEqual(["2099-01-12"]);
  });
});
