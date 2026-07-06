// useRecurringStatusToggle — the shared router that decides how a status toggle
// dispatches: recurring-occurrence handler first, then recurring done/undone, then
// a plain non-recurring update. A branch reorder here silently mis-routes a synced
// completion (the bug this hook was extracted to prevent), so each arm is pinned.

import type { PageRecurrenceRule, PageStatus, PageSummary, PageUpdate } from "@pikos/core";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRecurringStatusToggle } from "./useRecurringStatusToggle";

const mocks = vi.hoisted(() => ({
  maybeToggleRecurringOccurrence: vi.fn<(page: PageSummary, next: PageStatus) => boolean>(),
  recurrenceRules: [] as PageRecurrenceRule[],
  requestRecurringComplete: vi.fn(),
  uncompleteRecurringOrFlip: vi.fn(),
  updatePage: vi.fn<(id: string, patch: PageUpdate) => void>(),
}));

vi.mock("@/shared/context/PagesContext", () => ({
  usePages: () => ({
    maybeToggleRecurringOccurrence: mocks.maybeToggleRecurringOccurrence,
    recurrenceRules: mocks.recurrenceRules,
    uncompleteRecurringOrFlip: mocks.uncompleteRecurringOrFlip,
    updatePage: mocks.updatePage,
  }),
}));

vi.mock("@/shared/context/RecurringCompleteDialogContext", () => ({
  useRecurringCompleteDialog: () => ({ request: mocks.requestRecurringComplete }),
}));

const PAGE = { id: "p1" } as PageSummary;
const ruleFor = (pageId: string): PageRecurrenceRule => ({ pageId }) as PageRecurrenceRule;

function toggle(): (page: PageSummary, next: PageStatus) => void {
  return renderHook(() => useRecurringStatusToggle()).result.current;
}

describe("useRecurringStatusToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeToggleRecurringOccurrence.mockReturnValue(false);
    mocks.recurrenceRules = [];
  });

  it("routes a done toggle on a recurring series to the complete dialog", () => {
    mocks.recurrenceRules = [ruleFor("p1")];

    toggle()(PAGE, "done");

    expect(mocks.requestRecurringComplete).toHaveBeenCalledWith("p1");
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
    expect(mocks.updatePage).not.toHaveBeenCalled();
  });

  it("routes an un-done toggle on a recurring series to uncompleteRecurringOrFlip", () => {
    mocks.recurrenceRules = [ruleFor("p1")];

    toggle()(PAGE, "not_started");

    expect(mocks.uncompleteRecurringOrFlip).toHaveBeenCalledWith("p1");
    expect(mocks.requestRecurringComplete).not.toHaveBeenCalled();
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
    expect(mocks.requestRecurringComplete).not.toHaveBeenCalled();
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
  });

  it("clears completedAt when a non-recurring page is un-done", () => {
    toggle()(PAGE, "not_started");

    expect(mocks.updatePage).toHaveBeenCalledWith("p1", {
      completedAt: null,
      status: "not_started",
    });
  });

  it("suppresses all fallthrough when maybeToggleRecurringOccurrence handles it", () => {
    mocks.maybeToggleRecurringOccurrence.mockReturnValue(true);
    mocks.recurrenceRules = [ruleFor("p1")]; // recurring, yet nothing below must fire

    toggle()(PAGE, "done");

    expect(mocks.requestRecurringComplete).not.toHaveBeenCalled();
    expect(mocks.uncompleteRecurringOrFlip).not.toHaveBeenCalled();
    expect(mocks.updatePage).not.toHaveBeenCalled();
  });
});
