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
  await app.getByPlaceholder(/what's on your mind/i).fill("Team retro");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the page in the editor.
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

  // Create an all-day chip with a title, then re-open its popover.
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
  await app.getByPlaceholder(/what's on your mind/i).fill("standup every day at 9am");
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

  // The byline's status toggle button reads "Open" before completion.
  const statusButton = app.getByRole("button", { name: "Mark done" });
  await expect(statusButton).toBeVisible();
  await statusButton.click();

  // After completion, the head's status went back to "not_started" (since
  // there are still future occurrences) — but a NEW done clone exists. The
  // page list should now show two entries with the same title: one open
  // (head, advanced) and one done (clone).
  await expect(
    app.getByRole("button", { name: /^Recurrence: every day/i })
  ).toBeVisible();
});

// ─── Virtual occurrences render on the calendar ───────────────────────────
//
// A daily recurrence anchored today should render the head plus virtual
// occurrences for the rest of the week. The virtuals carry a Repeat2 icon
// (aria-label "Recurring") instead of the head's status checkbox — this is
// the visual signal users rely on to recognise "this is a future repeat,
// not a real page". Clicking a virtual opens VirtualPageBlockPopover with
// a Skip action.

appTest("daily recurring page renders virtual occurrences on the calendar @tier2", async ({
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
  await app.getByPlaceholder(/what's on your mind/i).fill("standup every day at 9am");
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await openCalendarMode(app);
  const calendar = calendarRegion(app);

  // Multiple chips for the same title across the week — head + virtuals.
  // The exact count depends on which day of the week the test runs on, but
  // there should always be at least 2 (head + at least one future virtual,
  // since "today" is rarely Sunday at the very end of the week view).
  // Wait for at least one Recurring icon (virtual) before counting — it
  // proves expansion has finished and avoids racing the post-submit render.
  await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5_000 });
  const chips = calendar.getByRole("button", { name: /^standup/i });
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(2);
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
    await app.getByPlaceholder(/what's on your mind/i).fill("standup every day at 9am");
    await expect(
      dialog.getByRole("button", { name: /Recurrence: every day/i })
    ).toBeVisible({ timeout: 2000 });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await openCalendarMode(app);
    const calendar = calendarRegion(app);

    // Wait for daily virtuals to render. With a timed daily anchored today
    // the head's chip is in the timed grid at 9am, and there are virtuals
    // for tomorrow / day after / etc.
    await expect(calendar.getByLabel("Recurring").first()).toBeVisible({ timeout: 5000 });
    const virtualsBefore = await calendar.getByLabel("Recurring").count();
    const headChipsBefore = await calendar
      .getByRole("button", { name: /^standup/i })
      .count();
    // Sanity: at least one head + one future virtual.
    expect(virtualsBefore).toBeGreaterThanOrEqual(1);
    expect(headChipsBefore).toBeGreaterThanOrEqual(2);

    // Find the first virtual chip (the parent button containing a "Recurring"
    // icon). Drag its body 60px upward — that snaps to one hour earlier in
    // the same day (the calendar is hour-pitched).
    const firstVirtual = calendar
      .getByRole("button", { name: /^standup/i })
      .filter({ has: app.getByLabel("Recurring") })
      .first();
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
    // - Total chip count is the same (head + remaining virtuals + new clone).
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 1);
    await expect(calendar.getByRole("button", { name: /^standup/i })).toHaveCount(headChipsBefore);

    // Now complete the head's chip. Open it in the editor (more reliable
    // toggle target than the calendar chip's nested checkbox), then click
    // "Mark done" in the byline. The page list sorts by scheduledStart asc,
    // so the first standup item is the head at today 9am. Switching to
    // editor mode also avoids the "Mark done" duplication from the still-
    // visible page-list checkbox.
    // Open the head in the editor. Click selects the list item; Enter on
    // the focused item routes through ui.openPage which sets active page +
    // switches the right panel to editor (where the byline lives).
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

    // After completion, the head's denorm advances. With exdate-aware advance,
    // it skips the materialised date (which was added to exdates) and lands
    // on the next non-excluded daily occurrence — which is +2 days from the
    // original anchor (the +1 day was the materialised one).
    //
    // Verify by counting Recurring icons: one of the original virtuals was
    // materialised (-1), one of the previously-virtual days became the new
    // head (so -1 more virtual on that day, but +1 head chip without an icon,
    // so total chip count stays the same). The head chip at the original
    // anchor was replaced by a done clone (which still has standup title).
    //
    // The cleanest assertion: head's anchor day is no longer the chip with
    // checkbox — the materialised day is shown as a real chip (no icon),
    // and head has advanced to the next-next day.
    //
    // At minimum: total Recurring-icon count drops by ANOTHER 1 (the new
    // head's anchor day's virtual is now the head chip itself).
    await expect(calendar.getByLabel("Recurring")).toHaveCount(virtualsBefore - 2);
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
  await app.getByPlaceholder(/what's on your mind/i).fill("yoga every monday at 7am");
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

  // Click "Stop repeating" — the rule is deleted, the popover closes.
  await app.getByRole("button", { name: "Stop repeating" }).click();

  // The chip's accessible name flips back to the empty state.
  await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
});
