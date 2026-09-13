// RecurringGapDialogContext — which gesture opens the scope prompt, and what
// each scope writes.
//
// The dialog is a gap-resolution tool: it only appears when the gesture lands
// inside a backlog of occurrences still open before today. Everything else
// commits straight away, so a steady-state tick stays instant. Both origins
// route through here, and the split between them is which occurrence a gesture
// names — a native series funnels to its head, a synced one ticks the instance
// the user pointed at.

import type { PageSchedule, PageSummary } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

// Head 2099-01-05 on a daily rule, "today" 2099-01-10 → 06..09 are the backlog
// behind a head tick.
const NOW = "2099-01-10T12:00:00";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(opts: { synced?: boolean } = {}) {
  const hook = renderHookWithProviders(() => ({
    dialog: useRecurringGapDialog(),
    pages: usePages(),
    workspace: useWorkspace(),
  }));
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
      rrule: "FREQ=DAILY",
      scheduledStart: "2099-01-05T09:00:00",
      timezone: "America/New_York",
    });
  });
  if (opts.synced) {
    // Connected before the head, so the render floor doesn't swallow the backlog —
    // occurrences that predate the connect day were never the user's to act on.
    await act(async () => {
      const storage = hook.result.current.workspace.storage as MockStorageAdapter;
      storage.markPageSynced(pageId, {
        state: "active",
        syncedSince: "2099-01-01",
        timezone: "America/New_York",
      });
      await hook.result.current.workspace.reload();
    });
  }
  return { hook, pageId };
}

type Hook = Awaited<ReturnType<typeof setup>>["hook"];

function head(hook: Hook, pageId: string): PageSummary {
  const p = hook.result.current.pages.pages.find((page) => page.id === pageId);
  if (!p) throw new Error("head page not found");
  return p;
}

function virtualAt(hook: Hook, pageId: string, date: string): PageSummary {
  return {
    ...head(hook, pageId),
    isVirtual: true,
    originalDate: date,
    scheduledStart: `${date}T09:00:00`,
  } as PageSummary;
}

function doneClones(hook: Hook): string[] {
  return hook.result.current.pages.pages
    .filter((p) => p.title === "Standup" && p.status === "done")
    .map((p) => p.scheduledStart ?? "")
    .sort();
}

describe("when the dialog opens", () => {
  it("an overdue head with a backlog opens it, listing the other open days", async () => {
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.dialog.requestComplete(head(hook, pageId));
    });

    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());
    expect(hook.result.current.dialog.pending).toMatchObject({
      kind: "complete",
      missedDates: ["2099-01-06", "2099-01-07", "2099-01-08", "2099-01-09"],
      occurrenceDate: "2099-01-05",
    });
  });

  it("excludes an already-skipped day from the backlog", async () => {
    const { hook, pageId } = await setup();
    await act(async () => {
      await hook.result.current.pages.skipOccurrences(pageId, ["2099-01-07"]);
    });

    act(() => {
      hook.result.current.dialog.requestComplete(head(hook, pageId));
    });

    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());
    expect(hook.result.current.dialog.pending!.missedDates).not.toContain("2099-01-07");
  });

  it("excludes a moved occurrence — an override row is not an open gap", async () => {
    const { hook, pageId } = await setup({ synced: true });
    const rule = hook.result.current.pages.recurrenceRules.find((r) => r.pageId === pageId)!;
    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedulesForRules").mockResolvedValue([
      {
        createdAt: "2099-01-01T00:00:00",
        id: "s1",
        originalDate: "2099-01-08T09:00:00",
        pageId,
        ruleId: rule.id,
        scheduledStart: "2099-01-14T09:00:00",
        status: "not_started",
      } satisfies PageSchedule,
    ]);

    act(() => {
      hook.result.current.dialog.requestComplete(virtualAt(hook, pageId, "2099-01-09"));
    });

    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());
    expect(hook.result.current.dialog.pending!.missedDates).not.toContain("2099-01-08");
  });

  it("a mirror connected today has no backlog — nothing below the floor was ever the user's", async () => {
    const hook = renderHookWithProviders(() => ({
      dialog: useRecurringGapDialog(),
      pages: usePages(),
      workspace: useWorkspace(),
    }));
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
        rrule: "FREQ=DAILY",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      const storage = hook.result.current.workspace.storage as MockStorageAdapter;
      storage.markPageSynced(pageId, { state: "active", timezone: "America/New_York" });
      await hook.result.current.workspace.reload();
    });

    await act(async () => {
      hook.result.current.dialog.requestComplete(virtualAt(hook, pageId, "2099-01-08"));
      await Promise.resolve();
    });

    expect(hook.result.current.dialog.pending).toBeNull();
  });

  it("a head that is not overdue completes instantly, no dialog", async () => {
    vi.setSystemTime(new Date("2099-01-01T12:00:00"));
    const { hook, pageId } = await setup();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      hook.result.current.dialog.requestComplete(head(hook, pageId));
      await Promise.resolve();
    });

    expect(hook.result.current.dialog.pending).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a gesture on a future occurrence completes instantly, backlog or not", async () => {
    // The dialog resolves a backlog; ticking next week has nothing to do with it.
    const { hook, pageId } = await setup({ synced: true });
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      hook.result.current.dialog.requestComplete(virtualAt(hook, pageId, "2099-01-20"));
      await Promise.resolve();
    });

    expect(hook.result.current.dialog.pending).toBeNull();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ occurrenceDate: "2099-01-20" });
  });
});

