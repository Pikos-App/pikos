// E2E tests for the calendar create-via-popover flow.
// Clicking an empty calendar slot creates a page and auto-opens its metadata
// popover. Enter commits the title (defaulting to "Untitled"), Escape or
// outside-click discards the page if still untitled, or keeps it if titled.
// Runs against MockStorageAdapter (VITE_TEST_MODE=true).

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

async function openCalendarMode(app: Page) {
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

/** The last visible all-day column — always >= today within the current week,
 * so the page's denormalised scheduledStart isn't stripped by the
 * "next upcoming" filter on past schedules. */
function lastAllDayColumn(app: Page) {
  return app.locator('[aria-label^="All-day events,"]').last();
}

// ─── Popover opens on create ────────────────────────────────────────────────

appTest("calendar click auto-opens the metadata popover @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  // Popover's title input is rendered and focused so the user can type immediately.
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
});

// ─── Enter commits ──────────────────────────────────────────────────────────

appTest("Enter commits typed title and closes popover @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Release planning");
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  await expect(col.getByText("Release planning")).toBeVisible();
});

appTest("Enter on empty title saves page as Untitled @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  // A chip remains (title persisted as "Untitled") — wait past the deferred
  // delete check to ensure it's not removed.
  await app.waitForTimeout(100);
  await expect(col.getByText("Untitled")).toBeVisible();
});

// ─── Escape discards untitled, keeps titled ─────────────────────────────────

appTest("Escape on empty title deletes the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  // Deferred delete (setTimeout 0) — give it time to run.
  await app.waitForTimeout(100);
  await expect(col.getByText("Untitled")).not.toBeVisible();
});

appTest("Escape with typed title keeps the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Keep me");
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(col.getByText("Keep me")).toBeVisible();
});

// ─── Outside click ──────────────────────────────────────────────────────────

appTest("outside click on empty popover deletes the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();
  await expect(app.getByPlaceholder("Untitled")).toBeFocused();

  // Click outside the popover — on the week calendar header area.
  await app.getByRole("region", { name: "Week calendar" }).click({ position: { x: 5, y: 5 } });

  await expect(app.getByPlaceholder("Untitled")).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(col.getByText("Untitled")).not.toBeVisible();
});

appTest("outside click with typed title keeps the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const col = lastAllDayColumn(app);
  await col.click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Save on blur");
  // Click outside the popover.
  await app.getByRole("region", { name: "Week calendar" }).click({ position: { x: 5, y: 5 } });

  await expect(titleInput).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(col.getByText("Save on blur")).toBeVisible();
});
