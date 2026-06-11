// E2E coverage for state that survives a full page reload. Anything stored
// in localStorage is a UX contract: if it doesn't survive reload, the user
// either has to re-set it on every launch (annoying) or — worse — silently
// loses progress. The data layer (pages/folders) is in-memory in test mode,
// so this spec only verifies UI-shell state: right-panel mode, sidebar
// collapsed-ness, calendar reference week, and per-view sort mode.

import { expect, mod, test as appTest } from "./fixtures";

// ─── Right panel mode (editor ↔ calendar) ───────────────────────────────────

appTest(
  "right panel calendar mode persists across reload @tier1",
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Calendar view" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await app.reload();
    await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Calendar view" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(app.getByRole("button", { name: "Editor view" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  }
);

// ─── Sidebar collapsed state ────────────────────────────────────────────────

appTest("sidebar collapsed state persists across reload @tier2", async ({ app }) => {
  // Sidebar visible by default — "Collapse sidebar" button is the proof.
  const collapseBtn = app.getByRole("button", { name: "Collapse sidebar" });
  await expect(collapseBtn).toBeVisible();
  await collapseBtn.click();

  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).not.toBeVisible();
});

// ─── Calendar reference week ────────────────────────────────────────────────
//
// The calendar's reference date is persisted as an ISO string. After
// navigating to a non-current week and reloading, the same week should
// re-render — otherwise users land on "today" each time and have to re-page
// back to whatever week they were planning.

appTest("calendar reference week persists across reload @tier2", async ({ app }) => {
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.click();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  // Capture the current week's range label, then advance two weeks. The
  // heading lives in the right-panel header (sibling of the Week calendar
  // region) and carries an explicit accessible name so the assertion doesn't
  // depend on its dynamic text.
  const weekHeading = app.getByRole("heading", { name: "Visible week" });
  const initialLabel = await weekHeading.textContent();

  // Use the icon button (not the date-picker nav button which shares the
  // accessible name).
  const nextWeek = app.locator('button[aria-label="Next week"]');
  await nextWeek.click();
  await nextWeek.click();

  const movedLabel = await weekHeading.textContent();
  expect(movedLabel).not.toBe(initialLabel);

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
  // Reload also restores the calendar panel mode; assert region is back.
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  const restoredLabel = await app
    .getByRole("heading", { name: "Visible week" })
    .textContent();
  expect(restoredLabel).toBe(movedLabel);
});

// ─── Per-view sort mode ─────────────────────────────────────────────────────
//
// Each view (Inbox, folders) remembers its own sort mode. Once the user picks
// "Title", the order should still be alphabetical after reload — even though
// the underlying pages are wiped (test-mode adapter is in-memory). The sort
// chip's accessible name carries the current mode so we can assert without
// inspecting the actual order.

appTest("per-view sort mode persists across reload @tier2", async ({ app }) => {
  // Inbox is the default active view; the sort menu is visible there
  // (Today suppresses it).
  const sortBtn = app.getByRole("button", { name: /^Sort:/ });
  await expect(sortBtn).toBeVisible();
  // Default sort label varies by build — set it explicitly to "Title".
  await sortBtn.click();
  await app.getByRole("menuitem", { name: "Title" }).click();
  await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

  await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();
});
