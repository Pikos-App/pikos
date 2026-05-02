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

/** Bars are rendered in a sibling overlay — not inside the column's DOM —
 * so assertions scope to the calendar region instead of the column. */
function calendarRegion(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
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
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Release planning");
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  await expect(calendarRegion(app).getByText("Release planning")).toBeVisible();
});

appTest("Enter on empty title saves page as Untitled @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Enter");

  await expect(titleInput).not.toBeVisible();
  // A bar remains (title persisted as "Untitled") — wait past the deferred
  // delete check to ensure it's not removed.
  await app.waitForTimeout(100);
  await expect(
    calendarRegion(app).getByRole("button", { name: "Untitled" })
  ).toBeVisible();
});

// ─── Escape discards untitled, keeps titled ─────────────────────────────────

appTest("Escape on empty title deletes the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  // Deferred delete (setTimeout 0) — give it time to run.
  await app.waitForTimeout(100);
  await expect(
    calendarRegion(app).getByRole("button", { name: "Untitled" })
  ).toHaveCount(0);
});

appTest("Escape with typed title keeps the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Keep me");
  await app.keyboard.press("Escape");

  await expect(titleInput).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(calendarRegion(app).getByText("Keep me")).toBeVisible();
});

// ─── Outside click ──────────────────────────────────────────────────────────

appTest("outside click on empty popover deletes the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();
  await expect(app.getByPlaceholder("Untitled")).toBeFocused();

  // Click outside the popover — on the week calendar header area.
  await calendarRegion(app).click({ position: { x: 5, y: 5 } });

  await expect(app.getByPlaceholder("Untitled")).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(
    calendarRegion(app).getByRole("button", { name: "Untitled" })
  ).toHaveCount(0);
});

appTest("outside click with typed title keeps the page @tier2", async ({ app }) => {
  await openCalendarMode(app);
  await lastAllDayColumn(app).click();

  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Save on blur");
  // Click outside the popover.
  await calendarRegion(app).click({ position: { x: 5, y: 5 } });

  await expect(titleInput).not.toBeVisible();
  await app.waitForTimeout(100);
  await expect(calendarRegion(app).getByText("Save on blur")).toBeVisible();
});

// ─── Multi-day all-day events ──────────────────────────────────────────────

/** Centre coordinates of a locator's bounding box. */
async function centerOf(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible element with a bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

appTest("drag across all-day columns creates a multi-day span @tier2", async ({ app }) => {
  await openCalendarMode(app);

  // Pick two adjacent columns — both in visible range. Use the last two so the
  // span starts today-or-later (past-only spans exercise different denorm paths).
  const cols = app.locator('[aria-label^="All-day events,"]');
  const colCount = await cols.count();
  const startCol = cols.nth(colCount - 2);
  const endCol = cols.nth(colCount - 1);

  const startAt = await centerOf(startCol);
  const endAt = await centerOf(endCol);

  // Drag across the two columns. Intermediate mousemoves ensure the handler
  // receives incremental idx updates instead of a single jump.
  await app.mouse.move(startAt.x, startAt.y);
  await app.mouse.down();
  const midX = (startAt.x + endAt.x) / 2;
  await app.mouse.move(midX, endAt.y, { steps: 5 });
  await app.mouse.move(endAt.x, endAt.y, { steps: 5 });
  await app.mouse.up();

  // The metadata popover auto-opens on the first-day chip only. Type a title
  // so the page persists past handleAutoOpenConsumed's empty-title check.
  const titleInput = app.getByPlaceholder("Untitled");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Offsite");
  await app.keyboard.press("Enter");

  // The event renders as a single bar spanning both columns. Scope to the
  // calendar region — the sidebar page list also shows an "Offsite" entry.
  const calendarChips = app
    .getByRole("region", { name: "Week calendar" })
    .getByRole("button", { name: "Offsite" });
  await expect(calendarChips).toHaveCount(1);
});

appTest("drag right edge of multi-day chip extends the span @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = app.getByRole("region", { name: "Week calendar" });

  // Seed: create a 2-day span across the last two columns.
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

  // The single bar carries its right-edge resize handle at the right of the
  // whole span. Grab it and drag to the last visible column.
  const chipBox = await chips.first().boundingBox();
  if (!chipBox) throw new Error("chip missing");
  const endAt = await centerOf(endCol);

  const edgeX = chipBox.x + chipBox.width - 2;
  const edgeY = chipBox.y + chipBox.height / 2;
  await app.mouse.move(edgeX, edgeY);
  await app.mouse.down();
  await app.mouse.move(endAt.x, endAt.y, { steps: 10 });
  await app.mouse.up();

  // Still one bar — but now its bounding box covers 3 columns instead of 2.
  await expect(chips).toHaveCount(1);
  const extendedBox = await chips.first().boundingBox();
  if (!extendedBox) throw new Error("chip missing after resize");
  expect(extendedBox.width).toBeGreaterThan(chipBox.width);
});

