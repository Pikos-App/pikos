// useRecurringActions — routes recurring-page interactions on calendar blocks.
//
// Verifies the three branches the hook's caller (PageBlock, AllDayBar) cares
// about: (1) a real-page status toggle without a rule writes status normally;
// (2) a real-page status toggle WITH a rule routes through completeRecurring
// (clone + advance); (3) skipOccurrence on a virtual page adds an exdate and
// queues an undo via the UndoDeleteContext.

import type { PageSummary, VirtualOccurrence } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIProvider } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace, WorkspaceProvider } from "@/shared/context/WorkspaceContext";

import { useRecurringActions } from "./useRecurringActions";

vi.stubEnv("VITE_TEST_MODE", "true");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <UIProvider>
        <UndoDeleteProvider>{children}</UndoDeleteProvider>
      </UIProvider>
    </WorkspaceProvider>
  );
}

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
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "placeholder",
    updatedAt: "2026-01-01T00:00:00",
  };

  return renderHook(
    () => {
      const [target, setTarget] = useState<PageSummary>(TARGET_INITIAL);
      setTargetPage = setTarget;
      const workspace = useWorkspace();
      const undo = useUndoDelete();
      const actions = useRecurringActions(target);
      return { actions, setTargetPage: (p: PageSummary) => setTargetPage(p), undo, workspace };
    },
    { wrapper }
  );
}

describe("useRecurringActions", () => {
  it("isRecurring is false for plain (non-virtual) pages", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.workspace.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.workspace.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    expect(hook.result.current.actions.isRecurring).toBe(false);
  });

  it("isRecurring is true when the page carries isVirtual", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    const virtual: VirtualOccurrence = {
      createdAt: "2026-01-01T00:00:00",
      folderId: null,
      id: "page-1",
      isVirtual: true,
      originalDate: "2026-03-09",
      priority: 0,
      ruleId: "rule-1",
      scheduledEnd: "2026-03-09T10:00:00",
      scheduledStart: "2026-03-09T09:00:00",
      sortOrder: 0,
      status: "not_started",
      tags: [],
      title: "Standup",
      updatedAt: "2026-01-01T00:00:00",
    };

    act(() => {
      hook.result.current.setTargetPage(virtual);
    });

    expect(hook.result.current.actions.isRecurring).toBe(true);
  });

  it("toggleStatus does NOT route through completeRecurringPage when the page has no rule", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.workspace.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.workspace.pages.find((p) => p.id === pageId)!;
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
      const p = await hook.result.current.workspace.createPage({ title: "Standup" });
      pageId = p.id;
      await hook.result.current.workspace.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.workspace.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    const page = hook.result.current.workspace.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    await act(async () => {
      hook.result.current.actions.toggleStatus();
      // Allow completeRecurringPage's awaited adapter calls to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ nextScheduledStart: "2099-01-12T09:00:00", pageId })
    );
  });

  it("skipOccurrence on a virtual page adds an exdate and registers an undoable toast", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let pageId!: string;
    let ruleId!: string;
    await act(async () => {
      const p = await hook.result.current.workspace.createPage({ title: "Standup" });
      pageId = p.id;
      const rule = await hook.result.current.workspace.createRecurrence({
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
      isVirtual: true,
      originalDate: "2099-01-12",
      priority: 0,
      ruleId,
      scheduledEnd: null,
      scheduledStart: "2099-01-12T09:00:00",
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
      await hook.result.current.actions.skipOccurrence();
    });

    const rule = hook.result.current.workspace.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rruleExdates).toEqual(["2099-01-12"]);
    // The toast queue holds the undo action so the user can dismiss-or-undo.
    expect(hook.result.current.undo.toastItems.length).toBeGreaterThan(0);
  });

  it("skipOccurrence is a no-op for non-virtual pages", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    const updateRuleSpy = vi.spyOn(MockStorageAdapter.prototype, "updateRecurrenceRule");

    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.workspace.createPage({ title: "Plain" });
      pageId = p.id;
    });

    const page = hook.result.current.workspace.pages.find((p) => p.id === pageId)!;
    act(() => {
      hook.result.current.setTargetPage(page);
    });

    await act(async () => {
      await hook.result.current.actions.skipOccurrence();
    });

    expect(updateRuleSpy).not.toHaveBeenCalled();
  });
});
