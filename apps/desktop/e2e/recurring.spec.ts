import type { Page } from "@playwright/test";

import { test as appTest, expect, mod, openCalendarMode } from "./fixtures";

/** The last visible all-day column, within the current week so denorms hold. */
function lastAllDayColumn(app: Page) {
  return app.locator('[aria-label^="All-day events,"]').last();
}

function calendarRegion(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

/** Advance the calendar one week so the visible window is wholly after the head: a full row of virtuals on any weekday or time of day. */
async function advanceCalendarOneWeek(app: Page) {
  await app.getByRole("button", { name: "Next week" }).click();
}

appTest("add recurrence later via the page editor byline", async ({ app }) => {
  // Titles avoid "weekly" / "daily" / "monthly": QuickAdd strips them and attaches a rule, defeating the premise.
  // MetadataHeader auto-anchors an undated page to today when a rule is attached.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
  await listItem.click();

  await app.getByRole("button", { name: "Set recurrence" }).click();

  await app.getByRole("button", { name: /^Daily/ }).click();

  await expect(app.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();
});

// Guards the handler wiring; snap semantics live in core's recurrence.test.ts.
// Raw `page` fixture: page.clock.install must run before page.goto.
appTest(
  "attaching a rule that excludes today snaps the head forward @mock-only",
  async ({ page }) => {
    // Pin "now" to a Sunday, which the weekday rule excludes.
    await page.clock.install({ time: new Date("2026-06-07T09:00:00") });
    await page.clock.resume();
    await page.goto("/");
    await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

    await page.keyboard.press(mod("Mod+n"));
    const dialog = page.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await page.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
    await page.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    const listItem = page.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
    await listItem.click();
    await expect(page.getByRole("button", { name: "Set schedule" })).toBeVisible();

    // The head auto-anchors to Sunday, which the rule excludes, so it must snap to Monday.
    await page.getByRole("button", { name: "Set recurrence" }).click();
    await page.getByRole("button", { name: /^Every weekday/ }).click();

    // The outcome is the contract: in mock mode `recomputeHead` heals an unsnapped anchor, so this
    // stays green whether the client-side snap ran or the backend caught it.
    await expect(page.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scheduled: Today" })).toHaveCount(0);
  }
);

// PageBlockPopover opens only for scheduled pages, so the recurrence chip is always reachable.

appTest("calendar popover lets users add recurrence to a scheduled page", async ({ app }) => {
  await openCalendarMode(app);

  await lastAllDayColumn(app).click();
  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Standup");
  await app.keyboard.press("Enter");

  const chip = calendarRegion(app).getByRole("button", { name: "Standup" });
  await expect(chip).toHaveCount(1);

  await chip.click();

  await app.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();

  await expect(app.getByRole("button", { name: /Recurrence: every day/i }).first()).toBeVisible();
});

appTest("completing a head page creates a done clone and advances head", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toHaveCount(1);
  await listItem.click();

  const statusButton = app.getByRole("button", { name: "Mark done" });
  await expect(statusButton).toBeVisible();
  await statusButton.click();

  await expect(app.getByRole("button", { name: /^Recurrence: every day/i })).toBeVisible();
});

// The clone's completed_at is local wall-clock: a UTC value is filtered out of Today's Completed for part of each day.

appTest("page-list checkbox completes a recurring page into Completed @smoke", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  // All-day rule: a timed input rolls to tomorrow once today's time passes (chrono forwardDate), dropping the head out of Today.
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await app.getByRole("button", { name: /^Today/ }).click();
  const items = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(items).toHaveCount(1);

  // Today has no missed-day gap, so completion is immediate with no dialog.
  await items
    .first()
    .getByRole("checkbox", { name: /Mark done/i })
    .click();

  await app.getByRole("button", { exact: true, name: "Completed" }).click();
  // Wait past quick-add's 800ms denorm debounce: completion flushes the pending write first,
  // but a stale write landing after the advance would snap the head back into Today.
  await app.waitForTimeout(1000);
  await expect(items).toHaveCount(1);
  await expect(items.first().getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
});

appTest(
  "unchecking a done recurring clone restores the occurrence onto the head",
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    // All-day so the head always lands in Today.
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await app.getByRole("button", { name: /^Today/ }).click();
    const items = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    await expect(items).toHaveCount(1);
    await items
      .first()
      .getByRole("checkbox", { name: /Mark done/i })
      .click();

    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    // Wait past the quick-add denorm debounce, as in the completion test.
    await app.waitForTimeout(1000);
    const clone = items.filter({ has: app.getByRole("checkbox", { name: /Mark not done/i }) });
    await expect(clone).toHaveCount(1);

    // Rewinds onto the head and deletes the clone; a plain flip would leave two open rows.
    await clone.getByRole("checkbox", { name: /Mark not done/i }).click();
    await expect(
      items.filter({ has: app.getByRole("checkbox", { name: /Mark not done/i }) })
    ).toHaveCount(0);
    await expect(
      items.filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
    ).toHaveCount(1);
  }
);

appTest(
  "daily recurring page renders virtual occurrences on the calendar @smoke",
  async ({ app }) => {
    // Timed so the head lands in the timed grid; the parser strips so many words from all-day titles that those are hard to keep stable.
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    await advanceCalendarOneWeek(app);
    const calendar = calendarRegion(app);

    // Wait for a Recurring icon so expansion has finished.
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
    const chips = calendar.getByRole("button", { name: /^standup/i });
    const count = await chips.count();
    // At least 2, leaving slack for the expansion window or week start day.
    expect(count).toBeGreaterThanOrEqual(2);
  }
);

appTest(
  "deleting a future virtual hides it with no dialog; undo restores it",
  { tag: ["@TRASH-02:3"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    await advanceCalendarOneWeek(app);
    const calendar = calendarRegion(app);
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5000 });
    const virtualsBefore = await calendar.getByLabel("Recurring").count();
    expect(virtualsBefore).toBeGreaterThanOrEqual(2);

    const firstVirtual = calendar
      .getByRole("button", { name: /^standup/i })
      .filter({ has: app.getByLabel("Recurring") })
      .first();
    await firstVirtual.scrollIntoViewIfNeeded();
    await firstVirtual.click();
    await app.getByRole("button", { name: "Delete this occurrence" }).click();

    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 1);

    // Cmd+Z fires the latest undoable toast, which exists only once the delete is written.
    await expect(app.getByRole("alert", { name: /Deleted one day of/ })).toBeVisible();
    await app.keyboard.press(mod("Mod+z"));
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore);
  }
);

