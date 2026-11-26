// Write races in the recurring cluster: re-entrant clone-minting calls, exdate read-modify-write
// clobbering, and completion racing the per-page mutation queue.

import { formatLocalISO, resolveSyncedInstant } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setupRecurringPage() {
  const hook = renderHookWithProviders(() => ({
    pages: usePagesNow(),
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
  // The checkbox path is fire-and-forget, so a double-fire would complete two occurrences for one
  // gesture. Completion runs on the mutation queue, so an unguarded second call would serialize
  // into a deterministic double completion.
  it("drops a re-entrant completion — adapter is hit once, no duplicate clone", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await Promise.all([
        hook.result.current.pages.completeRecurringPage(pageId),
        hook.result.current.pages.completeRecurringPage(pageId),
      ]);
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const pages = hook.result.current.pages.pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
    const doneStandups = pages.filter((p) => p.title === "Standup" && p.status === "done");
    expect(doneStandups).toHaveLength(1);
  });

  it("keeps one copy of the clone when a fetch lands it before the completion returns", async () => {
    const { hook, pageId } = await setupRecurringPage();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked with .call(this, …) inside the mock below
    const origComplete = MockStorageAdapter.prototype.completeRecurringPage;
    vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage").mockImplementation(
      async function (this: MockStorageAdapter, data) {
        const result = await origComplete.call(this, data);
        hook.result.current.pages.mergePages([result.clone]);
        return result;
      }
    );

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    const pages = hook.result.current.pages.pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
  });

  it("clears the guard on settle so a later genuine completion still runs", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });
    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    expect(completeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("completeRecurringPage payload", () => {
  const NOW = "2099-01-10T12:00:00";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a native head names the occurrence it saw and lets the backend derive the rest", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ expectedOccurrenceDate: "2099-01-05", pageId });
  });

  it("a synced head sends its occurrence and no expectation — the reconciler owns its head", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");
    const head = hook.result.current.pages.pages.find((p) => p.id === pageId)!;

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId, {
        ...head,
        detachIsReversible: false,
        scheduleLocked: true,
        timezone: null,
      });
    });

    expect(spy.mock.calls[0]![0]).not.toHaveProperty("expectedOccurrenceDate");
  });

  it("completes the head off the passed-in override, not the lagging pages state", async () => {
    // Each step chains off the previous call's recomputed head: React state would re-send the same
    // occurrence and the backend's idempotency would stall the run after one completion.
    const { hook, pageId } = await setupRecurringPage();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");
    const stale = hook.result.current.pages.pages.find((p) => p.id === pageId)!;

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId, {
        ...stale,
        detachIsReversible: false,
        scheduledStart: "2099-01-08T09:00:00",
        scheduleLocked: true,
        timezone: null,
      });
    });

    expect(spy.mock.calls[0]![0]).toMatchObject({ occurrenceDate: "2099-01-08" });
  });
});

describe("completeRecurringToToday", () => {
  const NOW = "2099-01-10T12:00:00";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clones every open occurrence up to today and leaves the head on today", async () => {
    const { hook, pageId } = await setupRecurringPage();

    await act(async () => {
      await hook.result.current.pages.completeRecurringToToday(pageId, { maxSteps: 20 });
    });

    const clones = hook.result.current.pages.pages.filter(
      (p) => p.title === "Standup" && p.status === "done"
    );
    expect(clones.map((p) => p.scheduledStart).sort()).toEqual([
      "2099-01-05T09:00:00",
      "2099-01-06T09:00:00",
      "2099-01-07T09:00:00",
      "2099-01-08T09:00:00",
      "2099-01-09T09:00:00",
    ]);
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-10T09:00:00");
  });

  it("stops at the step budget", async () => {
    const { hook, pageId } = await setupRecurringPage();

    await act(async () => {
      await hook.result.current.pages.completeRecurringToToday(pageId, { maxSteps: 2 });
    });

    expect(
      hook.result.current.pages.pages.filter((p) => p.title === "Standup" && p.status === "done")
    ).toHaveLength(2);
  });

  it("does nothing when the head is not overdue", async () => {
    vi.setSystemTime(new Date("2099-01-01T12:00:00"));
    const { hook, pageId } = await setupRecurringPage();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringToToday(pageId, { maxSteps: 20 });
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("completeRecurringPage serialization behind the mutation queue", () => {
  // Completion outside the queue would let the drag's trailing denorm write commit AFTER the head
  // advance and rewind pages.scheduledStart to the just-completed occurrence.
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

    let drag!: Promise<void>;
    act(() => {
      drag = hook.result.current.pages.scheduleOnce(pageId, "2099-01-06T10:00:00");
    });
    let complete!: Promise<unknown>;
    act(() => {
      complete = hook.result.current.pages.completeRecurringPage(pageId);
    });
    await act(async () => {
      releaseUpdate();
      await Promise.all([drag, complete]);
    });

    expect(callOrder.indexOf("complete")).toBeGreaterThan(callOrder.indexOf("updatePage"));

    const head = hook.result.current.pages.pages.find((p) => p.id === pageId);
    expect(head?.scheduledStart).toBe("2099-01-07T10:00:00");
  });
});

