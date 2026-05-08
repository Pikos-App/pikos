// E2E coverage for empty / negative-path states. These flows are easy to
// break silently — a regression in an empty state usually shows up as a blank
// panel that confuses new users, not a thrown error. Specs here lock down
// the user-visible empty-state copy and the cross-feature consequences of
// deleting a scheduled page.

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

// ─── Today empty state ──────────────────────────────────────────────────────
//
// First-launch users often hit Today before any scheduled pages exist; the
// empty-state copy is what they read first. This test confirms the icon-and-
// hint surface (a regression that drops the empty state would leave the
// panel blank).

appTest("Today view with no scheduled pages shows the empty state @tier1", async ({ app }) => {
  // Create an unscheduled page from Inbox (the default active view) — when
  // active view is Today, QuickAdd auto-anchors the schedule to today, so
  // the page would land in Today and defeat the test premise. Stay on Inbox.
  await quickAdd(app, "fresh capture");

  // Now switch to Today — the page is unscheduled and must NOT appear here.
  await app.getByRole("button", { name: /^Today/ }).click();
  await expect(app.getByText("Nothing scheduled for today")).toBeVisible();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "fresh capture" })
  ).not.toBeVisible();

  // The Today list is empty — no page-list-items rendered at all.
  await expect(app.locator("[data-page-list-item]")).toHaveCount(0);
});

// ─── Search palette empty + "Show completed" toggle ────────────────────────
//
// The basic Cmd+K search test in search.spec.ts only walks the success path.
// Here we exercise: (a) "No pages found" copy when the query has zero matches
// at all, and (b) the "Show completed (N)" toggle that lets users surface
// hidden completed-page matches without changing query.

appTest(
  "search palette: 'No pages found' empty + 'Show completed' toggles in completed matches @tier2",
  async ({ app }) => {
    await quickAdd(app, "active draft");
    await quickAdd(app, "archive item");

    // Mark "archive item" done — it leaves the active list and only surfaces
    // in palette searches via the Show-completed toggle.
    const archive = app
      .locator("[data-page-list-item]")
      .filter({ hasText: "archive item" });
    await archive.getByRole("checkbox", { name: "Mark done" }).click();
    await expect(archive).not.toBeVisible();

    // Open palette and search for an obviously-absent term.
    await app.keyboard.press(mod("Mod+k"));
    const palette = app.getByRole("dialog", { name: "Search pages" });
    await expect(palette).toBeVisible();
    const input = palette.getByPlaceholder("Search pages…");
    await input.fill("nonexistentquery");

    // Empty-state copy appears once the FTS debounce settles. The default
    // expect timeout already covers the 150 ms search debounce.
    await expect(palette.getByText("No pages found")).toBeVisible();

    // Re-target an in-completed term — initial result is still empty (active
    // pages don't match "archive"), but a "Show completed (1)" toggle appears.
    await input.fill("");
    await input.fill("archive");
    const showCompletedBtn = palette.getByRole("button", { name: /^Show completed \(\d+\)/ });
    await expect(showCompletedBtn).toBeVisible();
    // The completed page is NOT in the visible result set yet.
    await expect(palette.getByText("archive item")).not.toBeVisible();

    // Click the toggle — completed match surfaces.
    await showCompletedBtn.click();
    await expect(palette.getByText("archive item")).toBeVisible();
    // Toggle label flips to "Hide completed".
    await expect(palette.getByRole("button", { name: "Hide completed" })).toBeVisible();
  }
);

// ─── Schedule references a deleted page → calendar chip clears ─────────────
//
// Cross-cuts: page deletion (soft delete via context menu) and calendar
// rendering (chip is keyed on page.id). A regression that left orphaned
// chips on the calendar would turn the calendar into a graveyard of
// deleted titles.

appTest(
  "deleting a scheduled page removes its calendar chip @tier2",
  async ({ app }) => {
    // Seed a page scheduled for today via NLP. "lunch today" parses cleanly
    // (no recurrence / multi-day issues) and bare "today" anchors the date.
    await quickAdd(app, "lunch today");

    // Switch into calendar mode — the page should appear as an all-day chip
    // on today's column.
    const calendarBtn = app.getByRole("button", { name: "Calendar view" });
    await calendarBtn.click();
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    const calendar = app.getByRole("region", { name: "Week calendar" });
    const chip = calendar.getByRole("button", { name: "lunch" });
    await expect(chip).toHaveCount(1);

    // Switch back to editor (so the page-list is the only delete target;
    // the calendar's chip context-menu uses a different code path covered
    // elsewhere) and right-click the page in the list.
    const editorBtn = app.getByRole("button", { name: "Editor view" });
    await editorBtn.click();
    const item = app.locator("[data-page-list-item]").filter({ hasText: "lunch" });
    await item.click({ button: "right" });
    await app.getByRole("menuitem", { name: "Delete" }).click();

    // Page list drops the entry.
    await expect(item).not.toBeVisible();

    // Re-open calendar and verify the chip is gone — the deletion cleared
    // the schedule too. (The calendar uses the live pages list, so a
    // soft-deleted page's chip must not linger.)
    await calendarBtn.click();
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(calendar.getByRole("button", { name: "lunch" })).toHaveCount(0);
  }
);
