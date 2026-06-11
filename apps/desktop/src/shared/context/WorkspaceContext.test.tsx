// Data layer — unit tests for optimistic state management.
//
// Strategy: run in VITE_TEST_MODE so the provider uses MockStorageAdapter
// and skips all Tauri APIs. Spy on MockStorageAdapter prototype methods to
// control timing and inject failures without touching real I/O. The test
// covers PagesContext (CRUD, scheduling, recurrence) and the workspace
// lifecycle hooks it composes with.

import type { Page } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import { act } from "@testing-library/react";
import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Render the lifecycle + data hooks merged into one object so existing
 * `hook.result.current.X` accesses keep working across both. No field
 * collisions: lifecycle owns workspace/isLoading/on/storage/etc., data owns
 * pages/folders/CRUD/scheduling/recurrence. */
async function setup() {
  const hook = renderHookWithProviders(() => ({ ...useWorkspace(), ...usePages() }));

  await act(async () => {
    await hook.result.current.selectWorkspace();
  });

  let page!: Page;
  await act(async () => {
    page = await hook.result.current.createPage({ title: "Test Page" });
  });

  return { hook, page };
}

// Restore mocks and timers before AND after each test.
// beforeEach guards against contamination when a previous test times out
// without reaching its afterEach.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Optimistic updates ───────────────────────────────────────────────────────

describe("updatePage — optimistic update", () => {
  it("applies the patch to React state immediately (before the debounce fires)", async () => {
    vi.useFakeTimers();
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Instant" });
    });

    // No timer advance yet — state should already reflect the change
    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe("Instant");
  });

  it("accumulates multiple rapid patches into a single DB call", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Draft 1" });
      hook.result.current.updatePage(page.id, { title: "Draft 2" });
      hook.result.current.updatePage(page.id, { status: "done" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    // Only one DB write, carrying the merged patch
    expect(spy).toHaveBeenCalledOnce();
    const [, patch] = spy.mock.calls[0]!;
    expect(patch).toMatchObject({ status: "done", title: "Draft 2" });
  });

  it("flushes a status change immediately, without the 800ms debounce", async () => {
    // Completion gates the native notification scheduler (reads pages.status
    // straight from SQLite), so the write must not sit in the debounce window —
    // otherwise a reminder can fire for a page the user just marked done.
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    await act(async () => {
      hook.result.current.updatePage(page.id, { status: "done" });
      // Drain microtasks WITHOUT advancing the 800ms debounce window.
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, patch] = spy.mock.calls[0]!;
    expect(patch).toMatchObject({ status: "done" });
  });

  it("rolls back React state and sets pageErrors when the DB write fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockRejectedValueOnce(
      new Error("write failed")
    );
    const { hook, page } = await setup();
    const originalTitle = page.title;

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Doomed" });
    });

    // Advance past debounce — timer fires, DB rejects, catch block rolls back
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    // Do NOT use waitFor here — it polls via setTimeout which is faked and will hang.
    // advanceTimersByTimeAsync drains microtasks so state is settled after the act.
    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe(originalTitle);
    expect(hook.result.current.pageErrors.get(page.id)?.message).toMatch("write failed");
  });
});

// ─── flushPage ────────────────────────────────────────────────────────────────

describe("flushPage", () => {
  it("writes immediately without waiting for the debounce timer", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Flushed" });
    });

    // Flush before the 800ms window
    await act(async () => {
      await hook.result.current.flushPage(page.id);
    });

    expect(spy).toHaveBeenCalledOnce();
    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe("Flushed");
  });

  it("does not double-write if the debounce timer fires after a flush", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Once" });
    });

    await act(async () => {
      await hook.result.current.flushPage(page.id);
    });

    // Advance past the debounce window — no second write should fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(spy).toHaveBeenCalledOnce();
  });
});

// ─── scheduleOnce ─────────────────────────────────────────────────────────────

describe("scheduleOnce", () => {
  it("applies scheduledStart to React state before the DB round-trip completes", async () => {
    const { hook, page } = await setup();
    const start = "2026-03-15T10:00:00";

    // Never resolves — simulates a permanently pending DB call.
    // The enqueue chain calls listPageSchedules as a microtask, so resolving it
    // synchronously in the same tick isn't possible. Using a hanging mock is simpler
    // and still proves the optimistic update fired before any DB I/O completed.
    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockImplementation(
      () => new Promise<[]>(() => {}) // intentionally never resolves
    );

    // setPages fires synchronously inside scheduleOnce (before any await in its body),
    // so a sync act is sufficient to flush the React re-render.
    act(() => {
      void hook.result.current.scheduleOnce(page.id, start);
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.scheduledStart).toBe(start);
  });

  it("rolls back React state and sets pageErrors when the DB write fails", async () => {
    const { hook, page } = await setup();
    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockRejectedValueOnce(
      new Error("schedule error")
    );

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2026-03-15T10:00:00").catch(() => {});
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.scheduledStart).toBeUndefined();
    expect(hook.result.current.pageErrors.get(page.id)?.message).toMatch("schedule error");
  });
});