describe("rescheduleVirtualOccurrence", () => {
  it("an in-place override move adds no page and bumps overridesVersion", async () => {
    // A provider-moved occurrence already has an override row, so the backend moves it and returns
    // no clone: nothing enters the page list, hence the counter.
    const { hook, ruleId } = await setupRecurringPage();
    const pageCount = hook.result.current.pages.pages.length;
    const version = hook.result.current.pages.overridesVersion;
    vi.spyOn(MockStorageAdapter.prototype, "rescheduleVirtualOccurrence").mockResolvedValue({
      clone: null,
      ruleExdates: [],
    });

    await act(async () => {
      await hook.result.current.pages.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-13T10:00:00"
      );
    });

    expect(hook.result.current.pages.pages).toHaveLength(pageCount);
    expect(hook.result.current.pages.overridesVersion).toBe(version + 1);
  });

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

describe("synced recurring completion routing", () => {
  // A synced series must call the unified command with the client-supplied occurrence, never the
  // bare native shape, so no entry point advances the reconciler-pinned head off a server date.
  it("routes an active synced series through the unified command with the client occurrence", async () => {
    const { hook, pageId } = await setupRecurringPage();
    const storage = hook.result.current.workspace.storage as MockStorageAdapter;
    await act(async () => {
      // Tokyo, not London: the runner is pinned to UTC, so a January London source converts to itself
      // and an unconverted wall-clock would read as correct.
      storage.markPageSynced(pageId, { state: "active", timezone: "Asia/Tokyo" });
      await hook.result.current.workspace.reload();
    });

    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    // The occurrence keeps its source-zone day (the completed set's key) while the clone's
    // wall-clock is the viewer's.
    expect(completeSpy.mock.calls[0]?.[0]).toMatchObject({
      occurrenceDate: "2099-01-05",
      pageId,
      scheduledStart: "2099-01-05T00:00:00",
    });
  });
});

describe("skipOccurrences", () => {
  // Undo removes only its own dates, leaving a skip written inside the undo-toast window intact.
  it("preserves a skip written between the skip and its undo", async () => {
    const { hook, pageId } = await setupRecurringPage();

    let undo!: () => void;
    await act(async () => {
      undo = await hook.result.current.pages.skipOccurrences(pageId, ["2099-01-12"]);
      await hook.result.current.pages.skipOccurrences(pageId, ["2099-01-19"]);
    });
    await act(async () => {
      undo();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const page = hook.result.current.pages.pages.find((p) => p.id === pageId);
    expect(page?.skippedOccurrences).toEqual(["2099-01-19"]);
  });

  it("a bulk dismissal covering the head's own date advances the head", async () => {
    // Only the delete dialog's "all to today" arm can skip the head's date; the local skip list
    // alone would leave the head on a dismissed day.
    const { hook, pageId } = await setupRecurringPage();

    await act(async () => {
      await hook.result.current.pages.skipOccurrences(pageId, [
        "2099-01-05",
        "2099-01-06",
        "2099-01-07",
      ]);
    });

    expect(head(hook, pageId).scheduledStart).toBe("2099-01-08T09:00:00");
  });

  it("undoing a bulk dismissal restores the head with the dates", async () => {
    const { hook, pageId } = await setupRecurringPage();

    let undo!: () => void;
    await act(async () => {
      undo = await hook.result.current.pages.skipOccurrences(pageId, ["2099-01-05", "2099-01-06"]);
    });
    await act(async () => {
      undo();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(head(hook, pageId).scheduledStart).toBe("2099-01-05T09:00:00");
    expect(head(hook, pageId).skippedOccurrences ?? []).toEqual([]);
  });
});

// Completion writes against the occurrence's own date (never the head's) and stores the done
// clone at the viewer-local wall clock for a zoned timed event.

type Hook = Awaited<ReturnType<typeof setupRecurringPage>>["hook"];

async function setupSyncedRecurring(
  scheduledStart: string,
  timezone: string,
  scheduledEnd?: string
): Promise<{ hook: Hook; pageId: string }> {
  const hook = renderHookWithProviders(() => ({
    pages: usePagesNow(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });

  let pageId!: string;
  await act(async () => {
    const p = await hook.result.current.pages.createPage({ title: "Synced standup" });
    pageId = p.id;
    await hook.result.current.pages.scheduleOnce(p.id, scheduledStart, scheduledEnd);
    await hook.result.current.pages.createRecurrence({
      pageId: p.id,
      rrule: "FREQ=DAILY",
      scheduledStart,
      ...(scheduledEnd !== undefined && { scheduledEnd }),
      timezone,
    });
  });
  await act(async () => {
    const storage = hook.result.current.workspace.storage as MockStorageAdapter;
    storage.markPageSynced(pageId, { state: "active", timezone });
    await hook.result.current.workspace.reload();
  });

  return { hook, pageId };
}

function head(hook: Hook, pageId: string) {
  const p = hook.result.current.pages.pages.find((page) => page.id === pageId);
  if (!p) throw new Error("head page not found");
  return p;
}

describe("completeSyncedOccurrence", () => {
  it("completes a rendered occurrence on its own date, not the head's", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05T09:00:00", "America/New_York");
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence({
        occurrenceDate: "2099-01-12",
        pageId,
        scheduledStart: "2099-01-12T09:00:00",
      });
    });

    expect(completeSpy.mock.calls[0]?.[0]).toMatchObject({ occurrenceDate: "2099-01-12" });
  });

  it("drops a re-entrant completion of the same occurrence — one clone, no duplicate", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05T09:00:00", "America/New_York");
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    const occurrence = {
      occurrenceDate: "2099-01-05",
      pageId,
      scheduledStart: "2099-01-05T09:00:00",
    };
    await act(async () => {
      await Promise.all([
        hook.result.current.pages.completeSyncedOccurrence(occurrence),
        hook.result.current.pages.completeSyncedOccurrence(occurrence),
      ]);
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const pages = hook.result.current.pages.pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
    expect(pages.filter((p) => p.title === "Synced standup" && p.status === "done")).toHaveLength(
      1
    );
  });

  it("a settled re-completion of the SAME occurrence replaces the clone in state — no duplicate row", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05T09:00:00", "America/New_York");
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    const occurrence = {
      occurrenceDate: "2099-01-05",
      pageId,
      scheduledStart: "2099-01-05T09:00:00",
    };
    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence(occurrence);
    });
    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence(occurrence);
    });

    expect(completeSpy).toHaveBeenCalledTimes(2);
    const pages = hook.result.current.pages.pages;
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
    expect(pages.filter((p) => p.title === "Synced standup" && p.status === "done")).toHaveLength(
      1
    );
  });
});