describe("completing through the dialog", () => {
  it("just this one completes the head's own occurrence and leaves the gap", async () => {
    const { hook, pageId } = await setup();
    act(() => {
      hook.result.current.dialog.requestComplete(head(hook, pageId));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());

    await act(async () => {
      hook.result.current.dialog.confirm("one");
      await Promise.resolve();
    });

    await waitFor(() => expect(doneClones(hook)).toEqual(["2099-01-05T09:00:00"]));
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-06T09:00:00");
  });

  it("everything before today clones each open day and lands the head on today", async () => {
    const { hook, pageId } = await setup();
    act(() => {
      hook.result.current.dialog.requestComplete(head(hook, pageId));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());

    await act(async () => {
      hook.result.current.dialog.confirm("all");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(doneClones(hook)).toEqual([
        "2099-01-05T09:00:00",
        "2099-01-06T09:00:00",
        "2099-01-07T09:00:00",
        "2099-01-08T09:00:00",
        "2099-01-09T09:00:00",
      ])
    );
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-10T09:00:00");
  });

  it("a synced occurrence's this-one completes that instance, not the head's", async () => {
    const { hook, pageId } = await setup({ synced: true });
    act(() => {
      hook.result.current.dialog.requestComplete(virtualAt(hook, pageId, "2099-01-08"));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());

    await act(async () => {
      hook.result.current.dialog.confirm("one");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(Object.keys(head(hook, pageId).completedOccurrences ?? {})).toEqual(["2099-01-08"])
    );
    expect(head(hook, pageId).completedOccurrences?.["2099-01-05"]).toBeUndefined();
  });

  it("a synced occurrence's all-to-today sweeps the rest of the backlog too", async () => {
    const { hook, pageId } = await setup({ synced: true });
    act(() => {
      hook.result.current.dialog.requestComplete(virtualAt(hook, pageId, "2099-01-08"));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());

    await act(async () => {
      hook.result.current.dialog.confirm("all");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(Object.keys(head(hook, pageId).completedOccurrences ?? {}).sort()).toEqual([
        "2099-01-05",
        "2099-01-06",
        "2099-01-07",
        "2099-01-08",
        "2099-01-09",
      ])
    );
  });
});

describe("deleting through the dialog", () => {
  it("just this one dismisses the gestured date only", async () => {
    const { hook, pageId } = await setup();
    act(() => {
      hook.result.current.dialog.requestDelete(virtualAt(hook, pageId, "2099-01-07"));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());
    expect(hook.result.current.dialog.pending!.kind).toBe("delete");

    await act(async () => {
      hook.result.current.dialog.confirm("one");
      await Promise.resolve();
    });

    await waitFor(() => expect(head(hook, pageId).skippedOccurrences).toEqual(["2099-01-07"]));
    expect(doneClones(hook)).toEqual([]);
  });

  it("everything before today dismisses the gestured date plus the backlog", async () => {
    const { hook, pageId } = await setup();
    act(() => {
      hook.result.current.dialog.requestDelete(virtualAt(hook, pageId, "2099-01-07"));
    });
    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());

    await act(async () => {
      hook.result.current.dialog.confirm("all");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect([...(head(hook, pageId).skippedOccurrences ?? [])].sort()).toEqual([
        "2099-01-05",
        "2099-01-06",
        "2099-01-07",
        "2099-01-08",
        "2099-01-09",
      ])
    );
    // Dismissals never mint a clone, and the head walks past every skipped day.
    expect(doneClones(hook)).toEqual([]);
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-10T09:00:00");
  });

  it("no backlog behind it dismisses instantly, no dialog", async () => {
    const { hook, pageId } = await setup();
    await act(async () => {
      await hook.result.current.pages.skipOccurrences(pageId, [
        "2099-01-05",
        "2099-01-06",
        "2099-01-07",
        "2099-01-08",
      ]);
    });

    await act(async () => {
      hook.result.current.dialog.requestDelete(virtualAt(hook, pageId, "2099-01-09"));
      await Promise.resolve();
    });

    expect(hook.result.current.dialog.pending).toBeNull();
    await waitFor(() => expect(head(hook, pageId).skippedOccurrences).toContain("2099-01-09"));
  });

  it("marks an active mirror's dismissal as local-only", async () => {
    const { hook, pageId } = await setup({ synced: true });

    act(() => {
      hook.result.current.dialog.requestDelete(virtualAt(hook, pageId, "2099-01-07"));
    });

    await waitFor(() => expect(hook.result.current.dialog.pending).not.toBeNull());
    expect(hook.result.current.dialog.pending!.syncedActive).toBe(true);
  });
});