// ─── Mutation queue serialisation ─────────────────────────────────────────────

describe("mutation queue", () => {
  it("serialises flushPage + scheduleOnce: listPageSchedules waits for updatePage to resolve", async () => {
    const { hook, page } = await setup();

    const callOrder: string[] = [];
    let resolveUpdate!: (p: Page) => void;

    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockImplementationOnce(
      () =>
        new Promise<Page>((resolve) => {
          callOrder.push("updatePage:start");
          resolveUpdate = resolve;
        })
    );

    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockImplementation(() => {
      callOrder.push("listPageSchedules:start");
      return Promise.resolve([]);
    });

    // Queue an updatePage write synchronously via flushPage
    act(() => {
      hook.result.current.updatePage(page.id, { title: "queued" });
    });

    // flushPage cancels the debounce and enqueues immediately
    const flushPromise = hook.result.current.flushPage(page.id);

    // scheduleOnce enqueues behind the updatePage write
    const schedulePromise = hook.result.current
      .scheduleOnce(page.id, "2026-03-15T10:00:00")
      .catch(() => {});

    // Give microtasks a chance to run — updatePage should have started
    await Promise.resolve();
    await Promise.resolve();

    // listPageSchedules must not have fired yet (queued behind updatePage)
    expect(callOrder).toEqual(["updatePage:start"]);

    // Unblock updatePage
    resolveUpdate({ ...page, title: "queued", updatedAt: new Date().toISOString() });

    await act(async () => {
      await Promise.all([flushPromise, schedulePromise]);
    });

    // listPageSchedules ran only after updatePage resolved — correct order
    expect(callOrder).toEqual(["updatePage:start", "listPageSchedules:start"]);
  });

  // Simulates a user rapidly making a title change and a schedule change.
  // The mutation queue serialises both writes so neither is lost.
  it("applies both concurrent updatePage + scheduleOnce without losing either change", async () => {
    const { hook, page } = await setup();
    // Use a future date so _refreshDenorm picks it up (filters >= today)
    const start = "2099-03-15T10:00:00";

    // 1. updatePage queues a debounced write (title change applied optimistically)
    act(() => {
      hook.result.current.updatePage(page.id, { title: "concurrent update" });
    });

    // 2. scheduleOnce enqueues an immediate DB write (scheduledStart applied optimistically)
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, start);
    });

    // 3. Flush the debounced title write
    await act(async () => {
      await hook.result.current.flushPage(page.id);
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe("concurrent update");
    expect(found?.scheduledStart).toBe(start);
    expect(hook.result.current.pageErrors.size).toBe(0);
  });

  it("continues executing queued writes after a failed write (queue never stalls)", async () => {
    const { hook, page } = await setup();
    const callOrder: string[] = [];

    vi.spyOn(MockStorageAdapter.prototype, "updatePage")
      .mockImplementationOnce(() => {
        callOrder.push("A");
        return Promise.reject(new Error("write A failed"));
      })
      .mockImplementationOnce((_id, patch) => {
        callOrder.push("B");
        return Promise.resolve({ ...page, ...patch, updatedAt: new Date().toISOString() } as Page);
      });

    // Enqueue write A
    act(() => {
      hook.result.current.updatePage(page.id, { title: "A" });
    });
    const flushA = hook.result.current.flushPage(page.id);

    // Enqueue write B behind A — should run even though A will fail
    act(() => {
      hook.result.current.updatePage(page.id, { title: "B" });
    });
    const flushB = hook.result.current.flushPage(page.id);

    await act(async () => {
      await Promise.allSettled([flushA, flushB]);
    });

    expect(callOrder).toEqual(["A", "B"]);
  });
});

// ─── reorderPages ─────────────────────────────────────────────────────────────

describe("reorderPages — optimistic", () => {
  it("reorders React state immediately without waiting for the DB", async () => {
    const { hook } = await setup();

    let page2!: Page;
    await act(async () => {
      page2 = await hook.result.current.createPage({ title: "Page 2" });
    });

    const [first, second] = hook.result.current.pages;

    // Block the DB write so we can inspect state before it settles
    let resolveReorder!: () => void;
    vi.spyOn(MockStorageAdapter.prototype, "reorderPages").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReorder = resolve;
        })
    );

    // Trigger reorder without awaiting — optimistic state fires synchronously
    let reorderPromise!: Promise<void>;
    act(() => {
      reorderPromise = hook.result.current.reorderPages(null, [second!.id, first!.id]);
    });

    // reorderPages updates sortOrder values but does not re-sort the array in place.
    // The page list sorts by sortOrder at render time. Verify the sortOrder values
    // reflect the new order rather than checking raw array position.
    const sorted = [...hook.result.current.pages].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(sorted[0]!.id).toBe(second!.id);
    expect(sorted[1]!.id).toBe(first!.id);

    resolveReorder();
    await act(async () => {
      await reorderPromise;
    });
    void page2;
  });

  it("rolls back React state when the DB write fails", async () => {
    const { hook, page } = await setup();

    let page2!: Page;
    await act(async () => {
      page2 = await hook.result.current.createPage({ title: "Page 2" });
    });

    const originalIds = hook.result.current.pages.map((p) => p.id);
    vi.spyOn(MockStorageAdapter.prototype, "reorderPages").mockRejectedValueOnce(
      new Error("reorder failed")
    );

    await act(async () => {
      await hook.result.current.reorderPages(null, [page2.id, page.id]).catch(() => {});
    });

    const ids = hook.result.current.pages.map((p) => p.id);
    expect(ids).toEqual(originalIds);
  });
});