describe("maybeUncompleteRecurringClone", () => {
  it("unchecking a done clone routes to uncompleteRecurringOccurrence with the series id + date", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05T09:00:00", "America/New_York");
    const uncompleteSpy = vi.spyOn(MockStorageAdapter.prototype, "uncompleteRecurringOccurrence");

    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence({
        occurrenceDate: "2099-01-05",
        pageId,
        scheduledStart: "2099-01-05T09:00:00",
      });
    });
    const cloneId = head(hook, pageId).completedOccurrences?.["2099-01-05"] ?? "";
    const clone = hook.result.current.pages.pages.find((p) => p.id === cloneId)!;

    let handled!: boolean;
    act(() => {
      handled = hook.result.current.pages.maybeUncompleteRecurringClone(clone, "not_started");
    });

    expect(handled).toBe(true);
    expect(uncompleteSpy).toHaveBeenCalledTimes(1);
    expect(uncompleteSpy.mock.calls[0]?.[0]).toMatchObject({
      occurrenceDate: "2099-01-05",
      pageId,
    });
  });

  it("leaves a tick alone — completion is the gap dialog's to route", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05T09:00:00", "America/New_York");
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    let handled!: boolean;
    act(() => {
      handled = hook.result.current.pages.maybeUncompleteRecurringClone(head(hook, pageId), "done");
    });

    expect(handled).toBe(false);
    expect(completeSpy).not.toHaveBeenCalled();
  });
});

