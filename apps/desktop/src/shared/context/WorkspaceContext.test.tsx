// Runs in VITE_TEST_MODE so the provider uses MockStorageAdapter and skips all Tauri APIs. Spies on
// MockStorageAdapter prototype methods control timing and inject failures without real I/O.

import type { Page } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useHeldPages } from "@/shared/viewCache/useHeldPages";
import { renderHookWithProviders } from "@/test/renderWithProviders";
import { usePagesNow } from "@/test/usePagesNow";

async function setup() {
  const hook = renderHookWithProviders(() => {
    const workspace = useWorkspace();
    const pages = usePagesNow();
    return Object.defineProperties(
      { ...workspace, ...pages },
      { pages: { get: () => pages.pages } }
    );
  });

  await act(async () => {
    await hook.result.current.selectWorkspace();
  });

  let page!: Page;
  await act(async () => {
    page = await hook.result.current.createPage({ title: "Test Page" });
  });

  return { hook, page };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("updatePage — optimistic update", () => {
  it("applies the patch to React state immediately (before the debounce fires)", async () => {
    vi.useFakeTimers();
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Instant" });
    });

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

    expect(spy).toHaveBeenCalledOnce();
    const [, patch] = spy.mock.calls[0]!;
    expect(patch).toMatchObject({ status: "done", title: "Draft 2" });
  });

  it("flushes a status change immediately, without the 800ms debounce", async () => {
    // The write must not sit in the debounce window: the notification scheduler reads pages.status
    // from SQLite.
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    await act(async () => {
      hook.result.current.updatePage(page.id, { status: "done" });
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    // No waitFor: it polls via the faked setTimeout and hangs.
    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe(originalTitle);
    expect(hook.result.current.pageErrors.get(page.id)?.message).toMatch("write failed");
  });
});

describe("flushPage", () => {
  it("writes immediately without waiting for the debounce timer", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Flushed" });
    });

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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("scheduleOnce", () => {
  it("applies scheduledStart to React state before the DB round-trip completes", async () => {
    const { hook, page } = await setup();
    const start = "2026-03-15T10:00:00";

    // Never resolves, to prove the optimistic update fired before any DB I/O completed.
    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockImplementation(
      () => new Promise<[]>(() => {})
    );

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

    act(() => {
      hook.result.current.updatePage(page.id, { title: "queued" });
    });

    const flushPromise = hook.result.current.flushPage(page.id);

    const schedulePromise = hook.result.current
      .scheduleOnce(page.id, "2026-03-15T10:00:00")
      .catch(() => {});

    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder).toEqual(["updatePage:start"]);

    resolveUpdate({ ...page, title: "queued", updatedAt: new Date().toISOString() });

    await act(async () => {
      await Promise.all([flushPromise, schedulePromise]);
    });

    expect(callOrder).toEqual(["updatePage:start", "listPageSchedules:start"]);
  });

  it("applies both concurrent updatePage + scheduleOnce without losing either change", async () => {
    const { hook, page } = await setup();
    // Future date so _refreshDenorm (filters >= today) picks it up.
    const start = "2099-03-15T10:00:00";

    act(() => {
      hook.result.current.updatePage(page.id, { title: "concurrent update" });
    });

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, start);
    });

    await act(async () => {
      await hook.result.current.flushPage(page.id);
    });

    const found = hook.result.current.pages.find((p) => p.id === page.id);
    expect(found?.title).toBe("concurrent update");
    expect(found?.scheduledStart).toBe(start);
    expect(hook.result.current.pageErrors.size).toBe(0);
  });

  it("commits a pending debounced patch before a queued write, so it can't land after it", async () => {
    const { hook, page } = await setup();
    const moved = "2099-03-15T10:00:00";

    act(() => {
      hook.result.current.updatePage(page.id, { scheduledStart: "2099-03-10T09:00:00" });
    });
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, moved);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(hook.result.current.pages.find((p) => p.id === page.id)?.scheduledStart).toBe(moved);
  });

  it("keeps an edit still in its debounce when another write to the page queues first", async () => {
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Renamed" });
    });
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-03-15T10:00:00");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect((await hook.result.current.storage!.getPage(page.id))?.title).toBe("Renamed");
    expect(hook.result.current.pages.find((p) => p.id === page.id)?.title).toBe("Renamed");
  });

  it("never flashes a moved page back while an earlier edit's write lands", async () => {
    const seen: (string | null | undefined)[] = [];
    let pageId = "";
    const hook = renderHookWithProviders(() => {
      const value = { ...useWorkspace(), ...usePages() };
      const held = useHeldPages() ?? [];
      seen.push(held.find((p) => p.id === pageId)?.scheduledStart);
      return value;
    });
    await act(async () => {
      await hook.result.current.selectWorkspace();
    });
    await act(async () => {
      pageId = (await hook.result.current.createPage({ title: "Test Page" })).id;
    });
    const moved = "2099-03-15T10:00:00";

    act(() => {
      hook.result.current.updatePage(pageId, { title: "Renamed" });
    });
    await act(async () => {
      await hook.result.current.scheduleOnce(pageId, moved);
    });

    const firstMoved = seen.indexOf(moved);
    expect(firstMoved).toBeGreaterThan(-1);
    expect(seen.slice(firstMoved)).toEqual(seen.slice(firstMoved).map(() => moved));
  });

  it("flags a page whose early-committed edit fails, without an unhandled rejection", async () => {
    const { hook, page } = await setup();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked with .call(this, …) inside the mock below
    const original = MockStorageAdapter.prototype.updatePage;
    vi.spyOn(MockStorageAdapter.prototype, "updatePage").mockImplementation(function (
      this: MockStorageAdapter,
      id,
      updates
    ) {
      if (updates.title === "Renamed") return Promise.reject(new Error("disk full"));
      return original.call(this, id, updates);
    });

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Renamed" });
    });
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-03-15T10:00:00");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(hook.result.current.pageErrors.has(page.id)).toBe(true);
  });

  it("takes the writer's copy back once a debounced write lands", async () => {
    const { hook, page } = await setup();
    await new Promise((resolve) => setTimeout(resolve, 5));

    act(() => {
      hook.result.current.updatePage(page.id, { title: "Renamed" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const stored = await hook.result.current.storage!.getPage(page.id);
    expect(stored?.updatedAt).not.toBe(page.updatedAt);
    expect(hook.result.current.pages.find((p) => p.id === page.id)?.updatedAt).toBe(
      stored?.updatedAt
    );
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

    act(() => {
      hook.result.current.updatePage(page.id, { title: "A" });
    });
    const flushA = hook.result.current.flushPage(page.id);

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

describe("reorderPages — optimistic", () => {
  it("reorders React state immediately without waiting for the DB", async () => {
    const { hook } = await setup();

    let page2!: Page;
    await act(async () => {
      page2 = await hook.result.current.createPage({ title: "Page 2" });
    });

    const [first, second] = hook.result.current.pages;

    let resolveReorder!: () => void;
    vi.spyOn(MockStorageAdapter.prototype, "reorderPages").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReorder = resolve;
        })
    );

    let reorderPromise!: Promise<void>;
    act(() => {
      reorderPromise = hook.result.current.reorderPages(null, [second!.id, first!.id]);
    });

    // reorderPages updates sortOrder values without re-sorting the array; the list sorts at render.
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

describe("a rule added or removed in the session", () => {
  it("marks its page recurring, and unmarks it on removal", async () => {
    const { hook, page } = await setup();
    const isRecurring = () => hook.result.current.pages.find((p) => p.id === page.id)?.isRecurring;
    let ruleId!: string;
    await act(async () => {
      const rule = await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=DAILY",
        scheduledStart: "2099-01-05",
        timezone: "America/New_York",
      });
      ruleId = rule.id;
    });
    expect(isRecurring()).toBe(true);

    await act(async () => {
      await hook.result.current.deleteRecurrence(ruleId);
    });
    expect(isRecurring()).toBe(false);
  });

  it("removing one page's rule leaves another page's series marked", async () => {
    const { hook, page } = await setup();
    let other!: Page;
    await act(async () => {
      other = await hook.result.current.createPage({ title: "Other" });
    });
    const recurring = (id: string) =>
      hook.result.current.pages.find((p) => p.id === id)?.isRecurring;
    let otherRule!: string;
    await act(async () => {
      for (const target of [page, other]) {
        const rule = await hook.result.current.createRecurrence({
          pageId: target.id,
          rrule: "FREQ=DAILY",
          scheduledStart: "2099-01-05",
          timezone: "America/New_York",
        });
        if (target === other) otherRule = rule.id;
      }
    });

    await act(async () => {
      await hook.result.current.deleteRecurrence(otherRule);
    });
    expect(recurring(page.id)).toBe(true);
    expect(recurring(other.id)).toBe(false);
  });
});

describe("scheduleOnce on a recurring head", () => {
  // Without anchor sync the rrule keeps generating from the original DTSTART, leaving stale virtuals.

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
    // A stale end (end < new start) is what completion later inflates into a 24h block.
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

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00");
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    // Head denorm is `null` and the rule omits the field: both mean no end.
    expect(head?.scheduledEnd).toBeNull();
    expect(rule?.scheduledStart).toBe("2099-01-05T14:00:00");
    expect(rule?.scheduledEnd).toBeUndefined();
  });
});

describe("completeRecurringPage after moving the head", () => {
  // A stale rule scheduledEnd would revert the time or inflate a no-duration occurrence to 24h.

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
    // refresh_schedule_denorm skips rrule-backed pages, so scheduleOnce must persist the denorm or a
    // reload snaps the head back.
    const { hook, page } = await setup();
    await seedDailyRecurring(hook, page.id, "2099-01-05T09:00:00");

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T14:00:00");
    });
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
    const clone = pages.find((p) => p.id !== page.id && p.status === "done");
    expect(clone?.scheduledStart).toBe("2099-01-05T14:00:00");
    expect(pages.find((p) => p.id === page.id)?.scheduledStart).toBe("2099-01-06T14:00:00");
  });

  it("a head moved to a no-duration time advances with no end (no 24h block)", async () => {
    const { hook, page } = await setup();
    await seedDailyRecurring(hook, page.id, "2099-01-05T09:00:00", "2099-01-05T10:00:00");

    // A stale 10am rule end would make completion produce a ~20h block.
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
    const { hook, page } = await setup();
    let ruleId!: string;
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05");
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

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-07");
    });

    const rule = hook.result.current.recurrenceRules.find((r) => r.id === ruleId);
    expect(rule?.rrule).toContain("BYDAY=WE");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("2099-01-14");
  });

  it("a WEEKLY same-weekday time move keeps BYDAY and advances a week later", async () => {
    const { hook, page } = await setup();
    let ruleId!: string;
    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, "2099-01-05T09:00:00");
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
    expect(head?.scheduledStart).toBe("2099-01-12T14:00:00");
  });
});