// ─── clearSchedule ────────────────────────────────────────────────────────────

describe("scheduleOnce on a recurring head", () => {
  // When the head moves (drag/edit), the rule's anchor must follow so
  // virtual expansion stops emitting past dates. Without anchor sync, the
  // rrule keeps generating from the original DTSTART and stale virtuals
  // linger between the old and new head positions.

  it("updates the rule's scheduledStart in lockstep with the head's denorm", async () => {
    const { hook, page } = await setup();
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00");
    });
    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=DAILY",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    // Drag the head forward to Wed (2099-01-07) — go through the public
    // scheduleOnce entry point, the same path CalendarView's drag handler uses.
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-07T10:00:00");
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(head?.scheduledStart).toBe("2099-01-07T10:00:00");
    expect(rule?.scheduledStart).toBe("2099-01-07T10:00:00");
  });

  it("non-recurring page: scheduleOnce does not touch any rule (no-op safety)", async () => {
    const { hook, page } = await setup();
    const updateRuleSpy = vi.spyOn(MockStorageAdapter.prototype, "updateRecurrenceRule");

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-07T10:00:00");
    });

    expect(updateRuleSpy).not.toHaveBeenCalled();
  });

  it("clears the rule's scheduledEnd when a move drops the end (lockstep with head)", async () => {
    // A move that omits `end` must CLEAR the rule's end, not leave the old one.
    // A stale end (end < new start) is what completion later inflates into a
    // multi-hour / 24h block.
    const { hook, page } = await setup();
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00", "2099-01-05T10:00:00");
    });
    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=DAILY",
        scheduledEnd: "2099-01-05T10:00:00",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    // Move the head to 2pm with no end (duration dropped).
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00");
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    // Head denorm carries `null` (PageSummary.scheduledEnd is string | null);
    // the rule omits it entirely (scheduledEnd is optional string). Both mean
    // "no end" — what matters is the rule no longer holds the stale 10am end.
    expect(head?.scheduledEnd).toBeNull();
    expect(rule?.scheduledStart).toBe("2099-01-05T14:00:00");
    expect(rule?.scheduledEnd).toBeUndefined();
  });
});

describe("completeRecurringPage after moving the head", () => {
  // Regression for QA §8/§9: moving a recurring head and then completing it
  // must advance to the next occurrence at the MOVED time/duration — never
  // revert to the original time, and never inflate a no-duration occurrence
  // into a 24-hour block. Both stemmed from the rule's scheduledEnd going
  // stale on a move that dropped the end.

  async function seedDailyRecurring(
    hook: Awaited<ReturnType<typeof setup>>["hook"],
    pageId: string,
    start: string,
    end?: string
  ) {
    await act(async () => {
      await hook.result.current.scheduleOnce(pageId, start, end);
    });
    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId,
        rrule: "FREQ=DAILY",
        scheduledStart: start,
        ...(end ? { scheduledEnd: end } : {}),
        timezone: "America/New_York",
      });
    });
  }

  it("advances to the moved time + duration (no revert)", async () => {
    const { hook, page } = await setup();
    await seedDailyRecurring(hook, page.id, "2099-01-05T09:00:00", "2099-01-05T10:00:00");

    // Move 9–10am → 2–3pm, then complete.
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00", "2099-01-05T15:00:00");
    });
    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-06T14:00:00");
    expect(head?.scheduledEnd).toBe("2099-01-06T15:00:00");
  });

  it("persists the head denorm on move so a reload + completion keep the moved position", async () => {
    // The prod-specific revert: refresh_schedule_denorm skips rrule-backed
    // pages, so moving a recurring head left pages.scheduled_start stale at the
    // original time. A reload (external-change) then snapped the head back, and
    // the completion cloned that stale denorm into the "done" block — both read
    // as "reverts to its original time". scheduleOnce must persist the denorm.
    const { hook, page } = await setup();
    await seedDailyRecurring(hook, page.id, "2099-01-05T09:00:00");

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00"); // move to 2pm
    });
    // Reload from the adapter (mirrors prod's external-change reload). With a
    // stale denorm this re-reads the head at 9am; the fix keeps it at 2pm.
    await act(async () => {
      await hook.result.current.selectWorkspace();
    });
    expect(hook.result.current.pages.find((p) => p.id === page.id)?.scheduledStart).toBe(
      "2099-01-05T14:00:00"
    );

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const pages = hook.result.current.pages;
    // The done clone lands at the MOVED occurrence (2pm), not the original 9am.
    const clone = pages.find((p) => p.id !== page.id && p.status === "done");
    expect(clone?.scheduledStart).toBe("2099-01-05T14:00:00");
    // And the head advanced to the next day at the moved time.
    expect(pages.find((p) => p.id === page.id)?.scheduledStart).toBe("2099-01-06T14:00:00");
  });

  it("a head moved to a no-duration time advances with no end (no 24h block)", async () => {
    const { hook, page } = await setup();
    await seedDailyRecurring(hook, page.id, "2099-01-05T09:00:00", "2099-01-05T10:00:00");

    // Move to 2pm and drop the end (no duration), then complete. Pre-fix the
    // stale 10am rule end made completion produce a ~20h block ending 10am the
    // next day; the advanced head must instead carry no end.
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00");
    });
    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-06T14:00:00");
    expect(head?.scheduledEnd).toBeNull();
  });

  it("a WEEKLY head moved to a different weekday advances on the NEW weekday", async () => {
    // The original revert bug: moving "every Monday" to a Wednesday left the
    // rule's BYDAY=MO, so completion snapped the next occurrence back to Monday.
    // The series must follow the move — next occurrence is the next Wednesday.
    const { hook, page } = await setup();
    let ruleId!: string;
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05"); // Monday, all-day
    });
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    // Move the head to Wednesday 2099-01-07.
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-07");
    });

    // The rule's BYDAY realigned to Wednesday in lockstep with the move.
    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rrule).toContain("BYDAY=WE");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    // Next occurrence is the following Wednesday (01-14), NOT a Monday.
    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-14");
  });

  it("a WEEKLY same-weekday time move keeps BYDAY and advances a week later", async () => {
    // Moving within the same weekday (Mon 9am → Mon 2pm) must NOT change BYDAY.
    const { hook, page } = await setup();
    let ruleId!: string;
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00"); // Monday
    });
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00");
    });

    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-12T14:00:00"); // next Monday, 2pm
  });
});

