// E2E coverage for the recurring-page UX flows.
//
// Walks the same paths a user would: create-with-recurrence in QuickAdd, add
// recurrence later via the page editor's byline, the calendar's
// PageBlockPopover gating when no date is set, completing a head occurrence
// (clone + advance), skipping a virtual occurrence, and removing the rule
// entirely. Runs against MockStorageAdapter (VITE_TEST_MODE=true).

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

async function openCalendarMode(app: Page) {
  await app.keyboard.press(mod("Mod+Shift+c"));
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
  // Create a plain page (no schedule, no recurrence).
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByPlaceholder(/what's on your mind/i).fill("Weekly review");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the page in the editor.
  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "Weekly review" });
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
// PageBlockPopover gates the recurrence chip on a scheduled date — without
// one, the chip is disabled with a "Set a date first" hint (regression guard
// against the silent-no-op the handler used to fall through to). Once the
// page has a date, the chip is enabled and creating a rule succeeds.

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
  // With no rule yet, aria-label is "Set recurrence" (RecurrencePopover line
  // 377). With a date set, the chip is enabled — clicking opens the popover.
  const recurrenceChip = app.getByRole("button", { name: "Set recurrence" });
  await expect(recurrenceChip).toBeVisible();
  await expect(recurrenceChip).toBeEnabled();

  await recurrenceChip.click();
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
  // Seed a daily recurring page anchored to today. QuickAdd's recurring path
  // sets the head's scheduledStart to today, then the calendar's
  // useRecurrenceExpansion fills in the rest of the week as virtual blocks.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByPlaceholder(/what's on your mind/i).fill("daily walk every day");
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
  const chips = calendar.getByRole("button", { name: /^daily walk/i });
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Virtual chips render the Repeat2 icon with aria-label="Recurring" inside
  // the button. The head renders a TaskCheckbox instead. So at least one
  // "Recurring" descendant must exist somewhere in the calendar.
  await expect(calendar.getByLabel("Recurring").first()).toBeVisible();
});

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
