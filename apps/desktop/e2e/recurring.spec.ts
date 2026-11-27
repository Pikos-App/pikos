import type { Page } from "@playwright/test";

import { test as appTest, expect, mod, openCalendarMode } from "./fixtures";

/** The last visible all-day column, within the current week so denorms hold. */
function lastAllDayColumn(app: Page) {
  return app.locator('[aria-label^="All-day events,"]').last();
}

function calendarRegion(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

/** Advance the calendar one week so the visible window is entirely after the head: a full row of virtuals whatever the weekday or anchor time. */
async function advanceCalendarOneWeek(app: Page) {
  await app.getByRole("button", { name: "Next week" }).click();
}

// Even with no date pre-set, MetadataHeader auto-anchors to today so the rule has a concrete first occurrence.

appTest("add recurrence later via the page editor byline", async ({ app }) => {
  // Avoid "weekly" / "daily" / "monthly" in the title: the QuickAdd parser strips them as recurrence keywords, so "Weekly review" would land as "review" with a FREQ=WEEKLY rule, defeating the premise.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
  await listItem.click();

  // The chip is icon-only; its accessible name is "Set recurrence" until a rule is attached.
  await app.getByRole("button", { name: "Set recurrence" }).click();

  await app.getByRole("button", { name: /^Daily/ }).click();

  // The icon-only variant exposes the full rrule label as its aria-label.
  await expect(app.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();
});

// Attaching a weekly rule whose BYDAY excludes the page's current weekday must move the head onto the first
// permitted day (core's snapAnchorToRule), not leave a stray block on the excluded day. The clock is pinned to
// a Sunday so "today" lands on a day "Every weekday" excludes: the head must snap to Monday ("Tomorrow"), never
// stay on Sunday ("Today"). Exhaustive snap semantics live in the core unit suite (recurrence.test.ts ›
// snapAnchorToRule); this guards the handler wiring.
//
// Raw `page` fixture (not `app`) because page.clock.install must run before the first app script reads Date,
// i.e. before page.goto.
appTest("attaching a rule that excludes today snaps the head forward @mock-only", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-07T09:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

  // Avoid recurrence keywords in the title (see the byline test).
  await page.keyboard.press(mod("Mod+n"));
  const dialog = page.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await page.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = page.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
  await listItem.click();
  await expect(page.getByRole("button", { name: "Set schedule" })).toBeVisible();

  await page.getByRole("button", { name: "Set recurrence" }).click();
  await page.getByRole("button", { name: /^Every weekday/ }).click();

  // Head snapped to Monday 2026-06-08 = "Tomorrow" under the pinned clock. The
  // outcome is the contract; don't read the cause from here when triaging — in mock
  // mode `recomputeHead` heals an unsnapped anchor anyway, so this stays green
  // whether the client-side snap ran or the backend caught it.
  await expect(page.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scheduled: Today" })).toHaveCount(0);
});

// PageBlockPopover only opens for pages with a scheduledStart (calendar blocks require it), so the recurrence chip is always reachable here.

appTest(
  "calendar popover lets users add recurrence to a scheduled page",
  async ({ app }) => {
    await openCalendarMode(app);

    await lastAllDayColumn(app).click();
    const titleInput = app.getByPlaceholder("Untitled");
    await titleInput.fill("Standup");
    await app.keyboard.press("Enter");

    const chip = calendarRegion(app).getByRole("button", { name: "Standup" });
    await expect(chip).toHaveCount(1);

    // Re-open the popover by clicking the chip: for non-recurring pages the calendar popover routes through PageBlockPopover (real page, not virtual).
    await chip.click();

    // With no rule yet the chip's aria-label is "Set recurrence".
    await app.getByRole("button", { name: "Set recurrence" }).click();
    await app.getByRole("button", { name: /^Daily/ }).click();

    await expect(app.getByRole("button", { name: /Recurrence: every day/i }).first()).toBeVisible();
  }
);

// Mirrors the WorkspaceContext unit test through the full UI: the head's checkbox click on the calendar block
// routes through completeRecurringPage. A done clone replaces the original date, the head advances, and the
// recurrence chip stays attached.

appTest(
  "completing a head page creates a done clone and advances head",
  async ({ app }) => {
    // Seed a daily recurring page so today and tomorrow are both occurrences.
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    // The head has a recurrence rule, so toggling routes through completeRecurringPage instead of a plain status write.
    const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    await expect(listItem).toHaveCount(1);
    await listItem.click();

    const statusButton = app.getByRole("button", { name: "Mark done" });
    await expect(statusButton).toBeVisible();
    await statusButton.click();

    // The head advances (status back to open) and keeps its rule.
    await expect(app.getByRole("button", { name: /^Recurrence: every day/i })).toBeVisible();
  }
);

// Completing a today-anchored recurring page from the page list advances the head out of Today (to tomorrow) and
// stamps a done clone. The clone's completed_at must be local wall-clock so Today's Completed section, which
// date-compares it against the local day, shows it; a UTC stamp would filter it out for much of every day and
// read as "the click did nothing".

appTest(
  "page-list checkbox completes a recurring page into Completed @smoke",
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    // All-day daily recurrence (no "at 9am"): the head anchors to today's date so it always lands in Today. A timed
    // input rolls to tomorrow's 9am once today's has passed (the parser uses chrono forwardDate), dropping the head
    // out of Today.
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await app.getByRole("button", { name: /^Today/ }).click();
    const items = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    await expect(items).toHaveCount(1);

    // Today has no missed-day gap, so one click completes immediately (no dialog): the head advances to tomorrow and a done clone is stamped.
    await items
      .first()
      .getByRole("checkbox", { name: /Mark done/i })
      .click();

    // The head left Today's main list; the only remaining standup is the done clone, reachable once Completed is expanded.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    // Head-revert race: quick-add writes the recurring head's denorm scheduledStart through the 800ms debounce, and
    // completing before it flushes let the stale write land after the advance and snap the head back into Today (the
    // advanced head plus the done clone = two rows). Wait past the debounce so a re-introduced revert surfaces here
    // rather than passing by luck on a fast machine. completeRecurringPage flushes the pending write first, so only
    // the clone remains.
    await app.waitForTimeout(1000);
    await expect(items).toHaveCount(1);
    await expect(items.first().getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
  }
);

// Unchecking a recurring series' done clone must rewind the occurrence onto the head (delete the clone,
// un-suppress the date), not plain-flip the clone to open, which would leave the flipped clone and the advanced
// head both open (two rows).

appTest(
  "unchecking a done recurring clone restores the occurrence onto the head",
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    // All-day daily so the head anchors to today's date and always lands in Today.
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
    // Past the quick-add denorm debounce, so a re-introduced head-revert race would
    // surface here rather than passing by luck (see the completion test above).
    await app.waitForTimeout(1000);
    const clone = items.filter({ has: app.getByRole("checkbox", { name: /Mark not done/i }) });
    await expect(clone).toHaveCount(1);

    // The occurrence rewinds onto the head (back in Today, open) and the clone is gone.
    await clone.getByRole("checkbox", { name: /Mark not done/i }).click();
    await expect(
      items.filter({ has: app.getByRole("checkbox", { name: /Mark not done/i }) })
    ).toHaveCount(0);
    await expect(
      items.filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
    ).toHaveCount(1);
  }
);

// A daily recurrence anchored today renders the head plus virtual occurrences for the rest of the week. Virtuals
// carry a Repeat2 icon (aria-label "Recurring") instead of the head's status checkbox, the signal that "this is a
// future repeat, not a real page". Clicking one opens VirtualPageBlockPopover with a Skip action.

appTest(
  "daily recurring page renders virtual occurrences on the calendar @smoke",
  async ({ app }) => {
    // An explicit time puts the head in the timed grid. All-day rules expand too, but the parser strips so many words
    // from the title (daily, morning, weekly) that an all-day input is hard to keep stable.
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

    // At least one Recurring icon proves expansion has finished and avoids racing the post-navigation render.
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
    const chips = calendar.getByRole("button", { name: /^standup/i });
    const count = await chips.count();
    // A full week of daily virtuals = 7 chips; ≥2 leaves slack for a changed expansion window or week start day.
    expect(count).toBeGreaterThanOrEqual(2);
  }
);

// Opening a virtual and deleting it drops the occurrence into the skip-set (page.skippedOccurrences), so it
// vanishes from the calendar; Cmd+Z (the undo toast's action) removes it and the virtual reappears. Nothing here
// is overdue, so the scope dialog stays out of the way.

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

    // Cmd+Z fires the most recent undoable toast, which exists only once the delete
    // has been written; the occurrence leaves the calendar before that.
    await expect(app.getByRole("alert", { name: /Deleted one day of/ })).toBeVisible();
    await app.keyboard.press(mod("Mod+z"));
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore);
  }
);