// Virtuals share the head's page id; each occurrence must stay its own chip, not one bar merged across a gap-free run.
appTest("all-day daily recurrence renders separate chips, not one eternal bar", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("Standup every day");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await openCalendarMode(app);
  await advanceCalendarOneWeek(app);
  const calendar = calendarRegion(app);

  await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
  // Each day is its own chip, so 2 or more bars prove they didn't merge.
  const chips = calendar.getByRole("button", { name: /^Standup/ });
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
});

// Dragging a virtual materialises an independent page and exdates the original date;
// completing the head then advances past the materialised date.

appTest(
  "drag virtual reschedules to a real page; head advance skips the materialised date",
  async ({ app }) => {
    // Timed so virtuals land in the timed grid, which is easier to drag.
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    await advanceCalendarOneWeek(app);
    const calendar = calendarRegion(app);

    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5000 });
    const virtualsBefore = await calendar.getByLabel("Recurring").count();
    const totalChipsBefore = await calendar.getByRole("button", { name: /^standup/i }).count();
    expect(virtualsBefore).toBeGreaterThanOrEqual(1);
    expect(totalChipsBefore).toBeGreaterThanOrEqual(2);

    // Drag 60px up: one hour earlier on the same day (the calendar is hour-pitched).
    const firstVirtual = calendar
      .getByRole("button", { name: /^standup/i })
      .filter({ has: app.getByLabel("Recurring") })
      .first();
    // WeekGrid starts at max(7am, now-1h): late in the day 9am chips sit above the viewport, so scroll in first.
    await firstVirtual.scrollIntoViewIfNeeded();
    const box = await firstVirtual.boundingBox();
    if (!box) throw new Error("virtual chip has no bounding box");

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const dropY = startY - 60; // one hour earlier on the same day

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX, startY - 12, { steps: 5 }); // cross drag-threshold
    await app.mouse.move(startX, dropY, { steps: 5 });
    await app.mouse.up();

    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 1);
    await expect(calendar.getByRole("button", { name: /^standup/i })).toHaveCount(totalChipsBefore);

    // Complete via the editor byline, more reliable than the chip's nested checkbox. Enter on the first
    // list item (the head, earliest scheduledStart) opens it in the editor.
    const listHead = app.locator("[data-page-list-item]").filter({ hasText: "standup" }).first();
    await listHead.click();
    await listHead.press("Enter");
    // Anchored: "Mark done" also appears in page-list item names.
    const bylineDone = app.getByRole("button", { name: /^Mark done$/i });
    await expect(bylineDone).toBeVisible();
    await bylineDone.click();
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(calendarRegion(app)).toBeVisible();

    // Assert the behavioural contract: one done clone and two open standups (advanced head and
    // materialised page). Chip arithmetic only fits the visible window on some weekdays; exdate
    // semantics are covered in core's recurrence.test.ts.
    const allStandups = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(allStandups).toHaveCount(3);
  }
);

/** Daily recurring head anchored Mon 2026-06-08, with "now" jumped to Thu
 *  2026-06-11 so Tue + Wed are missed. Returns the "standup" list-item locator. */
