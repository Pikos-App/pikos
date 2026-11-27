import type { Page } from "@playwright/test";

import { test as appTest, createFolder, expect, mod, openCalendarMode, quickAdd } from "./fixtures";

/** The last visible all-day column, always >= today within the current week, so the page's
 * denormalised scheduledStart isn't stripped by the "next upcoming" filter on past schedules. */
function lastAllDayColumn(app: Page) {
  return app.locator('[aria-label^="All-day events,"]').last();
}

/** Bars render in a sibling overlay, not inside the column's DOM, so assertions scope to the calendar region. */
function calendarRegion(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

appTest("calendar click auto-opens the metadata popover @smoke", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
});

appTest("Enter commits typed title and closes popover", { tag: ["@CAL-04:4"] }, async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Release planning");
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  await expect(calendarRegion(app).getByText("Release planning")).toBeVisible();
});

appTest("Enter on empty title saves page as Untitled", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  // A bar remains; wait past the deferred delete check to confirm it isn't removed.
  await app.waitForTimeout(100);
  await expect(calendarRegion(app).getByRole("button", { name: "Untitled" })).toBeVisible();
});

appTest("Escape on empty title deletes the page", { tag: ["@CAL-04:4"] }, async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  // Deferred delete (setTimeout 0): give it time to run.
  await app.waitForTimeout(100);
  await expect(calendarRegion(app).getByRole("button", { name: "Untitled" })).toHaveCount(0);
});

appTest("Escape with typed title keeps the page", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Keep me");
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(calendarRegion(app).getByText("Keep me")).toBeVisible();
});

appTest(
  "outside click on empty popover deletes the page",
  { tag: ["@CAL-04:4"] },
  async ({ app }) => {
    await openCalendarMode(app);
    await lastAllDayColumn(app).click();
    await expect(app.getByPlaceholder("Untitled")).toBeFocused();

    await calendarRegion(app).click({ position: { x: 5, y: 5 } });

    await expect(app.getByPlaceholder("Untitled")).not.toBeVisible();
    await app.waitForTimeout(100);
    await expect(calendarRegion(app).getByRole("button", { name: "Untitled" })).toHaveCount(0);
  }
);

appTest(
  "outside click with typed title keeps the page",
  { tag: ["@CAL-04:4"] },
  async ({ app }) => {
    await openCalendarMode(app);
    await lastAllDayColumn(app).click();

    const titleInput = app.getByPlaceholder("Untitled");
    await titleInput.fill("Save on blur");
    await calendarRegion(app).click({ position: { x: 5, y: 5 } });

    await expect(titleInput).not.toBeVisible();
    await app.waitForTimeout(100);
    await expect(calendarRegion(app).getByText("Save on blur")).toBeVisible();
  }
);

async function centerOf(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible element with a bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

appTest("drag across all-day columns creates a multi-day span", async ({ app }) => {
  await openCalendarMode(app);

  // Last two columns, so the span starts today-or-later (past-only spans exercise different denorm paths).
  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  const startCol = cols.nth(colCount - 2);
  const endCol = cols.nth(colCount - 1);

  const startAt = await centerOf(startCol);
  const endAt = await centerOf(endCol);

  await app.mouse.move(startAt.x, startAt.y);
  await app.mouse.down();
  const midX = (startAt.x + endAt.x) / 2;
  await app.mouse.move(midX, endAt.y, { steps: 5 });
  await app.mouse.move(endAt.x, endAt.y, { steps: 5 });
  await app.mouse.up();

  // Type a title so the page persists past handleAutoOpenConsumed's empty-title check.
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Offsite");
  await app.keyboard.press("Enter");

  // Scoped to the calendar region: the sidebar page list also shows an "Offsite" entry.
  const calendarChips = app
    .getByRole("region", { name: "Week calendar" })
    .getByRole("button", { name: "Offsite" });
  await expect(calendarChips).toHaveCount(1);
});

appTest("drag right edge of multi-day chip extends the span", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = app.getByRole("region", { name: "Week calendar" });

  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  if (colCount < 3) return; // narrow layout — skip
  const startCol = cols.nth(colCount - 3);
  const midCol = cols.nth(colCount - 2);
  const endCol = cols.nth(colCount - 1);

  const startAt = await centerOf(startCol);
  const midAt = await centerOf(midCol);

  await app.mouse.move(startAt.x, startAt.y);
  await app.mouse.down();
  await app.mouse.move(midAt.x, midAt.y, { steps: 8 });
  await app.mouse.up();
  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Conference");
  await app.keyboard.press("Enter");

  const chips = calendar.getByRole("button", { name: "Conference" });
  await expect(chips).toHaveCount(1);

  const chipBox = await chips.first().boundingBox();
  if (!chipBox) throw new Error("chip missing");
  const endAt = await centerOf(endCol);

  const edgeX = chipBox.x + chipBox.width - 2;
  const edgeY = chipBox.y + chipBox.height / 2;
  await app.mouse.move(edgeX, edgeY);
  await app.mouse.down();
  await app.mouse.move(endAt.x, endAt.y, { steps: 10 });
  await app.mouse.up();

  await expect(chips).toHaveCount(1);
  const extendedBox = await chips.first().boundingBox();
  if (!extendedBox) throw new Error("chip missing after resize");
  expect(extendedBox.width).toBeGreaterThan(chipBox.width);
});