describe("clearSchedule", () => {
  it("clears scheduledStart in React state before the DB round-trip completes", async () => {
    const { hook, page } = await setup();
    const start = "2026-03-15T10:00:00";

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, start);
    });

    // Hang the DB call so we can inspect optimistic state before it settles
    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockImplementation(
      () => new Promise<[]>(() => {}) // intentionally never resolves
    );

    act(() => {
      void hook.result.current.clearSchedule(page.id);
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.scheduledStart).toBeNull();
  });

  it("rolls back React state and sets pageErrors when the DB write fails", async () => {
    const { hook, page } = await setup();
    const start = "2026-03-15T10:00:00";

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, start);
    });

    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockRejectedValueOnce(
      new Error("clear error")
    );

    await act(async () => {
      await hook.result.current.clearSchedule(page.id).catch(() => {});
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.scheduledStart).toBe(start);
    expect(hook.result.current.pageErrors.get(page.id)?.message).toMatch("clear error");
  });
});

// ─── deletePage ───────────────────────────────────────────────────────────────

describe("deletePage", () => {
  it("cancels a pending debounced write so it does not fire after deletion", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Ghost write" });
    });

    await act(async () => {
      await hook.result.current.deletePage(page.id);
    });

    // Advance past the debounce — the write should have been cancelled
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(spy).not.toHaveBeenCalled();
    expect(hook.result.current.pages.find((p) => p.id === page.id)).toBeUndefined();
  });
});

// ─── createFolder / deleteFolder ─────────────────────────────────────────────

describe("createFolder", () => {
  it("adds a folder to the folders list", async () => {
    const { hook } = await setup();

    let folder!: Awaited<ReturnType<typeof hook.result.current.createFolder>>;
    await act(async () => {
      folder = await hook.result.current.createFolder({ name: "Work" });
    });

    expect(hook.result.current.folders.find((f) => f.id === folder.id)?.name).toBe("Work");
  });
});

describe("deleteFolder", () => {
  it("removes folder and soft-deletes its pages", async () => {
    const { hook } = await setup();

    let folder!: Awaited<ReturnType<typeof hook.result.current.createFolder>>;
    await act(async () => {
      folder = await hook.result.current.createFolder({ name: "Temp" });
    });

    let folderPage!: Page;
    await act(async () => {
      folderPage = await hook.result.current.createPage({
        folderId: folder.id,
        title: "Folder Page",
      });
    });

    await act(async () => {
      await hook.result.current.deleteFolder(folder.id);
    });

    // Folder removed
    expect(hook.result.current.folders.find((f) => f.id === folder.id)).toBeUndefined();
    // Page soft-deleted (no longer in active pages list)
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)).toBeUndefined();
  });
});

// ─── softDeleteFolder / restoreFolder ────────────────────────────────────────

