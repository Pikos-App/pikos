// E2E for month view: switching shapes from the calendar header, seeing a
// seeded event land in its day cell, and clicking that chip through to the same
// metadata popover the week grid opens.
// Runs against MockStorageAdapter (VITE_TEST_MODE=true).

import type { Page } from "@playwright/test";

import { expect, quickAdd, test as appTest } from "./fixtures";

async function openCalendarMode(app: Page) {
  // Click the header button rather than the shortcut — a keypress can be
  // dropped before the keyboard registry mounts (see calendar.spec.ts).
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.waitFor({ state: "visible" });
  if ((await calendarBtn.getAttribute("aria-pressed")) !== "true") {
    await calendarBtn.click();
  }
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

async function switchToMonth(app: Page) {
  await app.getByRole("button", { name: "Month view" }).click();
  await expect(app.getByRole("region", { name: "Month calendar" })).toBeVisible();
}

function monthRegion(app: Page) {
  return app.getByRole("region", { name: "Month calendar" });
}

/** Seed an all-day page on today via the week grid's click-to-create flow, so
 * the event is guaranteed to fall inside the month grid's visible range. */
async function seedTodayEvent(app: Page, title: string) {
  await app.locator('[aria-label^="All-day events,"]').last().click();
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill(title);
  await app.keyboard.press("Enter");
  await expect(titleInput).not.toBeVisible();
}

appTest("month view shows a seeded event and opens its popover @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await seedTodayEvent(app, "Board review");

  await switchToMonth(app);

  const chip = monthRegion(app).getByRole("button", { name: "Board review" });
  await expect(chip.first()).toBeVisible();

  // Single click routes through the shared block-popover hook — same popover
  // the week grid opens, so the title input is the thing that appears.
  await chip.first().click();
  await expect(app.getByPlaceholder("Untitled")).toHaveValue("Board review");
});

appTest("month view never widens the window @tier2", async ({ app }) => {
  for (const [title, when] of [
    ["Quarterly planning review with the whole platform team", "today 9am"],
    ["Follow-up on the migration rollback decision and its owners", "tomorrow 10am"],
    ["Retrospective for the calendar sync rollout, part two", "tomorrow 2pm"],
  ]) {
    await quickAdd(app, `${title} ${when}`);
  }
  await openCalendarMode(app);
  await switchToMonth(app);
  // Narrow enough that cells sized to their content would not fit seven across.
  await app.setViewportSize({ height: 800, width: 1000 });
  await app.waitForTimeout(300);

  // Guards the panel's min-w-0 — see EditorPanel.
  const { client, scroll } = await app.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll).toBe(client);
});

appTest("month view header navigates by month and back to today @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await switchToMonth(app);

  const label = app.getByRole("heading", { name: "Visible month" });
  const current = await label.textContent();

  await app.getByRole("button", { name: "Next month" }).click();
  await expect(label).not.toHaveText(current ?? "");

  await app.getByRole("button", { name: "Jump to current month" }).click();
  await expect(label).toHaveText(current ?? "");
});

appTest("clicking a month day cell returns to the time grid @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await switchToMonth(app);

  await monthRegion(app)
    .getByRole("button", { name: /^Go to / })
    .first()
    .click();

  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await expect(monthRegion(app)).toHaveCount(0);
});