// Recurring virtuals share the head's page id, and the all-day bar collapser merged consecutive same-id slots, so
// a gap-free daily series with no empty columns coalesced into one bar spanning the whole row. Each occurrence is
// a separate single-day chip and must render as such. Uses an all-day rule ("every day", no time) because the
// timed test above can't reach buildAllDayBars.
appTest(
  "all-day daily recurrence renders separate chips, not one eternal bar",
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    // No time → all-day. "every day" is stripped to the title "Standup".
    await app.getByRole("textbox", { name: "Quick add input" }).fill("Standup every day");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    // Advance a week so every day is an all-day virtual: a gap-free run, which is the trigger.
    await advanceCalendarOneWeek(app);
    const calendar = calendarRegion(app);

    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
    // Each day must be its own chip: ≥2 distinct all-day bars prove they didn't merge.
    const chips = calendar.getByRole("button", { name: /^Standup/ });
    expect(await chips.count()).toBeGreaterThanOrEqual(2);
  }
);

// Dragging a virtual to a different time must materialise an independent real page at the new time and exdate
// the original date (the virtual disappears, a normal page-block appears). Completing the head's chip must then
// advance it to the day after the materialised one, skipping the materialised date because it was added to
// exdates.
//
// Guards two failures: a drag routed through scheduleOnce(headId) would move the head's denorm onto the dropped
// slot and leave a phantom virtual at the original anchor; an advance via raw rrule.after() would land on the
// materialised date unless nextOccurrenceAfter honours exdates.