describe("clearSchedule", () => {
  it("clears scheduledStart in React state before the DB round-trip completes", async () => {
    const { hook, page } = await setup();
    const start = "2026-03-15T10:00:00";

    await act(async () => {
      await hook.result.current.scheduleOnce(page.id, start);
    });

    vi.spyOn(MockStorageAdapter.prototype, "listPageSchedules").mockImplementation(
      () => new Promise<[]>(() => {})
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(spy).not.toHaveBeenCalled();
    expect(hook.result.current.pages.find((p) => p.id === page.id)).toBeUndefined();
  });
});

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

    expect(hook.result.current.folders.find((f) => f.id === folder.id)).toBeUndefined();
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)).toBeUndefined();
  });
});

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

    expect(hook.result.current.folders.find((f) => f.id === folder.id)).toBeUndefined();
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)).toBeUndefined();

    await act(async () => {
      await hook.result.current.restoreFolder(folder.id);
    });

    expect(hook.result.current.folders.find((f) => f.id === folder.id)?.name).toBe("Restorable");
    expect(hook.result.current.pages.find((p) => p.id === folderPage.id)?.title).toBe(
      "Restorable Page"
    );
  });
});

describe("searchTags", () => {
  it("returns tags matching the query prefix", async () => {
    vi.useFakeTimers();
    const { hook, page } = await setup();

    act(() => {
      hook.result.current.updatePage(page.id, { tags: ["work", "workout", "personal"] });
    });

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

describe("mergePages", () => {
  it("adds new pages to the pages array", async () => {
    const { hook, page } = await setup();
    const initialCount = hook.result.current.pages.length;

    act(() => {
      hook.result.current.mergePages([
        {
          createdAt: new Date().toISOString(),
          detachIsReversible: false,
          folderId: null,
          id: "completed-1",
          isRecurring: false,
          priority: 0,
          scheduleLocked: false,
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
          detachIsReversible: false,
          folderId: null,
          id: page.id,
          isRecurring: false,
          priority: 0,
          scheduleLocked: false,
          sortOrder: 0,
          status: "done",
          tags: [],
          title: "Duplicate",
          updatedAt: page.updatedAt,
        },
      ]);
    });

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
          detachIsReversible: false,
          folderId: null,
          id: "merged-1",
          isRecurring: false,
          priority: 0,
          scheduleLocked: false,
          sortOrder: 99,
          status: "done",
          tags: [],
          title: "Original Title",
          updatedAt: "2026-03-01T10:00:00",
        },
      ]);
    });

    act(() => {
      hook.result.current.updatePage("merged-1", { title: "Updated Title" });
    });

    const found = hook.result.current.pages.find((p) => p.id === "merged-1");
    expect(found?.title).toBe("Updated Title");
  });
});

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
    // Exdates are kept even when they no longer match; clearing them is the user's job.
    expect(rule?.rruleExdates).toEqual(["2026-03-09"]);
  });
});

