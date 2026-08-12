// useRecurringStatusToggle — the shared router that decides how a status toggle
// dispatches: un-check of a done clone first, then a recurring tick to the gap
// dialog, then a plain non-recurring update. A branch reorder here silently
// mis-routes a synced completion (the bug this hook was extracted to prevent), so
// each arm is pinned.

import type { PageRecurrenceRule, PageStatus, PageSummary, PageUpdate } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRecurringStatusToggle } from "./useRecurringStatusToggle";

const mocks = vi.hoisted(() => ({
  maybeUncompleteRecurringClone: vi.fn<(page: PageSummary, next: PageStatus) => boolean>(),
  recurrenceRules: [] as PageRecurrenceRule[],
  requestComplete: vi.fn(),
  uncompleteRecurringOrFlip: vi.fn(),
  updatePage: vi.fn<(id: string, patch: PageUpdate) => void>(),
}));

vi.mock("@/shared/context/PagesContext", () => ({
  usePages: () => ({
    maybeUncompleteRecurringClone: mocks.maybeUncompleteRecurringClone,
    recurrenceRules: mocks.recurrenceRules,
    uncompleteRecurringOrFlip: mocks.uncompleteRecurringOrFlip,
    updatePage: mocks.updatePage,
  }),
}));

vi.mock("@/shared/context/RecurringGapDialogContext", () => ({
  useRecurringGapDialog: () => ({ requestComplete: mocks.requestComplete }),
}));

const PAGE = { id: "p1" } as PageSummary;
const ruleFor = (pageId: string): PageRecurrenceRule => ({ pageId }) as PageRecurrenceRule;

function toggle(): (page: PageSummary, next: PageStatus) => void {
  return renderHook(() => useRecurringStatusToggle()).result.current;
}

describe("useRecurringStatusToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeUncompleteRecurringClone.mockReturnValue(false);
    mocks.recurrenceRules = [];
  });

  it("routes a done toggle on a recurring series to the gap dialog", () => {
    mocks.recurrenceRules = [ruleFor("p1")];

    toggle()(PAGE, "done");

    expect(mocks.requestComplete).toHaveBeenCalledWith(PAGE);
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
    expect(mocks.updatePage).not.toHaveBeenCalled();
  });

  it("routes an un-done toggle on a recurring series to uncompleteRecurringOrFlip", () => {
    mocks.recurrenceRules = [ruleFor("p1")];

    toggle()(PAGE, "not_started");

    expect(mocks.uncompleteRecurringOrFlip).toHaveBeenCalledWith("p1");
    expect(mocks.requestComplete).not.toHaveBeenCalled();
    expect(mocks.updatePage).not.toHaveBeenCalled();
  });

  it("routes a non-recurring page through a plain updatePage", () => {
    mocks.recurrenceRules = [ruleFor("other")]; // rule exists, but not for p1

    toggle()(PAGE, "done");

    expect(mocks.updatePage).toHaveBeenCalledTimes(1);
    const [id, patch] = mocks.updatePage.mock.calls[0]!;
    expect(id).toBe("p1");
    expect(patch.status).toBe("done");
    expect(typeof patch.completedAt).toBe("string");
    expect(mocks.requestComplete).not.toHaveBeenCalled();
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
  });

  it("clears completedAt when a non-recurring page is un-done", () => {
    toggle()(PAGE, "not_started");

    expect(mocks.updatePage).toHaveBeenCalledWith("p1", {
      completedAt: null,
      status: "not_started",
    });
  });

  it("suppresses all fallthrough when the un-check handler takes it", () => {
    mocks.maybeUncompleteRecurringClone.mockReturnValue(true);
    mocks.recurrenceRules = [ruleFor("p1")]; // recurring, yet nothing below must fire

    toggle()(PAGE, "not_started");

    expect(mocks.requestComplete).not.toHaveBeenCalled();
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
    expect(mocks.updatePage).not.toHaveBeenCalled();
  });
});