describe("softDeleteFolder", () => {
  it("hides folder and its pages from state", async () => {
    const { hook } = await setup();

    let folder!: Awaited<ReturnType<typeof hook.result.current.createFolder>>;
    await act(async () => {
      folder = await hook.result.current.createFolder({ name: "Soft" });
    });

    let folderPage!: Page;
    await act(async () => {
      folderPage = await hook.result.current.createPage({
        folderId: folder.id,
        title: "Soft Page",
      });
    });

    await act(async () => {
      await hook.result.current.softDeleteFolder(folder.id);
    });

    expect(hook.result.current.folders.find((f) => f.id === folder.id)).toBeUndefined();
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)).toBeUndefined();
  });
});

describe("restoreFolder", () => {
  it("restores folder and its pages after soft-delete", async () => {
    const { hook } = await setup();

    let folder!: Awaited<ReturnType<typeof hook.result.current.createFolder>>;
    await act(async () => {
      folder = await hook.result.current.createFolder({ name: "Restorable" });
    });

    let folderPage!: Page;
    await act(async () => {
      folderPage = await hook.result.current.createPage({
        folderId: folder.id,
        title: "Restorable Page",
      });
    });

    await act(async () => {
      await hook.result.current.softDeleteFolder(folder.id);
    });

    // Both gone
    expect(hook.result.current.folders.find((f) => f.id === folder.id)).toBeUndefined();
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)).toBeUndefined();

    await act(async () => {
      await hook.result.current.restoreFolder(folder.id);
    });

    // Both restored
    expect(hook.result.current.folders.find((f) => f.id === folder.id)?.name).toBe("Restorable");
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)?.title).toBe(
      "Restorable Page"
    );
  });
});

// ─── searchTags ──────────────────────────────────────────────────────────────

describe("searchTags", () => {
  it("returns tags matching the query prefix", async () => {
    vi.useFakeTimers();
    const { hook, page } = await setup();

    // Tags are set via updatePage, not createPage
    act(() => {
      hook.result.current.updatePage(page.id, { tags: ["work", "workout", "personal"] });
    });

    // Flush the debounced write so tags persist to the adapter
    await act(async () => {
      await hook.result.current.flushPage(page.id);
    });

    let tags!: string[];
    await act(async () => {
      tags = await hook.result.current.searchTags("wor");
    });

    expect(tags).toContain("work");
    expect(tags).toContain("workout");
    expect(tags).not.toContain("personal");
  });
});

// ─── Event emitter ───────────────────────────────────────────────────────────