appTest("all-day chip renders at its declared bar height", async ({ app }) => {
  await openCalendarMode(app);
  const at = await centerOf(lastAllDayColumn(app));
  await app.mouse.move(at.x, at.y);
  await app.mouse.down();
  await app.mouse.up();
  await app.getByPlaceholder("Untitled").fill("Height check");
  await app.keyboard.press("Enter");

  const chip = calendarRegion(app).getByRole("button", { name: "Height check" }).first();
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  if (!box) throw new Error("chip missing");
  // 19 is ALL_DAY_BAR_HEIGHT, which the row pitch derives from. Asserted in a real browser: a Tailwind
  // class declared where it isn't scanned generates no rule, so the chip collapses to its text height.
  expect(box.height).toBe(19);
});

appTest("drag bottom edge of a timed block resizes without moving it", async ({ app }) => {
  await quickAdd(app, "Standup today 10am");
  await openCalendarMode(app);

  const block = app.locator("[data-cal-page-id]").filter({ hasText: "Standup" }).first();
  await expect(block).toBeVisible();
  // The grid opens scrolled to an hour before now, so a fixed 10am block sits above the viewport for most
  // of the day and the press lands at a negative y; toBeVisible() doesn't catch that.
  await block.scrollIntoViewIfNeeded();
  const before = await block.boundingBox();
  if (!before) throw new Error("block missing");

  await app.mouse.move(before.x + before.width / 2, before.y + before.height - 2);
  await app.mouse.down();
  await app.mouse.move(before.x + before.width / 2, before.y + before.height + 60, { steps: 10 });
  await app.mouse.up();

  const after = await block.boundingBox();
  if (!after) throw new Error("block missing after resize");
  // Grew downward and kept its start: a handle press that also armed the
  // block's move drag would slide the top edge instead.
  expect(after.height).toBeGreaterThan(before.height);
  expect(Math.abs(after.y - before.y)).toBeLessThan(4);
});

appTest(
  "click Ends preset inside date picker extends single-day to multi-day",
  { tag: ["@SCHED-04"] },
  async ({ app }) => {
    await openCalendarMode(app);
    const calendar = app.getByRole("region", { name: "Week calendar" });

    const cols = app.locator('[aria-label^="All-day events,"]');
    const colCount = await cols.count();
    // Asserted, not skipped: a skip would pass having proved nothing.
    expect(colCount).toBeGreaterThanOrEqual(3);
    const startCol = cols.nth(colCount - 3);
    await startCol.click();

    const titleInput = app.getByPlaceholder("Untitled");
    await expect(titleInput).toBeFocused();
    await titleInput.fill("Workshop");
    await app.keyboard.press("Enter");

    const chips = calendar.getByRole("button", { name: "Workshop" });
    await expect(chips).toHaveCount(1);
    const initialBox = await chips.first().boundingBox();
    if (!initialBox) throw new Error("chip missing");

    await chips.first().click();

    const dateTrigger = app.getByRole("button", { name: /^Scheduled: / });
    await dateTrigger.click();

    const ends3d = app.getByRole("button", { name: "Ends in 3d" });
    await expect(ends3d).toBeVisible();
    await ends3d.click();

    await expect(chips).toHaveCount(1);
    const extendedBox = await chips.first().boundingBox();
    if (!extendedBox) throw new Error("chip missing after extend");
    expect(extendedBox.width).toBeGreaterThan(initialBox.width * 2);
  }
);