describe("viewerWallClock", () => {
  it("converts a timed zoned occurrence's clone start to the viewer-local instant", async () => {
    const { hook, pageId } = await setupSyncedRecurring(
      "2099-01-05T15:00:00",
      "America/Los_Angeles",
      "2099-01-05T16:00:00"
    );
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence({
        occurrenceDate: "2099-01-05",
        pageId,
        scheduledEnd: "2099-01-05T16:00:00",
        scheduledStart: "2099-01-05T15:00:00",
      });
    });

    // Under TZ=UTC the viewer zone is UTC.
    const expectedStart = formatLocalISO(
      resolveSyncedInstant("2099-01-05T15:00:00", "America/Los_Angeles")
    );
    const expectedEnd = formatLocalISO(
      resolveSyncedInstant("2099-01-05T16:00:00", "America/Los_Angeles")
    );
    expect(expectedStart).not.toBe("2099-01-05T15:00:00");
    expect(completeSpy.mock.calls[0]?.[0]).toMatchObject({
      occurrenceDate: "2099-01-05",
      scheduledEnd: expectedEnd,
      scheduledStart: expectedStart,
    });
  });

  it("converts the head's wall-clock too, when a head tick drives it", async () => {
    // A synced head names its own occurrence, so the conversion applies on the
    // completeRecurringPage path too, or a head tick would clone the source-zone wall-clock.
    const { hook, pageId } = await setupSyncedRecurring(
      "2099-01-05T15:00:00",
      "America/Los_Angeles",
      "2099-01-05T16:00:00"
    );
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });

    expect(completeSpy.mock.calls[0]?.[0]).toMatchObject({
      occurrenceDate: "2099-01-05",
      scheduledEnd: formatLocalISO(
        resolveSyncedInstant("2099-01-05T16:00:00", "America/Los_Angeles")
      ),
      scheduledStart: formatLocalISO(
        resolveSyncedInstant("2099-01-05T15:00:00", "America/Los_Angeles")
      ),
    });
  });

  it("passes an all-day (date-only) start through unchanged", async () => {
    const { hook, pageId } = await setupSyncedRecurring("2099-01-05", "America/Los_Angeles");
    const completeSpy = vi.spyOn(MockStorageAdapter.prototype, "completeRecurringPage");

    await act(async () => {
      await hook.result.current.pages.completeSyncedOccurrence({
        occurrenceDate: "2099-01-05",
        pageId,
        scheduledStart: "2099-01-05",
      });
    });

    expect(completeSpy.mock.calls[0]?.[0]).toMatchObject({
      occurrenceDate: "2099-01-05",
      scheduledStart: "2099-01-05",
    });
  });
});