describe("rescheduleVirtualOccurrence", () => {
  // The clone is a regular page, independent of the head and series. Head and virtual share an id,
  // so scheduleOnce(headId, ...) on a virtual drag would move the head and leave a phantom virtual.

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
    // Without exdate-aware advance, completing the head would land on Jan 12, already materialised.
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
    expect(head?.scheduledStart).toBe("2099-01-19T09:00:00");
  });

  it("a second materialisation of the same virtual creates another independent page (no upsert)", async () => {
    // Normally unreachable from the UI; must not throw.
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
  // useRecurrenceExpansion guards on `pages.find`, so a deleted head leaves its rule with no virtuals.

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

  it("creates a done clone, recomputes the head, and records the completed date in the set", async () => {
    // Far-future Monday so today never overtakes headDate.
    const { hook, page } = await seedRecurringPage("2099-01-05T09:00:00", "FREQ=WEEKLY;BYDAY=MO");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.status).toBe("not_started");
    expect(head?.scheduledStart).toBe("2099-01-12T09:00:00");

    const clones = hook.result.current.pages.filter(
      (p) => p.title === page.title && p.id !== page.id
    );
    expect(clones).toHaveLength(1);
    expect(clones[0]?.status).toBe("done");
    expect(clones[0]?.scheduledStart).toBe("2099-01-05T09:00:00");

    // The date lands in the completed set, not rrule EXDATEs.
    expect(head?.completedOccurrences?.["2099-01-05"]).toBe(clones[0]?.id);
    const rule = hook.result.current.recurrenceRules.find((r) => r.pageId === page.id);
    expect(rule?.rruleExdates).not.toContain("2099-01-05");
  });

  it("an overdue head advances one rrule step from its anchor, never straight to today", async () => {
    const { hook, page } = await seedRecurringPage("1999-01-04T09:00:00", "FREQ=DAILY");

    await act(async () => {
      await hook.result.current.completeRecurringPage(page.id);
    });

    const head = hook.result.current.pages.find((p) => p.id === page.id);
    expect(head?.scheduledStart).toBe("1999-01-05T09:00:00");
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
    // A clone minted against no series can never be suppressed.
    const { hook, page } = await setup();

    await expect(
      act(async () => {
        await hook.result.current.completeRecurringPage(page.id);
      })
    ).rejects.toThrow(/only to a recurring series/);
  });
});