appTest("dragging a multi-day chip preserves its duration", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = app.getByRole("region", { name: "Week calendar" });

  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  if (colCount < 4) return;
  const seedStartCol = cols.nth(colCount - 2);
  const seedEndCol = cols.nth(colCount - 1);
  const seedStartAt = await centerOf(seedStartCol);
  const seedEndAt = await centerOf(seedEndCol);

  await app.mouse.move(seedStartAt.x, seedStartAt.y);
  await app.mouse.down();
  await app.mouse.move(seedEndAt.x, seedEndAt.y, { steps: 8 });
  await app.mouse.up();
  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Trip");
  await app.keyboard.press("Enter");

  const chips = calendar.getByRole("button", { name: "Trip" });
  await expect(chips).toHaveCount(1);
  const initialBox = await chips.first().boundingBox();
  if (!initialBox) throw new Error("chip missing");

  // The drop must preserve the 2-day span, not collapse it to a single day.
  const dropCol = cols.nth(colCount - 4);
  const fromAt = await centerOf(chips.first());
  const toAt = await centerOf(dropCol);

  await app.mouse.move(fromAt.x, fromAt.y);
  await app.mouse.down();
  // Keep Y inside the all-day zone so the drop is the all-day reschedule, not timed.
  await app.mouse.move(fromAt.x - 20, fromAt.y, { steps: 4 });
  await app.mouse.move(toAt.x, toAt.y, { steps: 8 });
  await app.mouse.up();

  // Width preserved; a bare `onReschedule(start, undefined)` would shrink the bar.
  await expect(chips).toHaveCount(1);
  const movedBox = await chips.first().boundingBox();
  if (!movedBox) throw new Error("chip missing after drag");
  expect(Math.abs(movedBox.width - initialBox.width)).toBeLessThan(2);
});

appTest("multi-week event continues into the next week with checkbox + title", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = app.getByRole("region", { name: "Week calendar" });

  const lastCol = lastAllDayColumn(app);
  await lastCol.click();
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Conference");
  await app.keyboard.press("Enter");

  const chips = calendar.getByRole("button", { name: "Conference" });
  await expect(chips).toHaveCount(1);

  await chips.first().click();
  await app.getByRole("button", { name: /^Scheduled: / }).click();
  await app.getByRole("button", { name: "Ends in 3d" }).click();
  // Dismiss the date picker and popover so they don't trap focus during navigation.
  await app.keyboard.press("Escape");
  await app.keyboard.press("Escape");

  // Scope to the aria-label icon button: two buttons share the name "Next week".
  await app.locator('button[aria-label="Next week"]').click();

  // The visual-start chip re-renders the title although the event started before the view (TickTick-style boundary).
  const continuationChips = calendar.getByRole("button", { name: "Conference" });
  await expect(continuationChips.first()).toBeVisible();
  await expect(continuationChips.first()).toContainText("Conference");
});