describe("event emitter", () => {
  it("fires page:created when a page is created", async () => {
    const { hook } = await setup();

    const listener = vi.fn();
    act(() => {
      hook.result.current.on("page:created", listener);
    });

    await act(async () => {
      await hook.result.current.createPage({ title: "Evented" });
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({ title: "Evented" });
  });

  it("fires page:deleted when a page is deleted", async () => {
    const { hook, page } = await setup();

    const listener = vi.fn();
    act(() => {
      hook.result.current.on("page:deleted", listener);
    });

    await act(async () => {
      await hook.result.current.deletePage(page.id);
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toBe(page.id);
  });

  it("unsubscribe stops receiving events", async () => {
    const { hook } = await setup();

    const listener = vi.fn();
    let unsub!: () => void;
    act(() => {
      unsub = hook.result.current.on("page:created", listener);
    });

    unsub();

    await act(async () => {
      await hook.result.current.createPage({ title: "After unsub" });
    });

    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── mergePages ─────────────────────────────────────────────────────────────

describe("mergePages", () => {
  it("adds new pages to the pages array", async () => {
    const { hook, page } = await setup();
    const initialCount = hook.result.current.pages.length;

    act(() => {
      hook.result.current.mergePages([
        {
          createdAt: new Date().toISOString(),
          folderId: null,
          id: "completed-1",
          priority: 0,
          sortOrder: 99,
          status: "done",
          tags: [],
          title: "Completed Page",
          updatedAt: new Date().toISOString(),
        },
      ]);
    });

    expect(hook.result.current.pages).toHaveLength(initialCount + 1);
    expect(hook.result.current.pages.find((p) => p.id === "completed-1")?.title).toBe(
      "Completed Page"
    );
    void page;
  });

  it("deduplicates by ID — does not add pages already in the array", async () => {
    const { hook, page } = await setup();
    const initialCount = hook.result.current.pages.length;

    act(() => {
      hook.result.current.mergePages([
        {
          createdAt: page.createdAt,
          folderId: null,
          id: page.id,
          priority: 0,
          sortOrder: 0,
          status: "done",
          tags: [],
          title: "Duplicate",
          updatedAt: page.updatedAt,
        },
      ]);
    });

    // Count unchanged — the duplicate was skipped
    expect(hook.result.current.pages).toHaveLength(initialCount);
  });

  it("merged pages participate in optimistic updates", async () => {
    vi.useFakeTimers();
    const { hook } = await setup();

    act(() => {
      hook.result.current.mergePages([
        {
          completedAt: "2026-03-01T10:00:00",
          createdAt: "2026-03-01T09:00:00",
          folderId: null,
          id: "merged-1",
          priority: 0,
          sortOrder: 99,
          status: "done",
          tags: [],
          title: "Original Title",
          updatedAt: "2026-03-01T10:00:00",
        },
      ]);
    });

    // Optimistic update on merged page
    act(() => {
      hook.result.current.updatePage("merged-1", { title: "Updated Title" });
    });

    const found = hook.result.current.pages.find((p) => p.id === "merged-1");
    expect(found?.title).toBe("Updated Title");
  });
});

// ─── Initial load excludes completed ────────────────────────────────────────

// ─── Recurrence rules ─────────────────────────────────────────────────────────
//
// Covers the workspace-level recurrence flows: createRecurrence /
// updateRecurrence / deleteRecurrence keep the in-memory rule list in sync,
// completeRecurringPage clones the head and advances its scheduledStart,
// and skipOccurrence persists exdates with an undo function. These flows
// are the hot path for the calendar's virtual-occurrence rendering, so a
// regression here would silently break recurring pages on the calendar.

describe("createRecurrence", () => {
  it("adds the rule to recurrenceRules state", async () => {
    const { hook, page } = await setup();

    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
    });

    const rules = hook.result.current.recurrenceRules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pageId).toBe(page.id);
    expect(rules[0]?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(rules[0]?.rruleExdates).toEqual([]);
  });
});

describe("updateRecurrence", () => {
  it("replaces the rrule but keeps existing exdates", async () => {
    const { hook, page } = await setup();

    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    await act(async () => {
      await hook.result.current.updateRecurrence(ruleId, {
        rruleExdates: ["2026-03-09"],
      });
    });

    await act(async () => {
      await hook.result.current.updateRecurrence(ruleId, { rrule: "FREQ=DAILY" });
    });

    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rrule).toBe("FREQ=DAILY");
    // Exdates carry over even when the cadence shape changes — semantically
    // they may no longer match, but it's the user's responsibility to clear
    // them, not ours to discard them silently.
    expect(rule?.rruleExdates).toEqual(["2026-03-09"]);
  });
});

describe("rescheduleVirtualOccurrence", () => {
  // Materialising a virtual occurrence creates an independent real page (a
  // clone of the head) at the new time and exdates the original date so the
  // virtual disappears. The clone is a regular page — own status, can be
  // moved/completed/deleted independently of the head and series.
  //
  // The pre-fix bug: head and virtual share an id, so calling
  // scheduleOnce(headId, ...) on a virtual drag moved the head and left a
  // phantom virtual at its original anchor.

  async function seedRecurring(headTitle = "Standup"): Promise<{
    hook: Awaited<ReturnType<typeof setup>>["hook"];
    page: Page;
    ruleId: string;
  }> {
    const { hook } = await setup();
    let page!: Page;
    await act(async () => {
      page = await hook.result.current.createPage({ title: headTitle });
    });
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00");
    });
    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });
    return { hook, page, ruleId };
  }

  it("creates an independent clone page at the new time with the head's metadata", async () => {
    const { hook, page, ruleId } = await seedRecurring("Weekly Standup");

    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-12T14:00:00",
        "2099-01-12T15:00:00"
      );
    });

    // The clone is a NEW page (different id from the head) — title and
    // metadata copied, status reset to not_started, scheduled at the new time.
    const clones = hook.result.current.pages.filter(
      (p) => p.id !== page.id && p.title === "Weekly Standup"
    );
    expect(clones).toHaveLength(1);
    expect(clones[0]?.status).toBe("not_started");
    expect(clones[0]?.folderId).toBeNull();
    expect(clones[0]?.scheduledStart).toBe("2099-01-12T14:00:00");
    expect(clones[0]?.scheduledEnd).toBe("2099-01-12T15:00:00");
  });

  it("leaves the head's scheduledStart untouched", async () => {
    const { hook, page, ruleId } = await seedRecurring();

    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-12T14:00:00"
      );
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-05T09:00:00");
  });

  it("adds the original date to the rule's exdates so the virtual disappears", async () => {
    const { hook, ruleId } = await seedRecurring();

    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-12T14:00:00"
      );
    });

    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rruleExdates).toContain("2099-01-12");
  });

  it("rejects when the rule does not exist", async () => {
    const { hook } = await setup();

    await expect(
      act(async () => {
        await hook.result.current.rescheduleVirtualOccurrence(
          "no-such-rule",
          "2099-01-12",
          "2099-01-12T14:00:00"
        );
      })
    ).rejects.toThrow(/Recurrence rule not found/);
  });

  it("completing the head after a materialisation skips the materialised date and advances to the next non-excluded occurrence", async () => {
    // Materialising a virtual at originalDate D adds D to exdates. Without
    // exdate-aware advance, completing the head (anchor=Jan 5) would jump
    // to Jan 12 — but Jan 12 was just materialised. The head should skip it
    // and land on Jan 19.
    const { hook, page, ruleId } = await seedRecurring();

    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-12T14:00:00"
      );
    });

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    // Jan 5 (head) → completed (in exdates). Jan 12 → materialised (in exdates).
    // Next Monday is Jan 19.
    expect(head?.scheduledStart).toBe("2099-01-19T09:00:00");
  });

  it("a second materialisation of the same virtual creates another independent page (no upsert)", async () => {
    // Once originalDate is in exdates, the virtual no longer exists, so this
    // path is normally unreachable from the UI. But the call itself must not
    // throw or behave strangely — confirms the operation is repeatable as
    // independent clones.
    const { hook, page, ruleId } = await seedRecurring();

    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-12",
        "2099-01-12T14:00:00"
      );
    });
    await act(async () => {
      await hook.result.current.rescheduleVirtualOccurrence(
        ruleId,
        "2099-01-19",
        "2099-01-19T16:00:00"
      );
    });

    const clones = hook.result.current.pages.filter(
      (p) => p.id !== page.id && p.title === page.title
    );
    expect(clones).toHaveLength(2);

    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rruleExdates).toEqual(expect.arrayContaining(["2099-01-12", "2099-01-19"]));
  });
});

