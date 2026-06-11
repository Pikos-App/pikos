// Regression tests for the recurring-cluster write races (pre-launch audit
// 2026-06-10): re-entrant clone-minting calls, exdate read-modify-write
// clobbering, and completion racing the per-page mutation queue.

import { MockStorageAdapter } from "@pikos/core";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setupRecurringPage() {
  const hook = renderHookWithProviders(() => ({
    pages: usePages(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });

  let pageId!: string;
  let ruleId!: string;
  await act(async () => {
    const p = await hook.result.current.pages.createPage({ title: "Standup" });
    pageId = p.id;
    await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
    const rule = await hook.result.current.pages.createRecurrence({
      pageId: p.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2099-01-05T09:00:00",
      timezone: "America/New_York",
    });
    ruleId = rule.id;
  });

  return { hook, pageId, ruleId };
}

describe("completeRecurringPage idempotency", () => {
  // Completion advances the head AND inserts a fresh-UUID clone via the
  // backend. The checkbox path is fire-and-forget with no disabled state, so a
  // double-fire would complete two occurrences for one gesture — and now that
  // completion runs on the mutation queue, an unguarded second call would
  // SERIALIZE into a deterministic double completion instead of a racy one.
  it("drops a re-entrant completion — adapter is hit once, no duplicate clone", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await Promise.all([
        hook.result.current.pages.completeRecurringPage(pageId, "advance"),
        hook.result.current.pages.completeRecurringPage(pageId, "advance"),
      ]);
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const pages = hook.result.current.pages.pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
    const doneStandups = pages.filter((p) => p.title === "Standup" && p.status === "done");
    expect(doneStandups).toHaveLength(1);
  });

  it("clears the guard on settle so a later genuine completion still runs", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId, "advance");
    });
    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId, "advance");
    });

    expect(completeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("completeRecurringPage serialization behind the mutation queue", () => {
  // Drag-then-complete: scheduleOnce queues its DB writes (ending with the
  // trailing denorm updatePage). Completion used to bypass the queue, so that
  // trailing write could commit AFTER the completion's head advance and rewind
  // pages.scheduledStart to the just-completed occurrence — the page showed
  // both a done clone and a still-scheduled head at the same time.
  it("waits for an in-flight scheduleOnce before advancing the head", async () => {
    const { hook, pageId } = await setupRecurringPage();

    const callOrder: string[] = [];
    let releaseUpdate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseUpdate = resolve));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked with .call(this, …) inside the mock below
    const origUpdatePage = MockStorageAdapter.prototype.updatePage;
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockImplementation(async function (
      this: MockStorageAdapter,
      id,
      patch
    ) {
      // Hold open only the drag's denorm write (the one carrying scheduledStart).
      if ("scheduledStart" in patch) await gate;
      callOrder.push("updatePage");
      return origUpdatePage.call(this, id, patch);
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked with .call(this, …) inside the mock below
    const origComplete = MockStorageAdapter.prototype.completeRecurringPage;
    vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage").mockImplementation(function (
      this: MockStorageAdapter,
      data
    ) {
      callOrder.push("complete");
      return origComplete.call(this, data);
    });

    // Drag the head to a new time. Its queued DB writes are gated open; the
    // act lets React flush the optimistic state (as a render would between a
    // real drag and a click).
    let drag!: Promise<void>;
    act(() => {
      drag = hook.result.current.pages.scheduleOnce(pageId, "2099-01-06T10:00:00");
    });
    // Complete while the drag's writes are still in flight.
    let complete!: Promise<void>;
    act(() => {
      complete = hook.result.current.pages.completeRecurringPage(pageId, "advance");
    });
    await act(async () => {
      releaseUpdate();
      await Promise.all([drag, complete]);
    });

    // The completion must run after the drag's full write sequence.
    expect(callOrder.indexOf("complete")).toBeGreaterThan(callOrder.indexOf("updatePage"));

    // Head advanced from the DRAGGED date and stayed there — no rewind.
    const head = hook.result.current.pages.pages.find((p) => p.id === pageId);
    expect(head?.scheduledStart).toBe("2099-01-07T10:00:00");
  });
});

describe("rescheduleVirtualOccurrence", () => {
  it("drops a re-entrant reschedule of the same occurrence — one clone only", async () => {
    const { hook, ruleId } = await setupRecurringPage();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "rescheduleVirtualOccurrence");

    await act(async () => {
      await Promise.all([
        hook.result.current.pages.rescheduleVirtualOccurrence(
          ruleId,
          "2099-01-12",
          "2099-01-13T10:00:00"
        ),
        hook.result.current.pages.rescheduleVirtualOccurrence(
          ruleId,
          "2099-01-12",
          "2099-01-13T10:00:00"
        ),
      ]);
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const clones = hook.result.current.pages.pages.filter(
      (p) => p.title === "Standup" && p.scheduledStart === "2099-01-13T10:00:00"
    );
    expect(clones).toHaveLength(1);
    const rule = hook.result.current.pages.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rruleExdates).toEqual(["2099-01-12"]);
  });
});

describe("skipOccurrence undo", () => {
  // The undo closure used to restore the exdate array captured at skip time —
  // erasing any exdate persisted inside the undo-toast window and resurrecting
  // that occurrence. It must remove only its own date from the CURRENT row.
  it("preserves exdates written between the skip and its undo", async () => {
    const { hook, ruleId } = await setupRecurringPage();

    let undo!: () => void;
    await act(async () => {
      undo = await hook.result.current.pages.skipOccurrence(ruleId, "2099-01-12");
      // Interleaved writer inside the undo window: a second skip.
      await hook.result.current.pages.skipOccurrence(ruleId, "2099-01-19");
    });
    await act(async () => {
      undo();
      // The undo's adapter write is fire-and-forget; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const rule = hook.result.current.pages.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rruleExdates).toEqual(["2099-01-19"]);
  });
});
