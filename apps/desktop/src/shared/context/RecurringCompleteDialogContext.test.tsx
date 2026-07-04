// RecurringCompleteDialogContext — the gap-resolution dialog's missed-date labels.
//
// The labels must reflect the occurrence sets: an occurrence the user already
// skipped (or completed) between the overdue head and today is addressed, not
// "missed", so it must not appear in the dialog's missedDates.

import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  return renderHookWithProviders(() => {
    const workspace = useWorkspace();
    const pages = usePages();
    const dialog = useRecurringCompleteDialog();
    return { dialog, pages, workspace };
  });
}

describe("RecurringCompleteDialog — missed-date labels", () => {
  it("excludes a skipped gap occurrence from the missed dates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    try {
      const hook = setup();
      await act(async () => {
        await hook.result.current.workspace.selectWorkspace();
      });

      let pageId!: string;
      await act(async () => {
        const p = await hook.result.current.pages.createPage({ title: "Daily standup" });
        pageId = p.id;
        await hook.result.current.pages.scheduleOnce(p.id, "2026-06-10T09:00:00");
        await hook.result.current.pages.createRecurrence({
          pageId: p.id,
          rrule: "FREQ=DAILY",
          scheduledStart: "2026-06-10T09:00:00",
          timezone: "America/New_York",
        });
        // Skip one occurrence inside the overdue gap (head 06-10 → today 06-15).
        await hook.result.current.pages.skipOccurrence(p.id, "2026-06-13");
      });

      act(() => {
        hook.result.current.dialog.request(pageId);
      });

      await waitFor(() => {
        expect(hook.result.current.dialog.pending).not.toBeNull();
      });

      const missed = hook.result.current.dialog.pending!.missedDates;
      expect(missed).not.toContain("2026-06-13");
      expect(missed).toEqual(expect.arrayContaining(["2026-06-11", "2026-06-12", "2026-06-14"]));
    } finally {
      vi.useRealTimers();
    }
  });
});