describe("skipOccurrences", () => {
  it("dismisses the date to the skip-set and returns an undo that restores it", async () => {
    const { hook, page } = await setup();

    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
    });

    let undo!: () => void;
    await act(async () => {
      undo = await hook.result.current.skipOccurrences(page.id, ["2026-03-09"]);
    });

    expect(hook.result.current.pages.find((p) => p.id === page.id)?.skippedOccurrences).toEqual([
      "2026-03-09",
    ]);

    await act(async () => {
      undo();
      // Undo is fire-and-forget; let the adapter promise settle.
      await Promise.resolve();
    });

    const restored = hook.result.current.pages.find((p) => p.id === page.id);
    expect(restored?.skippedOccurrences ?? []).toEqual([]);
  });

  it("appends to the existing skip-set rather than replacing it", async () => {
    const { hook, page } = await setup();

    await act(async () => {
      await hook.result.current.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-03-02T09:00:00",
        timezone: "America/New_York",
      });
      await hook.result.current.skipOccurrences(page.id, ["2026-03-16"]);
    });

    await act(async () => {
      await hook.result.current.skipOccurrences(page.id, ["2026-03-09"]);
    });

    expect(hook.result.current.pages.find((p) => p.id === page.id)?.skippedOccurrences).toEqual([
      "2026-03-16",
      "2026-03-09",
    ]);
  });

  it("rejects when the page does not exist", async () => {
    const { hook } = await setup();

    await expect(
      act(async () => {
        await hook.result.current.skipOccurrences("nonexistent", ["2026-03-09"]);
      })
    ).rejects.toThrow(/Page not found/);
  });
});

describe("initial load", () => {
  it("does not pull completed pages into the pages array on reload", async () => {
    // Completed sections lazy-paginate and the calendar loads its own range, so init must not
    // bulk-load completed pages.
    const hook = await setup();

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

    await act(async () => {
      await hook.hook.result.current.selectWorkspace();
    });

    const donePages = hook.hook.result.current.pages.filter((p) => p.status === "done");
    expect(donePages).toHaveLength(0);
  });
});