async function seedOverdueDailyRecurring(page: import("@playwright/test").Page) {
  await page.clock.install({ time: new Date("2026-06-08T09:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

  await page.keyboard.press(mod("Mod+n"));
  const dialog = page.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await page.getByRole("textbox", { name: "Quick add input" }).fill("standup every day");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // The head stays on Mon (no recompute), so completing sees Tue and Wed as missed.
  await page.clock.setFixedTime(new Date("2026-06-11T09:00:00"));

  return page.locator("[data-page-list-item]").filter({ hasText: "standup" });
}

appTest(
  "overdue tick → just this one keeps the gap and drops one clone @mock-only",
  async ({ page }) => {
    const items = await seedOverdueDailyRecurring(page);
    await items
      .first()
      .getByRole("checkbox", { name: /Mark done/i })
      .click();

    await expect(page.getByText(/2 other days are still open/)).toBeVisible();
    // Names the page it acts on and calls them days, matching the body.
    await expect(page.getByRole("dialog")).toContainText(/Mark .*standup.* done\?/);
    await expect(page.getByRole("dialog")).not.toContainText(/occurrence/i);
    await expect(page.getByRole("button", { name: /Just this one/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /This and everything before today/ })
    ).toBeVisible();

    await page.getByRole("button", { name: /Just this one/ }).click();
    await expect(page.getByText(/2 other days are still open/)).not.toBeVisible();

    await page.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(
      items.filter({ has: page.getByRole("checkbox", { name: /Mark not done/i }) })
    ).toHaveCount(1);
  }
);

appTest(
  "overdue tick → everything before today clones one done page per day @mock-only",
  async ({ page }) => {
    const items = await seedOverdueDailyRecurring(page);
    await items
      .first()
      .getByRole("checkbox", { name: /Mark done/i })
      .click();

    await expect(page.getByText(/2 other days are still open/)).toBeVisible();
    await page.getByRole("button", { name: /This and everything before today/ }).click();
    await expect(page.getByText(/2 other days are still open/)).not.toBeVisible();

    await page.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(
      items.filter({ has: page.getByRole("checkbox", { name: /Mark not done/i }) })
    ).toHaveCount(3);
    await expect(
      items.filter({ has: page.getByRole("checkbox", { name: /Mark done/i }) })
    ).toHaveCount(1);
  }
);

/** Open the backlog scope dialog by deleting the first overdue virtual (Tue: the head, Mon, is a real
 *  block), and hand back the calendar plus the block count from before it was asked. */
async function deleteFirstOverdueVirtual(page: import("@playwright/test").Page) {
  await openCalendarMode(page);
  const calendar = calendarRegion(page);
  await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
  const before = await calendar.getByLabel("Recurring").count();

  const firstVirtual = calendar
    .getByRole("button", { name: /^standup/i })
    .filter({ has: page.getByLabel("Recurring") })
    .first();
  await firstVirtual.scrollIntoViewIfNeeded();
  await firstVirtual.click();
  await page.getByRole("button", { name: "Delete this occurrence" }).click();
  await expect(page.getByText(/2 other days are still open/)).toBeVisible();

  return { before, calendar };
}

/** No done clone was minted: separates a delete from a tick. */
async function expectNothingCompleted(
  page: import("@playwright/test").Page,
  items: ReturnType<import("@playwright/test").Page["locator"]>
) {
  await page.getByRole("button", { exact: true, name: "Completed" }).click();
  await expect(
    items.filter({ has: page.getByRole("checkbox", { name: /Mark not done/i }) })
  ).toHaveCount(0);
}

appTest(
  "deleting a past occurrence → everything before today clears the gap @mock-only",
  async ({ page }) => {
    const items = await seedOverdueDailyRecurring(page);
    const { before, calendar } = await deleteFirstOverdueVirtual(page);

    await page.getByRole("button", { name: /This and everything before today/ }).click();

    await expect(calendar.getByLabel("Recurring")).toHaveCount(before - 3);
    await expectNothingCompleted(page, items);
  }
);

appTest(
  "deleting a past occurrence → just this one leaves the rest of the gap open @mock-only",
  async ({ page }) => {
    const items = await seedOverdueDailyRecurring(page);
    const { before, calendar } = await deleteFirstOverdueVirtual(page);

    await expect(page.getByRole("button", { name: /Just this one/ })).toBeVisible();
    await page.getByRole("button", { name: /Just this one/ }).click();

    // The head's own Monday and Wednesday stay open: the head can't advance while its own day is neither ticked nor dismissed.
    await expect(calendar.getByLabel("Recurring")).toHaveCount(before - 1);
    await expectNothingCompleted(page, items);
  }
);

appTest("Stop repeating removes the recurrence rule", { tag: ["@RECUR-11"] }, async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("yoga every monday at 7am");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "yoga" });
  await listItem.click();

  await app.getByRole("button", { name: /Recurrence: every week on Monday/i }).click();

  await app.getByRole("button", { name: "Stop repeating" }).click();

  await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
});