appTest("collapsed top/bottom bands render labelled chevrons by default", async ({ app }) => {
  await openCalendarMode(app);

  await expect(app.getByRole("button", { name: "Expand 12 AM to 6 AM" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Expand 10 PM to 12 AM" })).toBeVisible();
});

appTest("clicking a band expands it; clicking the chevron collapses again", async ({ app }) => {
  await openCalendarMode(app);

  const topBand = app.getByRole("button", { name: "Expand 12 AM to 6 AM" });
  await topBand.click();
  await expect(topBand).not.toBeVisible();
  await expect(app.getByRole("button", { name: "Collapse 12 AM to 6 AM" })).toBeVisible();
  await expect(app.getByRole("separator", { name: "Adjust top collapse boundary" })).toBeVisible();

  await app.getByRole("button", { name: "Collapse 12 AM to 6 AM" }).click();
  await expect(app.getByRole("button", { name: "Expand 12 AM to 6 AM" })).toBeVisible();
});

appTest("collapse state persists across reload", async ({ app }) => {
  await openCalendarMode(app);

  await app.getByRole("button", { name: "Expand 10 PM to 12 AM" }).click();
  await expect(app.getByRole("button", { name: "Collapse 10 PM to 12 AM" })).toBeVisible();

  await app.reload();
  // Re-wait for workspace mount after reload: interactions while the shell boots can be dropped.
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
  await openCalendarMode(app);

  await expect(app.getByRole("button", { name: "Collapse 10 PM to 12 AM" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Expand 10 PM to 12 AM" })).not.toBeVisible();
});

appTest("clicking a day-column's band overlay also expands the band", async ({ app }) => {
  await openCalendarMode(app);

  // Each day column renders its own band-overlay button, all sharing an aria-label, so target the first.
  const columnBand = app.getByRole("button", { name: "Expand collapsed early-morning hours" });
  await expect(columnBand.first()).toBeVisible();
  await columnBand.first().click();

  // Expansion is global: every column's overlay button is gone and the gutter exposes the collapse target.
  await expect(app.getByRole("button", { name: "Expand 12 AM to 6 AM" })).not.toBeVisible();
  await expect(columnBand).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Collapse 12 AM to 6 AM" })).toBeVisible();
});

appTest("dragging the top-boundary handle moves the band's hour", async ({ app }) => {
  await openCalendarMode(app);

  await app.getByRole("button", { name: "Expand 12 AM to 6 AM" }).click();
  const handle = app.getByRole("separator", { name: "Adjust top collapse boundary" });
  await expect(handle).toBeVisible();

  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("boundary handle missing");

  // Drag far enough that a fit-to-viewport hour height still rounds to at least one whole hour.
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await app.mouse.move(startX, startY);
  await app.mouse.down();
  await app.mouse.move(startX, startY + 240, { steps: 8 });
  await app.mouse.up();

  // Anything strictly past 6 AM passes; pixel ratio depends on density.
  await expect(app.getByRole("button", { name: "Collapse 12 AM to 6 AM" })).not.toBeVisible();
  await expect(app.getByRole("button", { name: /^Collapse 12 AM to (?!6 AM)\d/ })).toBeVisible();
});

// Timed-grid mousedown wiring and scheduleOnce(start, end) need their own coverage: regressions fall
// through to the all-day branch or shrink the chip.

appTest("create timed event via grid click then drag to a different day", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = calendarRegion(app);

  await app.getByRole("button", { name: "Expand 12 AM to 6 AM" }).click();
  await app.locator('[aria-label="Time grid"]').evaluate((el) => {
    el.scrollTop = 0;
  });

  // One column to the right is needed as the drag target.
  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  if (colCount < 2) return; // narrow layout — skip
  const sourceAllDay = cols.nth(colCount - 2);
  const targetAllDay = cols.nth(colCount - 1);

  const sourceBox = await sourceAllDay.boundingBox();
  const targetBox = await targetAllDay.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("column box missing");

  const sourceClickX = sourceBox.x + sourceBox.width / 2;
  const sourceClickY = sourceBox.y + sourceBox.height + 24; // just below the all-day row, inside the timed grid
  await app.mouse.click(sourceClickX, sourceClickY);

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("standup");
  await app.keyboard.press("Enter");

  const chips = calendar.getByRole("button", { name: "standup" });
  await expect(chips).toHaveCount(1);
  const chipBeforeBox = await chips.first().boundingBox();
  if (!chipBeforeBox) throw new Error("chip missing after create");

  // Cross the dnd-kit activation distance before moving onto the target.
  const fromX = chipBeforeBox.x + chipBeforeBox.width / 2;
  const fromY = chipBeforeBox.y + chipBeforeBox.height / 2;
  const toX = targetBox.x + targetBox.width / 2;

  await app.mouse.move(fromX, fromY);
  await app.mouse.down();
  await app.mouse.move(fromX + 16, fromY, { steps: 4 });
  await app.mouse.move(toX, fromY, { steps: 10 });
  await app.mouse.up();

  await expect(chips).toHaveCount(1);
  const chipAfterBox = await chips.first().boundingBox();
  if (!chipAfterBox) throw new Error("chip missing after drag");
  expect(chipAfterBox.x).toBeGreaterThan(chipBeforeBox.x);
});

appTest("events in a collapsed band render as a clickable +N more pill", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = calendarRegion(app);

  await app.getByRole("button", { name: "Expand 12 AM to 6 AM" }).click();

  // Scroll to the top so a click near it lands at midnight, not at the smart-start position.
  await app.locator('[aria-label="Time grid"]').evaluate((el) => {
    el.scrollTop = 0;
  });

  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  const targetAllDay = cols.nth(colCount - 1);
  const allDayBox = await targetAllDay.boundingBox();
  if (!allDayBox) throw new Error("all-day column missing");
  const timedX = allDayBox.x + allDayBox.width / 2;
  const timedY = allDayBox.y + allDayBox.height + 12;
  await app.mouse.click(timedX, timedY);

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Early bird");
  await app.keyboard.press("Enter");
  await expect(calendar.getByText("Early bird").first()).toBeVisible();

  // The event now sits inside the collapsed band, so it becomes a +N more pill.
  await app.getByRole("button", { name: "Collapse 12 AM to 6 AM" }).click();
  const pill = calendar.getByRole("button", { name: /\d+ more events?/ });
  await expect(pill.first()).toBeVisible();

  await pill.first().click();
  await expect(app.getByRole("button", { name: /Early bird/ }).first()).toBeVisible();
});

appTest("Jump to current week button returns to today's week", async ({ app }) => {
  await openCalendarMode(app);
  const heading = app.getByRole("heading", { name: "Visible week" });
  const initialLabel = await heading.textContent();

  const todayBtn = app.getByRole("button", { name: "Jump to current week" });
  await expect(todayBtn).toBeDisabled();

  const nextWeek = app.locator('button[aria-label="Next week"]');
  await nextWeek.click();
  await nextWeek.click();
  const movedLabel = await heading.textContent();
  expect(movedLabel).not.toBe(initialLabel);
  await expect(todayBtn).toBeEnabled();

  await todayBtn.click();
  await expect(heading).toHaveText(initialLabel ?? "");
  await expect(todayBtn).toBeDisabled();
});

/** Restoring a page must not look like making one. Deleting from inside the auto-open popover
 *  unmounts the block before it clears its claim on the page id, so a restore would match again and
 *  reopen the naming popover. */
appTest("a page restored from the trash opens no popover", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Restored not created");
  await app.keyboard.press("Enter");
  await expect(titleInput).not.toBeVisible();

  // Delete from the block's own popover, which is the path that strands the claim.
  await calendarRegion(app).getByText("Restored not created").click();
  await app.getByRole("button", { name: "Delete" }).click();
  await expect(calendarRegion(app).getByText("Restored not created")).not.toBeVisible();

  // Let the undo toast lapse before restoring. While it is up the page is held in
  // the hidden set, so a restore would be invisible for reasons of its own.
  const toast = app.getByRole("alert", { name: /Restored not created/ });
  await expect(toast).toBeVisible();
  await expect(toast).not.toBeVisible({ timeout: 15_000 });

  await app.getByRole("button", { exact: true, name: "Trash" }).click();
  await app.getByRole("button", { name: "Restore Restored not created" }).click();

  await openCalendarMode(app);
  await expect(calendarRegion(app).getByText("Restored not created")).toBeVisible();
  await expect(app.getByPlaceholder("Untitled")).not.toBeVisible();
});

appTest("a block's open popover goes when a double-click opens its page", async ({ app }) => {
  await quickAdd(app, "Review today 3pm");
  await openCalendarMode(app);
  const block = calendarRegion(app).getByRole("button", { name: /^Review/ });
  await block.click();
  await expect(app.getByRole("dialog")).toBeVisible();

  await block.dblclick();

  await expect(app.locator(".ProseMirror")).toBeVisible();
  await expect(app.getByRole("dialog")).toHaveCount(0);
});

appTest("delete in a block's popover opened from another's deletes the open one", async ({ app }) => {
  await quickAdd(app, "Review today 2pm");
  await quickAdd(app, "Retro today 4pm");
  await openCalendarMode(app);
  const calendar = calendarRegion(app);

  await calendar.getByRole("button", { name: /^Review/ }).click();
  await expect(app.getByRole("dialog")).toBeVisible();
  await calendar.getByRole("button", { name: /^Retro/ }).click({ button: "right" });
  await app.keyboard.press(mod("Mod+Shift+Backspace"));

  await expect(calendar.getByRole("button", { name: /^Retro/ })).toHaveCount(0);
  await expect(calendar.getByRole("button", { name: /^Review/ })).toBeVisible();
});

appTest("the current-time line moves as time passes @mock-only", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-08T10:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
  await openCalendarMode(page);

  const line = page.getByRole("separator", { name: "Current time" });
  const before = (await line.boundingBox())!.y;
  await page.clock.runFor(60 * 60_000);
  await expect.poll(async () => (await line.boundingBox())!.y).toBeGreaterThan(before);
});

appTest(
  "right-clicking a block opens its popover at once",
  { tag: ["@CAL-20"] },
  async ({ app }) => {
    await quickAdd(app, "Review today 2pm");
    await quickAdd(app, "Offsite today");
    await quickAdd(app, "Standup every day at 10am");
    await openCalendarMode(app);
    const calendar = calendarRegion(app);
    const popover = app.getByRole("dialog");

    for (const title of ["Review", "Offsite"]) {
      await appTest.step(`a ${title === "Review" ? "timed" : "all-day"} block`, async () => {
        await calendar.getByRole("button", { name: title }).first().click({ button: "right" });
        await expect(popover).toBeVisible();
        await app.keyboard.press("Escape");
        await expect(popover).not.toBeVisible();
      });
    }

    await appTest.step("a later occurrence of a repeating page", async () => {
      await app.locator('button[aria-label="Next week"]').click();
      await calendar.getByRole("button", { name: "Standup" }).first().click({ button: "right" });
      await expect(popover).toBeVisible();
    });
  }
);

appTest("Escape in the editor unfocuses it first", { tag: ["@CAL-21:2"] }, async ({ app }) => {
  await quickAdd(app, "Review today 2pm");
  await quickAdd(app, "Loose notes");
  const calendar = calendarRegion(app);
  const editor = app.getByRole("textbox", { name: "Page content" });
  const row = (title: string) => app.locator("[data-page-list-item]").filter({ hasText: title });

  await appTest.step("from a page opened in the list, once a selection is cleared", async () => {
    await row("Loose notes").click();
    await editor.click();
    await app.keyboard.type("agenda");
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.press("Escape");
    await expect(editor).toBeFocused();
    await app.keyboard.press("Escape");
    await expect(editor).not.toBeFocused();
    await expect(editor).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(calendar).toBeVisible();
    await expect(editor).not.toBeVisible();
  });

  await appTest.step("from a page the calendar opened", async () => {
    await calendar.getByRole("button", { name: "Review" }).first().dblclick();
    await expect(editor).toBeVisible();
    await editor.click();
    await app.keyboard.press("Escape");
    await expect(editor).not.toBeFocused();
    await app.keyboard.press("Escape");
    await expect(calendar).toBeVisible();
  });

  await appTest.step("a multi-selection is cleared first, in the view it was made", async () => {
    // Leaving for the trash remounts the list, so its Escape registers after the editor's.
    await app.getByRole("button", { name: "Trash" }).click();
    await app.getByRole("button", { name: /^Inbox/ }).click();
    await row("Loose notes").click();
    await expect(editor).toBeVisible();
    await row("Loose notes").click({ modifiers: ["ControlOrMeta"] });
    await row("Review").click({ modifiers: ["ControlOrMeta"] });
    await expect(row("Review")).toHaveAttribute("data-selected", "true");
    await app.keyboard.press("Escape");
    await expect(row("Review")).not.toHaveAttribute("data-selected", "true");
    await expect(editor).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(calendar).toBeVisible();
  });
});

appTest(
  "after Escape unfocuses the editor, Space completes the open page and the arrows move",
  { tag: ["@CAL-21:2"] },
  async ({ app }) => {
    await createFolder(app, "Errands");
    await quickAdd(app, "Buy stamps");
    await quickAdd(app, "Post parcel");
    await quickAdd(app, "Fetch keys");
    const editor = app.getByRole("textbox", { name: "Page content" });
    const rows = app.locator("[data-page-list-item]");

    async function escapeFromTopPage() {
      await rows.first().click();
      await editor.click();
      await app.keyboard.press("Escape");
      await expect(editor).not.toBeFocused();
    }

    await appTest.step("Space completes the open page", async () => {
      await escapeFromTopPage();
      await app.keyboard.press("Space");
      await expect(rows).toHaveCount(2);
      await expect(editor).toBeVisible();
    });

    await appTest.step("the arrows move to the next page", async () => {
      await escapeFromTopPage();
      await app.keyboard.press("ArrowDown");
      await expect(rows.nth(1)).toHaveAttribute("data-active", "true");
    });
  }
);