// 2099-01-05 = Mon, 06 = Tue, 07 = Wed. A head dragged onto Tue (a day M/W/F can't yield) must
// land on the next rule day (Wed) and survive an on-load heal.
describe("scheduleOnce head-drag snapping (U6-F1)", () => {
  async function setupWeeklyMWF() {
    const hook = renderHookWithProviders(() => ({
      pages: usePagesNow(),
      workspace: useWorkspace(),
    }));
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Gym" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T10:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
        scheduledStart: "2099-01-05T10:00:00",
        timezone: "America/New_York",
      });
    });
    return { hook, pageId };
  }

  it("snaps an off-pattern drop (Tue) forward to the nearest rule day (Wed)", async () => {
    const { hook, pageId } = await setupWeeklyMWF();
    await act(async () => {
      await hook.result.current.pages.scheduleOnce(pageId, "2099-01-06T10:00:00");
    });
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-07T10:00:00");
  });

  it("the snapped head survives an on-load heal unchanged", async () => {
    const { hook, pageId } = await setupWeeklyMWF();
    await act(async () => {
      await hook.result.current.pages.scheduleOnce(pageId, "2099-01-06T10:00:00");
    });
    await act(async () => {
      await hook.result.current.workspace.reload();
    });
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-07T10:00:00");
  });

  // Asserted on the rule row: the head is re-derived and its end rebuilt from time-of-day, which
  // would hide an end that landed before its start.
  it("carries the block's end the same distance, so it can't precede the start", async () => {
    const { hook, pageId } = await setupWeeklyMWF();
    await act(async () => {
      await hook.result.current.pages.scheduleOnce(
        pageId,
        "2099-01-06T10:00:00",
        "2099-01-06T11:30:00"
      );
    });
    const rule = hook.result.current.pages.recurrenceRules.find((r) => r.pageId === pageId)!;
    expect(rule.scheduledStart).toBe("2099-01-07T10:00:00");
    expect(rule.scheduledEnd).toBe("2099-01-07T11:30:00");
  });
});

describe("scheduleOnce head-drag realign fidelity", () => {
  async function setupWeeklyRule(rrule: string) {
    const hook = renderHookWithProviders(() => ({
      pages: usePagesNow(),
      workspace: useWorkspace(),
    }));
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "Standup" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T10:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule,
        scheduledStart: "2099-01-05T10:00:00",
        timezone: "America/New_York",
      });
    });
    await act(async () => {
      await hook.result.current.pages.scheduleOnce(pageId, "2099-01-07T10:00:00");
    });
    return hook.result.current.pages.recurrenceRules.find((r) => r.pageId === pageId)!;
  }

  it("realigns BYDAY to the moved weekday and keeps BYMONTH", async () => {
    const rule = await setupWeeklyRule("FREQ=WEEKLY;BYDAY=MO;BYMONTH=1");
    expect(rule.rrule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;BYMONTH=1");
  });

  it("leaves a degrade-locked rule verbatim", async () => {
    // BYHOUR is outside the engine's envelope, so the series renders nowhere either way.
    const rule = await setupWeeklyRule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9");
    expect(rule.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9");
  });
});

describe("uncompleteRecurringHead (U6-F2)", () => {
  async function setupFiniteSeries() {
    const hook = renderHookWithProviders(() => ({
      pages: usePagesNow(),
      workspace: useWorkspace(),
    }));
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    let pageId!: string;
    await act(async () => {
      const p = await hook.result.current.pages.createPage({ title: "One-shot" });
      pageId = p.id;
      await hook.result.current.pages.scheduleOnce(p.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: p.id,
        rrule: "FREQ=DAILY;COUNT=1",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });
    return { hook, pageId };
  }

  it("un-marks an exhausted head and the un-done survives a heal", async () => {
    const { hook, pageId } = await setupFiniteSeries();
    await act(async () => {
      await hook.result.current.pages.completeRecurringPage(pageId);
    });
    expect(head(hook, pageId).status).toBe("done");

    let handled!: boolean;
    await act(async () => {
      handled = await hook.result.current.pages.uncompleteRecurringHead(pageId);
    });
    expect(handled).toBe(true);
    expect(head(hook, pageId).status).toBe("not_started");
    expect(head(hook, pageId).scheduledStart).toBe("2099-01-05T09:00:00");

    await act(async () => {
      await hook.result.current.workspace.reload();
    });
    expect(head(hook, pageId).status).toBe("not_started");
  });

  it("falls back (returns false) for a head with no completed-set entry", async () => {
    const { hook, pageId } = await setupFiniteSeries();
    let handled!: boolean;
    await act(async () => {
      handled = await hook.result.current.pages.uncompleteRecurringHead(pageId);
    });
    expect(handled).toBe(false);
  });
});