describe("deleting a recurring head removes virtuals", () => {
  // Deleting the head doesn't cascade-delete the rule from local React state,
  // but useRecurrenceExpansion guards on `pages.find` — once the head is out
  // of pages, the rule has no template and produces no virtual occurrences.

  it("removes the head from pages so virtual expansion produces nothing", async () => {
    const { hook, page } = await setup();
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00");
    });
    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    expect(hook.result.current.pages.find((p) => p.id === page.id)).toBeDefined();

    await act(async () => {
      await hook.result.current.deletePage(page.id);
    });

    expect(hook.result.current.pages.find((p) => p.id === page.id)).toBeUndefined();
    // Sanity: the rule survives in local state (matches existing semantics —
    // useRecurrenceExpansion guards on missing page, not on rule presence).
    expect(hook.result.current.recurrenceRules.find((r) => r.pageId === page.id)).toBeDefined();
  });
});

describe("deleteRecurrence", () => {
  it("removes the rule from state", async () => {
    const { hook, page } = await setup();

    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-03-02",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    expect(hook.result.current.recurrenceRules).toHaveLength(1);

    await act(async () => {
      await hook.result.current.deleteRecurrence(ruleId);
    });

    expect(hook.result.current.recurrenceRules).toHaveLength(0);
  });
});

describe("completeRecurringPage", () => {
  async function seedRecurringPage(scheduledStart: string, rrule: string) {
    const { hook, page } = await setup();
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, scheduledStart);
    });
    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule,
        scheduledStart,
        timezone: "America/New_York",
      });
    });
    return { hook, page };
  }

  it("creates a done clone, advances head's scheduledStart, and exdates the completed date", async () => {
    // Use a far-future Monday so today never overtakes headDate, regardless of
    // when the suite runs. completeRecurringPage's afterDate is max(today,
    // headDate) — anchoring in the future keeps it equal to headDate.
    const { hook, page } = await seedRecurringPage(
      "2099-01-05T09:00:00", // Monday Jan 5, 2099
      "FREQ=WEEKLY;BYDAY=MO"
    );

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.status).toBe("not_started");
    expect(head?.scheduledStart).toBe("2099-01-12T09:00:00");

    // A done clone for the original date appears alongside the head.
    const clones = hook.result.current.pages.filter(
      (p) => p.title === page.title && p.id !== page.id
    );
    expect(clones).toHaveLength(1);
    expect(clones[0]?.status).toBe("done");
    expect(clones[0]?.scheduledStart).toBe("2099-01-05T09:00:00");

    // The original date is in exdates so the calendar's virtual expansion
    // won't render a phantom occurrence on top of the done clone.
    const rule = hook.result.current.recurrenceRules.find((r) => r.pageId === page.id);
    expect(rule?.rruleExdates).toContain("2099-01-05");
  });

  it("with policy=advance, head is overdue advances one rrule step from the head's anchor (not to today)", async () => {
    // Default policy is "advance" — the gap-resolution dialog lets the user
    // pick between this and "skip" when the head is overdue. advance never
    // jumps to today; it always moves one rrule step from the head's anchor.
    const { hook, page } = await seedRecurringPage("1999-01-04T09:00:00", "FREQ=DAILY");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("1999-01-05T09:00:00");
  });

  it("with policy=skip, head is overdue jumps to today and exdates the gap", async () => {
    const { hook, page } = await seedRecurringPage("1999-01-04T09:00:00", "FREQ=DAILY");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id, "skip");
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBeTruthy();
    const advancedDate = head!.scheduledStart!.slice(0, 10);
    // Daily rule has an occurrence every day, so skip should land on today
    // exactly — not tomorrow. (Earlier behaviour used todayStart as the
    // afterDate, which combined with nextOccurrenceAfter's endOfDay cursor
    // pushed the result one day forward.) Format in local time to match
    // nextOccurrenceAfter, which also formats locally.
    const todayLocal = format(new Date(), "yyyy-MM-dd");
    expect(advancedDate).toBe(todayLocal);

    // The gap (1999-01-05 onward to today) should be exdated en masse.
    const rule = hook.result.current.recurrenceRules.find((r) => r.pageId === page.id);
    expect(rule?.rruleExdates.length).toBeGreaterThan(2); // head + many gap days
    expect(rule?.rruleExdates).toContain("1999-01-04"); // head completion
    expect(rule?.rruleExdates).toContain("1999-01-05"); // a gap date
  });

  it("with policy=skip, head is overdue and rule has no occurrence today, advances to the next future occurrence", async () => {
    // Anchor on a Monday in 1999 with a weekly-Monday rule. By the time this
    // suite runs the head is many years overdue. skip should exdate the gap
    // of past Mondays and land on the next Monday strictly after today —
    // unless today itself is a Monday, in which case it should land on today.
    const { hook, page } = await seedRecurringPage("1999-01-04T09:00:00", "FREQ=WEEKLY;BYDAY=MO");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id, "skip");
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBeTruthy();
    const advancedDate = head!.scheduledStart!.slice(0, 10);
    const todayLocal = format(new Date(), "yyyy-MM-dd");
    const advancedLocalDate = new Date(`${advancedDate}T00:00:00`);
    // Result must be a Monday and must not be in the past.
    expect(advancedLocalDate.getDay()).toBe(1);
    expect(advancedDate >= todayLocal).toBe(true);
  });

  it("marks head done when the rule has no further occurrences (COUNT exhausted)", async () => {
    const { hook, page } = await seedRecurringPage("2099-01-05T09:00:00", "FREQ=DAILY;COUNT=1");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.status).toBe("done");
    expect(head?.completedAt).toBeTruthy();
  });

  it("rejects when the page has no recurrence rule", async () => {
    const { hook, page } = await setup();

    await expect(
      act(async () => {
        await hook.result.current.completeRecurringPage(page.id);
      })
    ).rejects.toThrow(/No recurrence rule/);
  });
});