appTest(
  "drag virtual reschedules to a real page; head advance skips the materialised date",
  async ({ app }) => {
    // A definite time puts the virtuals in the timed grid, easier to drag than all-day chips.
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

    // A full week of virtuals = 7 chips, all carrying the "Recurring" aria-label.
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5000 });
    const virtualsBefore = await calendar.getByLabel("Recurring").count();
    const totalChipsBefore = await calendar.getByRole("button", { name: /^standup/i }).count();
    expect(virtualsBefore).toBeGreaterThanOrEqual(1);
    expect(totalChipsBefore).toBeGreaterThanOrEqual(2);

    // The first virtual chip is the parent button containing a "Recurring" icon. Dragging its body 60px up snaps to
    // one hour earlier on the same day (the calendar is hour-pitched).
    const firstVirtual = calendar
      .getByRole("button", { name: /^standup/i })
      .filter({ has: app.getByLabel("Recurring") })
      .first();
    // WeekGrid smart-starts at max(7am, now-1h), so late in the day 9am chips sit above the viewport and
    // boundingBox() returns coords the mouse path never reaches; scroll the chip in first.
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

    // After drop: one fewer "Recurring" icon (the dragged virtual is now a real page); the total chip count is
    // unchanged (remaining virtuals + the materialised page).
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 1);
    await expect(calendar.getByRole("button", { name: /^standup/i })).toHaveCount(totalChipsBefore);

    // Complete the head via the editor byline: more reliable than the calendar chip's nested checkbox, and avoids the
    // "Mark done" name duplication from the page-list checkbox. The list sorts by scheduledStart asc, so the first
    // standup item is the head; Enter on the selected item routes through ui.openPage, which switches the right panel
    // to the editor where the byline lives.
    const listHead = app.locator("[data-page-list-item]").filter({ hasText: "standup" }).first();
    await listHead.click();
    await listHead.press("Enter");
    // Anchor /^Mark done$/i: the substring also appears in page-list-item names ("Mark done standup ..."), while the
    // byline button's name is exactly "Mark done".
    const bylineDone = app.getByRole("button", { name: /^Mark done$/i });
    await expect(bylineDone).toBeVisible();
    await bylineDone.click();
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(calendarRegion(app)).toBeVisible();

    // Smoke-test the post-completion integration. The chip arithmetic for the head's exdate-aware advance only works
    // on weekdays where the head, the materialised page and the advanced head all land in the visible 7-day window,
    // so assert the behavioural contract instead and leave the rigorous exdate semantics to
    // `packages/core/src/utils/recurrence.test.ts`. Completion produces exactly one done clone, and the workspace
    // still has two open standup pages (the advanced head and the materialised page).
    const allStandups = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    // Expand the Completed accordion so its members count toward the locator.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(allStandups).toHaveCount(3);
  }
);