appTest(
  "click Ends preset inside date picker extends single-day to multi-day @tier2",
  async ({ app }) => {
    await openCalendarMode(app);
    const calendar = app.getByRole("region", { name: "Week calendar" });

    // Anchor on the THIRD-to-last column so a 3-day span still fits in view.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const colCount = await cols.count();
    if (colCount < 3) return;
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

    // Re-open the popover by clicking the chip.
    await chips.first().click();

    // Click the date trigger inside the popover to open the DateTimePicker.
    const dateTrigger = app.getByRole("button", { name: /^Scheduled: / });
    await dateTrigger.click();

    // Click the "3d" preset in the Ends section (sets end = start + 2 days).
    const ends3d = app.getByRole("button", { name: "Ends in 3d" });
    await expect(ends3d).toBeVisible();
    await ends3d.click();

    // Still one bar, but its bounding box now spans 3 columns wide.
    await expect(chips).toHaveCount(1);
    const extendedBox = await chips.first().boundingBox();
    if (!extendedBox) throw new Error("chip missing after extend");
    expect(extendedBox.width).toBeGreaterThan(initialBox.width * 2);
  }
);

// ─── Drag preserves multi-day duration ─────────────────────────────────────

appTest("dragging a multi-day chip preserves its duration @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = app.getByRole("region", { name: "Week calendar" });

  // Seed a 2-day span across the last two columns.
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

  // Drag the bar leftward by two columns. The drop should preserve the 2-day
  // span, not collapse it to a single-day event (regression guard for the
  // shiftAllDayEnd logic in handleAllDayChipDragStart).
  const dropCol = cols.nth(colCount - 4);
  const fromAt = await centerOf(chips.first());
  const toAt = await centerOf(dropCol);

  await app.mouse.move(fromAt.x, fromAt.y);
  await app.mouse.down();
  // Past the chip's drag-threshold, then onto the target column. Keep Y inside
  // the all-day zone so the drop branch is the all-day reschedule, not timed.
  await app.mouse.move(fromAt.x - 20, fromAt.y, { steps: 4 });
  await app.mouse.move(toAt.x, toAt.y, { steps: 8 });
  await app.mouse.up();

  // Still one bar with its 2-column width preserved. A bare
  // `onReschedule(start, undefined)` would have shrunk the bar.
  await expect(chips).toHaveCount(1);
  const movedBox = await chips.first().boundingBox();
  if (!movedBox) throw new Error("chip missing after drag");
  expect(Math.abs(movedBox.width - initialBox.width)).toBeLessThan(2);
});

// ─── Cross-week continuation renders the title ──────────────────────────────

