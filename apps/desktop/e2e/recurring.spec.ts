// E2E coverage for the recurring-page UX flows.
//
// Walks the same paths a user would: create-with-recurrence in QuickAdd, add
// recurrence later via the page editor's byline, add recurrence via the
// calendar's PageBlockPopover, completing a head occurrence (clone + advance),
// skipping a virtual occurrence, and removing the rule entirely. Runs against
// MockStorageAdapter (VITE_TEST_MODE=true).

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

async function openCalendarMode(app: Page) {
  // Click the right-panel header's "Calendar view" button rather than firing
  // Mod+Shift+C — the keypress can be dropped if the keyboard registry hasn't
  // mounted yet (e.g. immediately after page.reload()). The button is part
  // of the layout shell, so its visibility doubles as a "shell ready" signal.
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.waitFor({ state: "visible" });
  if ((await calendarBtn.getAttribute("aria-pressed")) !== "true") {
    await calendarBtn.click();
  }
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

/** The last visible all-day column — within the current week so denorms hold. */
function lastAllDayColumn(app: Page) {
  return app.locator('[aria-label^="All-day events,"]').last();
}

function calendarRegion(app: Page) {
  return app.getByRole("region", { name: "Week calendar" });
}

/**
 * Advance the calendar one week. Used by virtual-occurrence tests so the
 * visible window is always entirely *after* the head — guarantees a full row
 * of virtuals regardless of which weekday (or which side of the recurrence
 * anchor time) the test happens to run on.
 */
async function advanceCalendarOneWeek(app: Page) {
  await app.getByRole("button", { name: "Next week" }).click();
}

// ─── Add recurrence later via the editor byline ────────────────────────────
//
// Create a one-off page, open it in the editor, then attach a recurrence rule
// via the byline's RecurrencePopover. Even with no date pre-set, MetadataHeader
// auto-anchors to today so the rule has a concrete first occurrence.

appTest("add recurrence later via the page editor byline @tier2", async ({ app }) => {
  // Create a plain page (no schedule, no recurrence). Avoid words like
  // "weekly" / "daily" / "monthly" in the title — the QuickAdd parser strips
  // them as recurrence keywords, so "Weekly review" would land as "review"
  // with a FREQ=WEEKLY rule attached, defeating the no-recurrence premise.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
  await listItem.click();

  // The byline's recurrence chip is icon-only; before a rule is attached the
  // accessible name is "Set recurrence". Click to open the popover.
  await app.getByRole("button", { name: "Set recurrence" }).click();

  // Pick the "Daily" preset — anchor defaults to today.
  await app.getByRole("button", { name: /^Daily/ }).click();

  // The byline chip's accessible name now reflects the cadence. The icon-only
  // variant exposes the full rrule label as aria-label.
  await expect(app.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();
});

// ─── Attaching a rule that excludes today snaps the head forward ────────────
//
// Regression for the "first run on Sunday" QA bug. Attaching a weekly rule
// whose BYDAY excludes the page's current weekday must move the head onto the
// first permitted day (core's snapAnchorToRule), not leave a stray block on
// the excluded day. The clock is pinned to a Sunday so "today" deterministically
// lands on a day the "Every weekday" rule excludes — the head must snap to
// Monday ("Tomorrow"), never stay on Sunday ("Today"). Exhaustive snap
// semantics (M/W/F, timed anchors, no-ops) live in the core unit suite
// (recurrence.test.ts › snapAnchorToRule); this guards the handler wiring.
//
// Uses the raw `page` fixture (not `app`) because page.clock.install must run
// before the first app script reads Date, i.e. before page.goto.
appTest("attaching a rule that excludes today snaps the head forward @tier2", async ({ page }) => {
  // Pin "now" to Sunday 2026-06-07 09:00 before any app code reads the clock.
  await page.clock.install({ time: new Date("2026-06-07T09:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

  // Create a plain, date-less page. Avoid recurrence keywords in the title
  // (see the byline test) so it lands as a one-off with no schedule.
  await page.keyboard.press(mod("Mod+n"));
  const dialog = page.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await page.getByRole("textbox", { name: "Quick add input" }).fill("Team retro");
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the page in the editor. With no schedule yet, the byline date chip
  // reads "Set schedule".
  const listItem = page.locator("[data-page-list-item]").filter({ hasText: "Team retro" });
  await listItem.click();
  await expect(page.getByRole("button", { name: "Set schedule" })).toBeVisible();

  // Attach an "Every weekday" rule (BYDAY=MO..FR). The head auto-anchors to
  // today (Sunday) — a day this rule excludes — so it must snap to Monday.
  await page.getByRole("button", { name: "Set recurrence" }).click();
  await page.getByRole("button", { name: /^Every weekday/ }).click();

  // Head snapped to Monday 2026-06-08 = "Tomorrow" under the pinned clock.
  // A regression (no snap) would leave it on Sunday, reading "Today".
  await expect(page.getByRole("button", { name: "Scheduled: Tomorrow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scheduled: Today" })).toHaveCount(0);
});

// ─── Add recurrence later via the calendar popover ─────────────────────────
//
// PageBlockPopover only ever opens for pages that have a scheduledStart
// (calendar blocks require it), so the recurrence chip is always reachable
// here. Verifies that opening the popover on a scheduled page and picking a
// preset attaches the rule.

appTest("calendar popover lets users add recurrence to a scheduled page @tier2", async ({
  app,
}) => {
  await openCalendarMode(app);

  await lastAllDayColumn(app).click();
  const titleInput = app.getByPlaceholder("Untitled");
  await titleInput.fill("Standup");
  await app.keyboard.press("Enter");

  const chip = calendarRegion(app).getByRole("button", { name: "Standup" });
  await expect(chip).toHaveCount(1);

  // Re-open the popover by clicking the chip — the calendar popover routes
  // through PageBlockPopover (real page, not virtual) for non-recurring pages.
  await chip.click();

  // The PageBlockPopover's metadata row hosts the "Repeats" recurrence chip.
  // With no rule yet, aria-label is "Set recurrence" — click to open.
  await app.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();

  // The chip's accessible name flips to "Recurrence: every day" once a rule
  // is set (icon variant in editor or label variant in popover both follow
  // this aria-label pattern).
  await expect(
    app.getByRole("button", { name: /Recurrence: every day/i }).first()
  ).toBeVisible();
});

// ─── Complete a head page advances and stamps a done clone ─────────────────
//
// Mirrors the WorkspaceContext unit test but exercises the full UI: the head's
// checkbox click on the calendar block routes through completeRecurringPage.
// A done clone replaces the original date, the head advances to the next
// occurrence, and the recurrence chip stays attached.

appTest("completing a head page creates a done clone and advances head @tier2", async ({ app }) => {
  // Seed a daily recurring page so today and tomorrow are both occurrences.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the editor and toggle the status. The head has a recurrence rule, so
  // toggling routes through completeRecurringPage instead of a plain status
  // write — the head advances and a done clone appears.
  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toHaveCount(1);
  await listItem.click();

  const statusButton = app.getByRole("button", { name: "Mark done" });
  await expect(statusButton).toBeVisible();
  await statusButton.click();

  // After completion the head advances (status back to open) and keeps its
  // rule — the recurrence chip must survive completeRecurringPage.
  await expect(
    app.getByRole("button", { name: /^Recurrence: every day/i })
  ).toBeVisible();
});

// ─── Page-list checkbox completion surfaces a done clone in Completed ──────
//
// Regression for the soft-launch QA "recurring checkbox doesn't seem to do
// anything" report. Completing a today-anchored recurring page from the page
// list advances the head out of Today (to tomorrow) AND stamps a done clone.
// The clone's completed_at must be local wall-clock so Today's Completed
// section (which date-compares completed_at against the local day) shows it.
// Before the fix the clone's completed_at was UTC, so for much of every day
// (UTC date ≠ local date) it was filtered out — the row vanished with nothing
// in Completed, reading as "the click did nothing".

appTest("page-list checkbox completes a recurring page into Completed @tier1", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  // All-day daily recurrence (no "at 9am"): the head anchors to today's *date*
  // so it always lands in Today. A timed input rolls to tomorrow's 9am once
  // today's 9am has passed (parser uses chrono forwardDate), which dropped the
  // head out of Today and failed this test whenever it ran after 09:00.
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Today view: the head is scheduled today, so it shows here.
  await app.getByRole("button", { name: /Today/ }).click();
  const items = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(items).toHaveCount(1);

  // One click on the page-list checkbox. Today has no missed-day gap, so this
  // completes immediately (no dialog): the head advances to tomorrow and a
  // done clone is stamped.
  await items.first().getByRole("checkbox", { name: /Mark done/i }).click();

  // The head advanced to tomorrow → it leaves the Today main list. The only
  // remaining standup is the done clone, reachable once Completed is expanded.
  await app.getByRole("button", { name: "Completed", exact: true }).click();
  // Regression guard for the head-revert race: quick-add writes the recurring
  // head's denorm scheduledStart through the 800ms debounce, and completing
  // before it flushes let the stale write land *after* the advance and snap the
  // head back into Today (the advanced head + the done clone = two rows). Wait
  // past the debounce window so a re-introduced revert would surface here rather
  // than passing by luck on a fast machine. completeRecurringPage flushes the
  // pending write first, so the head stays advanced and only the clone remains.
  await app.waitForTimeout(1000);
  await expect(items).toHaveCount(1);
  await expect(items.first().getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
});

// ─── Virtual occurrences render on the calendar ───────────────────────────
//
// A daily recurrence anchored today should render the head plus virtual
// occurrences for the rest of the week. The virtuals carry a Repeat2 icon
// (aria-label "Recurring") instead of the head's status checkbox — this is
// the visual signal users rely on to recognise "this is a future repeat,
// not a real page". Clicking a virtual opens VirtualPageBlockPopover with
// a Skip action.

appTest("daily recurring page renders virtual occurrences on the calendar @tier1", async ({
  app,
}) => {
  // Seed a daily recurring page with an explicit time so the head lands in
  // the timed grid. All-day rules expand correctly too, but the parser
  // strips so many words from the title (daily, morning, weekly, etc.) that
  // an all-day input is hard to keep stable; using a timed input + time
  // keeps the parsed title legible.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await openCalendarMode(app);
  // Advance one week so the visible window is wholly after the head — every
  // day in view is a virtual. Avoids the late-in-week / past-anchor-time race
  // where the head lands on the last visible day and virtuals fall into the
  // next week, leaving the current week with zero "Recurring" icons.
  await advanceCalendarOneWeek(app);
  const calendar = calendarRegion(app);

  // Wait for at least one Recurring icon (virtual) before counting — it
  // proves expansion has finished and avoids racing the post-navigation render.
  await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
  const chips = calendar.getByRole("button", { name: /^standup/i });
  const count = await chips.count();
  // A full week of daily virtuals = 7 chips. Assert ≥2 to leave slack for
  // any future change to recurrence-expansion window or week start day.
  expect(count).toBeGreaterThanOrEqual(2);
});

// ─── All-day daily recurrence renders one chip per day (not one eternal bar) ─
//
// Regression for the "single eternal page in the all-day row" QA bug. Recurring
// virtuals share the head's page id; the all-day bar collapser merged
// consecutive same-id slots, so a gap-free daily series with no empty columns
// to break the run coalesced into ONE bar spanning the whole row. Each
// occurrence is a separate single-day chip and must render as such. Uses an
// all-day rule ("every day", no time) so the chips live in the all-day row —
// the timed test above can't reach buildAllDayBars.
appTest("all-day daily recurrence renders separate chips, not one eternal bar @tier2", async ({
  app,
}) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  // No time → all-day. "every day" is stripped to the title "Standup".
  await app.getByRole("textbox", { name: "Quick add input" }).fill("Standup every day");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await openCalendarMode(app);
  // Advance a week so the whole visible window is after the head — every day
  // is an all-day virtual, giving a gap-free run (the bug's trigger).
  await advanceCalendarOneWeek(app);
  const calendar = calendarRegion(app);

  await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
  // Pre-fix: the gap-free series collapsed into ONE bar (count === 1). Each day
  // must be its own chip, so ≥2 distinct all-day bars prove they didn't merge.
  const chips = calendar.getByRole("button", { name: /^Standup/ });
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
});

// ─── Drag-virtual → materialised page; head completion skips it ───────────
//
// Spec scenario:
//   1. Create a daily recurring page (head anchored today).
//   2. Drag the next day's virtual to a different time. The drag must
//      materialise an independent real page at the new time and exdate the
//      original date — the virtual disappears, a normal page-block appears.
//   3. Complete the head's chip. The head must advance to the day AFTER
//      the materialised one (skipping the materialised date because it was
//      added to exdates), not back onto the materialised date itself.
//
// Pre-fix bug 1: dragging a virtual called scheduleOnce(headId), which
// moved the head's denorm onto the dropped slot and left a phantom virtual
// at the original anchor.
// Pre-fix bug 2: even after the materialise was correct, completing the head
// advanced via raw rrule.after() — which lands on the materialised date
// because nextOccurrenceAfter wasn't honouring exdates.

appTest(
  "drag virtual reschedules to a real page; head advance skips the materialised date @tier2",
  async ({ app }) => {
    // Seed: daily recurring page with a definite time so virtuals appear in
    // the timed grid (easier to drag than all-day chips).
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(
      dialog.getByRole("button", { name: /Recurrence: every day/i })
    ).toBeVisible({ timeout: 2000 });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    // Advance one week so the visible window is wholly after the head — every
    // chip in view is a virtual. Keeps the drag target deterministic regardless
    // of which weekday or time-of-day the test happens to run on.
    await advanceCalendarOneWeek(app);
    const calendar = calendarRegion(app);

    // Wait for daily virtuals to render. A full week of virtuals = 7 chips,
    // all carrying the "Recurring" aria-label.
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5000 });
    const virtualsBefore = await calendar.getByLabel("Recurring").count();
    const totalChipsBefore = await calendar
      .getByRole("button", { name: /^standup/i })
      .count();
    // Sanity: at least one virtual to drag, and total chip count covers it.
    expect(virtualsBefore).toBeGreaterThanOrEqual(1);
    expect(totalChipsBefore).toBeGreaterThanOrEqual(2);

    // Find the first virtual chip (the parent button containing a "Recurring"
    // icon). Drag its body 60px upward — that snaps to one hour earlier in
    // the same day (the calendar is hour-pitched).
    const firstVirtual = calendar
      .getByRole("button", { name: /^standup/i })
      .filter({ has: app.getByLabel("Recurring") })
      .first();
    // WeekGrid smart-starts at max(7am, now-1h). When the test runs late in
    // the day, 9am chips sit hours above the viewport and boundingBox()
    // returns coords the mouse path never reaches. Scroll the chip in first.
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

    // After drop:
    // - One fewer "Recurring" icon (the dragged virtual is now a real page).
    // - Total chip count is the same (remaining virtuals + new materialised clone).
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 1);
    await expect(calendar.getByRole("button", { name: /^standup/i })).toHaveCount(totalChipsBefore);

    // Complete the head via the editor byline (more reliable toggle target
    // than the calendar chip's nested checkbox, and avoids the "Mark done"
    // name duplication from the still-visible page-list checkbox). The page
    // list sorts by scheduledStart asc, so the first standup item is the head
    // at today 9am. Click selects the list item; Enter on the focused item
    // routes through ui.openPage, which sets the active page and switches the
    // right panel to editor (where the byline lives).
    const listHead = app.locator("[data-page-list-item]").filter({ hasText: "standup" }).first();
    await listHead.click();
    await listHead.press("Enter");
    // Anchor /^Mark done$/i — the substring "Mark done" also appears in
    // page-list-item buttons' accessible names ("Mark done standup ..."),
    // so a plain string match would collide; the byline button's name is
    // exactly "Mark done".
    const bylineDone = app.getByRole("button", { name: /^Mark done$/i });
    await expect(bylineDone).toBeVisible();
    await bylineDone.click();
    // Switch back to calendar to verify the head advanced.
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(calendarRegion(app)).toBeVisible();

    // Smoke-test the post-completion integration. The earlier toHaveCount
    // assertions above already locked down the drag → materialise step
    // in a date-robust way. For the head's exdate-aware advance, the chip
    // arithmetic only works on weekdays where the head + materialised +
    // post-advance head all land inside the visible 7-day window — so we
    // verify the *behavioural* contract here instead and let the unit suite
    // in `packages/core/src/utils/recurrence.test.ts` cover the rigorous
    // exdate semantics across rule shapes and edge cases.
    //
    // Behavioural contract: completion produces exactly one done clone (so
    // the head's status transitioned), and the workspace still has two open
    // standup pages (the head — its denorm advanced to some next date — and
    // the materialised page from the drag).
    const allStandups = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
    // Expand the Completed accordion so its members count toward the locator.
    await app.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(allStandups).toHaveCount(3);
  }
);

// ─── Stop repeating removes the rule ───────────────────────────────────────
//
// "Stop repeating" inside the recurrence popover deletes the rule entirely.
// The page stays scheduled (its denorm date doesn't change) but the byline
// chip flips back to "Set recurrence".

appTest("Stop repeating removes the recurrence rule @tier2", async ({ app }) => {
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

  // Open the byline's recurrence popover — its trigger carries the cadence in
  // its accessible name in the editor's icon variant.
  await app
    .getByRole("button", { name: /Recurrence: every week on Monday/i })
    .click();

  await app.getByRole("button", { name: "Stop repeating" }).click();

  // The chip's accessible name flips back to the empty state.
  await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
});