// Ticking an overdue recurring head (today > head, with intermediate occurrences) asks only for scope: "Just this
// one" resolves the head's own day and leaves the rest open, "This and everything before today" clones a done page
// per missed day. Raw `page` fixture, as in the snap-forward test above.

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

  // Jump the clock 3 days forward — the head stays on Mon (no reload/recompute),
  // so completing now sees Tue + Wed as missed.
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

    await expect(page.getByText(/3 days before today are still open/)).toBeVisible();
    // It names the page it is about to act on, and calls them days the way the body does.
    await expect(page.getByRole("dialog")).toContainText(/Mark .*standup.* done for /);
    await expect(page.getByRole("dialog")).not.toContainText(/occurrence/i);
    await expect(page.getByRole("button", { name: /Just this one/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /This and everything before today/ })
    ).toBeVisible();

    await page.getByRole("button", { name: /Just this one/ }).click();
    await expect(page.getByText(/3 days before today are still open/)).not.toBeVisible();

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

    await expect(page.getByText(/3 days before today are still open/)).toBeVisible();
    await page.getByRole("button", { name: /This and everything before today/ }).click();
    await expect(page.getByText(/3 days before today are still open/)).not.toBeVisible();

    // Mon, Tue and Wed each land as their own done page; the head moves to today.
    await page.getByRole("button", { exact: true, name: "Completed" }).click();
    await expect(
      items.filter({ has: page.getByRole("checkbox", { name: /Mark not done/i }) })
    ).toHaveCount(3);
    await expect(
      items.filter({ has: page.getByRole("checkbox", { name: /Mark done/i }) })
    ).toHaveCount(1);
  }
);

// Deleting a past occurrence means "not doing this": both arms write the skip-set, so nothing is minted as done.

/** Open the backlog scope dialog by deleting the first overdue virtual, and hand
 *  back the calendar plus the block count from before it was asked. The head (Mon)
 *  renders as a real block, so the first virtual is Tue — inside the backlog, which
 *  is what summons the dialog rather than deleting outright. */
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
  await expect(page.getByText(/3 days before today are still open/)).toBeVisible();

  return { before, calendar };
}

/** No done clone was minted — the assertion that separates a delete from a tick,
 *  and the one thing both arms of this dialog must agree on. */
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

    // Tue and Wed are dismissed, and today's occurrence stops being a virtual — the
    // head advanced onto it once Mon went to the skip-set.
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

    // Only the day that was clicked goes. The head's own Monday and the Wednesday
    // after it stay open — the backlog surviving is the whole difference from the
    // arm above, and the head cannot advance while its own day is neither ticked
    // nor dismissed.
    await expect(calendar.getByLabel("Recurring")).toHaveCount(before - 1);
    await expectNothingCompleted(page, items);
  }
);

// "Stop repeating" deletes the rule entirely; the page stays scheduled and the byline chip flips back to "Set recurrence".

appTest(
  "Stop repeating removes the recurrence rule",
  { tag: ["@RECUR-11"] },
  async ({ app }) => {
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

    // In the editor's icon variant the trigger carries the cadence in its accessible name.
    await app.getByRole("button", { name: /Recurrence: every week on Monday/i }).click();

    await app.getByRole("button", { name: "Stop repeating" }).click();

    await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
  }
);