appTest(
  "multi-week event continues into the next week with checkbox + title @tier2",
  async ({ app }) => {
    await openCalendarMode(app);
    const calendar = app.getByRole("region", { name: "Week calendar" });

    // Create a single-day chip on the LAST visible column, then extend it via
    // the date picker so the span crosses into next week.
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
    // 3-day preset: start + 2 days. Anchored on the last visible column, the
    // tail two days fall in the following week.
    await app.getByRole("button", { name: "Ends in 3d" }).click();
    // Dismiss the date picker + popover so they don't trap focus during nav.
    await app.keyboard.press("Escape");
    await app.keyboard.press("Escape");

    // Navigate to the next week. Two buttons in the DOM share the accessible
    // name "Next week" (the calendar header icon button and a date-picker nav
    // button); scope to the aria-label-bearing icon button explicitly.
    await app.locator('button[aria-label="Next week"]').click();

    // The continuation chips now occupy the start of this week. The visual-
    // start chip (column 0) should re-render the title even though the event
    // started before the view — that's the TickTick-style boundary behavior.
    const continuationChips = calendar.getByRole("button", { name: "Conference" });
    await expect(continuationChips.first()).toBeVisible();
    await expect(continuationChips.first()).toContainText("Conference");
  }
);

// ─── Collapsible time bands ────────────────────────────────────────────────

appTest("collapsed top/bottom bands render labelled chevrons by default @tier2", async ({ app }) => {
  await openCalendarMode(app);

  // Defaults: top collapsed at 6 AM, bottom collapsed at 10 PM. Each band is
  // a single button labelled "Expand <start> to <end>".
  await expect(app.getByRole("button", { name: "Expand 12 AM to 6 AM" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Expand 10 PM to 12 AM" })).toBeVisible();
});

appTest("clicking a band expands it; clicking the chevron collapses again @tier2", async ({ app }) => {
  await openCalendarMode(app);

  // Click the top band → it expands. The expanded state surfaces a "Collapse"
  // button at the top of the gutter and an "Adjust top collapse boundary"
  // separator near the boundary line.
  const topBand = app.getByRole("button", { name: "Expand 12 AM to 6 AM" });
  await topBand.click();
  await expect(topBand).not.toBeVisible();
  await expect(app.getByRole("button", { name: "Collapse 12 AM to 6 AM" })).toBeVisible();
  await expect(app.getByRole("separator", { name: "Adjust top collapse boundary" })).toBeVisible();

  // Click the collapse chevron to fold the band back.
  await app.getByRole("button", { name: "Collapse 12 AM to 6 AM" }).click();
  await expect(app.getByRole("button", { name: "Expand 12 AM to 6 AM" })).toBeVisible();
});

appTest("collapse state persists across reload @tier2", async ({ app }) => {
  await openCalendarMode(app);

  // Expand the bottom band, then reload — the band should still be expanded.
  await app.getByRole("button", { name: "Expand 10 PM to 12 AM" }).click();
  await expect(app.getByRole("button", { name: "Collapse 10 PM to 12 AM" })).toBeVisible();

  await app.reload();
  await openCalendarMode(app);

  await expect(app.getByRole("button", { name: "Collapse 10 PM to 12 AM" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Expand 10 PM to 12 AM" })).not.toBeVisible();
});

appTest("events in a collapsed band render as a clickable +N more pill @tier2", async ({ app }) => {
  await openCalendarMode(app);
  const calendar = calendarRegion(app);

  // Expand the top band so we can drop a timed event inside [0am, 6am).
  await app.getByRole("button", { name: "Expand 12 AM to 6 AM" }).click();

  // Scroll the timed grid to the very top so a click near the top of the
  // visible grid lands at midnight, not at the smart-start scroll position.
  await app.locator('[aria-label="Time grid"]').evaluate((el) => {
    el.scrollTop = 0;
  });

  // Click ~12 px into the timed grid for the last visible day column. With
  // the top band expanded and scrollTop=0, this lands inside [0, 1) AM.
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

  // Re-collapse the top band. The event now falls inside the collapsed band
  // so it should be replaced by a +N more pill instead of rendering directly.
  await app.getByRole("button", { name: "Collapse 12 AM to 6 AM" }).click();
  const pill = calendar.getByRole("button", { name: /\d+ more events?/ });
  await expect(pill.first()).toBeVisible();

  // Clicking the pill opens a popover listing the hidden events by title.
  await pill.first().click();
  await expect(app.getByRole("button", { name: /Early bird/ }).first()).toBeVisible();
});