describe("skipOccurrence", () => {
  it("adds the date to exdates and returns an undo that restores it", async () => {
    const { hook, page } = await setup();

    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    let undo!: () => void;
    await act(async () => {
      undo = await hook.result.current.skipOccurrence(ruleId, "2026-03-09");
    });

    expect(hook.result.current.recurrenceRules.find((r) => r.id === ruleId)?.rruleExdates).toEqual([
      "2026-03-09",
    ]);

    await act(async () => {
      undo();
      // skipOccurrence's undo path is fire-and-forget — give the
      // adapter promise a microtask to settle so React can flush.
      await Promise.resolve();
    });

    expect(hook.result.current.recurrenceRules.find((r) => r.id === ruleId)?.rruleExdates).toEqual(
      []
    );
  });

  it("appends to existing exdates rather than replacing them", async () => {
    const { hook, page } = await setup();

    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        rruleExdates: ["2026-03-02"],
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });

    await act(async () => {
      await hook.result.current.skipOccurrence(ruleId, "2026-03-09");
    });

    expect(hook.result.current.recurrenceRules.find((r) => r.id === ruleId)?.rruleExdates).toEqual([
      "2026-03-02",
      "2026-03-09",
    ]);
  });

  it("rejects when the rule does not exist", async () => {
    const { hook } = await setup();

    await expect(
      act(async () => {
        await hook.result.current.skipOccurrence("nonexistent", "2026-03-09");
      })
    ).rejects.toThrow(/Recurrence rule not found/);
  });
});

describe("initial load", () => {
  it("filters listPages to status=not_started", async () => {
    const spy = vi.spyOn(MockStorageAdapter.prototype, "listPages");
    const hook = renderHookWithProviders(() => useWorkspace());

    await act(async () => {
      await hook.result.current.selectWorkspace();
    });

    // listPages should have been called with status filter
    expect(spy).toHaveBeenCalledWith({ status: "not_started" });
  });

  it("does not pull completed pages into the pages array on reload", async () => {
    // Guards against reintroducing a bulk completed load at init — the
    // Inbox/folder Completed sections rely on lazy pagination, and the
    // calendar pulls its own range-scoped completed set separately. A
    // completed page sitting in storage must stay out of `pages` until
    // something explicitly asks for it.
    const hook = await setup();

    // Drop a completed page directly into the adapter, bypassing React
    // state — simulates a pre-existing completion from a prior session.
    await act(async () => {
      const storage = hook.hook.result.current.storage;
      if (!storage) throw new Error("storage should exist after selectWorkspace");
      await storage.createPage({
        content: "",
        folderId: null,
        priority: 0,
        status: "done",
        tags: [],
        title: "Completed long ago",
      });
    });

    // Trigger a fresh workspace load.
    await act(async () => {
      await hook.hook.result.current.selectWorkspace();
    });

    const donePages = hook.hook.result.current.pages.filter((p) => p.status === "done");
    expect(donePages).toHaveLength(0);
  });
});
