import { expect } from "@playwright/test";

import { mod, test as appTest } from "./fixtures";

// ─── Basic Quick Add: chip defaults + NLP tokens ───────────────────────────

appTest("create page via Quick Add @tier1", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByPlaceholder(/what's on your mind/i);
  await expect(input).toBeFocused();

  // Chips start in default state
  await expect(dialog.getByRole("button", { name: "Folder: Inbox" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: Priority" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: none" })).toBeVisible();

  // Type input with NLP tokens and verify all chips update
  await input.fill("team meeting @tomorrow at 2pm !high #work");
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: work" })).toBeVisible();

  // Submit and verify page created
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item]").getByText("team meeting")).toBeVisible();
});

// ─── Multi-day all-day ranges ──────────────────────────────────────────────
// Guards the parser + chip wiring for multi-day all-day inputs. Regressions to
// watch for: (a) "through" between numbers used to be mis-parsed as a time
// range (2–10 am) instead of a date span; (b) QuickAddDialog used to drop
// `scheduledEnd` for all-day events, so the chip collapsed to the start day.

appTest("Quick Add parses multi-day all-day ranges @tier1", async ({ app }) => {
  // Dec 28–31 is the latest safe span in a calendar year; chrono.forwardDate
  // rolls it forward past Dec 28, so the exact label may carry a year suffix
  // in the narrow window where we're already past it. The regex tolerates both.
  async function openQuickAdd() {
    await app.keyboard.press(mod("Mod+n"));
    await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  }

  const dialog = app.getByRole("dialog", { name: "Quick add" });
  const input = app.getByPlaceholder(/what's on your mind/i);

  // 1. Hyphenated range — the original syntax that already worked.
  await openQuickAdd();
  await input.fill("trip Dec 28-31");
  await expect(dialog.getByRole("button", { name: /Scheduled: Dec 28.*31/ })).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // 2. "through <bare digit>" — the previously broken path. Chrono reads
  //    "28 through 31" as a time range; the normalizer rewrites to "28 to 31"
  //    so both syntaxes emit the same span.
  await openQuickAdd();
  await input.fill("offsite Dec 28 through 31");
  await expect(dialog.getByRole("button", { name: /Scheduled: Dec 28.*31/ })).toBeVisible();
  // Not a timed "Tomorrow …am" chip (the regression symptom).
  await expect(dialog.getByRole("button", { name: /Tomorrow/ })).not.toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // 3. Single bare date — no range, so the chip stays the start-only label.
  await openQuickAdd();
  await input.fill("review Dec 28");
  const chip = dialog.getByRole("button", { name: /Scheduled: Dec 28/ });
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAccessibleName(/31/);
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Page list: both range pages render the span in their date chip; the
  // single-day page renders just the start.
  const tripItem = app.locator("[data-page-list-item]").filter({ hasText: "trip" });
  const offsiteItem = app.locator("[data-page-list-item]").filter({ hasText: "offsite" });
  const reviewItem = app.locator("[data-page-list-item]").filter({ hasText: "review" });

  await expect(tripItem).toContainText(/Dec 28.*31/);
  await expect(offsiteItem).toContainText(/Dec 28.*31/);
  await expect(reviewItem).toContainText(/Dec 28/);
  await expect(reviewItem).not.toContainText(/31/);
});

// ─── Recurring page creation ───────────────────────────────────────────────

appTest("create recurring page shows recurrence label @tier2", async ({ app }) => {
  // Create a recurring page via QuickAdd
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByPlaceholder(/what's on your mind/i);
  await input.fill("standup every monday at 9am");

  // Wait for NLP debounce — the recurrence chip in the byline is compact
  // (visible text is the short form "Weekly"; the full cadence lives in the
  // button's aria-label so screen readers get the weekday anchor).
  await expect(
    dialog.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });

  // Submit
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Page should appear in the list
  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toBeVisible();

  // Open the page and verify recurrence in the editor byline. The byline chip
  // is icon-only — the cadence lives on the button's accessible name (aria-label).
  await listItem.click();
  await expect(
    app.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible();
});

// ─── Create folder inline from FolderChip ──────────────────────────────────

appTest("create folder inline via QuickAdd FolderChip @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByPlaceholder(/what's on your mind/i).fill("page in fresh folder");

  // Open folder picker and type a brand new folder name
  await dialog.getByRole("button", { name: "Folder: Inbox" }).click();
  const folderSearch = app.getByPlaceholder(/search or create/i);
  await folderSearch.fill("Fresh Folder");

  // Enter creates the folder, selects it, and closes the popover
  await app.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Folder: Fresh Folder" })).toBeVisible();

  // Submit the quick add — page should be created in the new folder
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Sidebar shows the new folder; navigate to it and confirm page landed there
  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folderBtn = sidebar.getByRole("button", { name: "Fresh Folder", exact: true });
  await expect(folderBtn).toBeVisible();
  await folderBtn.click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "page in fresh folder" })
  ).toBeVisible();

  // Page should NOT be in Inbox
  await app.getByRole("button", { name: /Inbox/ }).click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "page in fresh folder" })
  ).not.toBeVisible();
});

// ─── Bounded recurrence round-trip (NLP → 1 page + rrule) ──────────────────
//
// Regression guard for the "bulk 10 pages" bug. NLP bounded-recurrence inputs
// ("every X + window") must produce ONE page with an rrule, not N copies.

appTest("QuickAdd bounded recurrence creates 1 page with rrule @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app
    .getByPlaceholder(/what's on your mind/i)
    .fill("practice piano every monday at 3pm for 4 weeks");

  // Aria-label uses the long cadence — "every week on Monday until …" — so
  // screen-reader users hear the weekday anchor and end date.
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every week on Monday until/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Exactly one page — not 4.
  const pages = app.locator("[data-page-list-item]").filter({ hasText: "practice piano" });
  await expect(pages).toHaveCount(1);
});

// ─── Default-daily round-trip ("N times" with no cadence) ──────────────────
//
// "meditate 10 times" → the parser defaults to FREQ=DAILY + COUNT=10.
// Verifies one page is created (not 10) and the chip shows the daily cadence.

appTest("QuickAdd 'N times' defaults to daily recurring @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByPlaceholder(/what's on your mind/i).fill("meditate 10 times");

  // Aria-label uses the long cadence — "every day for 10 times".
  await expect(
    dialog.getByRole("button", { name: /Recurrence: every day for 10 times/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const pages = app.locator("[data-page-list-item]").filter({ hasText: "meditate" });
  await expect(pages).toHaveCount(1);
});

// ─── Finite bulk create (m/w/f → 3 separate pages) ─────────────────────────
//
// Finite recurrence (bare slash days, no "every") still produces N independent
// pages — each on its own concrete date. Distinct from the recurring-template
// path above.

appTest("QuickAdd m/w/f creates 3 separate pages @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByPlaceholder(/what's on your mind/i).fill("swim m/w/f");

  // Finite preview appears in the recurrence chip's override label slot.
  await expect(dialog.getByRole("button", { name: /Recurrence: 3 occurrences/i })).toBeVisible({
    timeout: 2000,
  });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Three separate pages, one per scheduled weekday.
  const pages = app.locator("[data-page-list-item]").filter({ hasText: "swim" });
  await expect(pages).toHaveCount(3);
});

// ─── Manual chip override survives continued NLP typing ────────────────────
//
// If the user sets a chip explicitly, subsequent NLP re-parses must not
// overwrite it. Verified on priority (cheapest chip to interact with) — the
// same `*Manual` flag pattern guards date, folder, and rrule.

appTest("QuickAdd manual priority override survives further typing @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByPlaceholder(/what's on your mind/i);
  await input.fill("report !low");
  await expect(dialog.getByRole("button", { name: "Priority: Low" })).toBeVisible({
    timeout: 2000,
  });

  // Open the priority dropdown and pick High manually.
  await dialog.getByRole("button", { name: "Priority: Low" }).click();
  await app.getByRole("menuitem", { name: /High/ }).click();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();

  // Keep typing — NLP re-parses and would normally set priority=low from !low.
  // The manual flag should prevent the override.
  await input.fill("report !low tomorrow");
  // Give the 200ms debounce time to fire.
  await app.waitForTimeout(400);
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
});

// ─── Manual rrule chip survives continued NLP typing ───────────────────────
//
// User picks a recurrence preset before typing — subsequent NLP re-parses
// (which would otherwise infer a different rrule) must not overwrite the
// chip. Mirrors the priority-manual guard but exercises the rrule path.

appTest("QuickAdd manual rrule override survives further typing @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByPlaceholder(/what's on your mind/i);

  // Type a date so the recurrence preset has an anchor (presets show
  // weekday/day-of-month detail tied to anchorDate).
  await input.fill("review tomorrow");
  await app.waitForTimeout(400);

  // Open the recurrence popover and pick "Daily" preset.
  await dialog.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

  // Keep typing with conflicting recurrence NLP (would normally infer WEEKLY).
  await input.fill("review tomorrow every monday");
  await app.waitForTimeout(400);
  // Manual chip wins — still daily, not weekly-on-Monday.
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();
});

// ─── Recurrence chip alone (no NLP) creates a recurring page ───────────────
//
// User can set recurrence purely via the chip, without typing any cadence
// in the title — the chip falls back to today's date. Guards the
// "rrule && !dateValue → setDateValue(localToday())" branch in QuickAdd.

appTest("QuickAdd recurrence chip without NLP creates recurring page @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByPlaceholder(/what's on your mind/i).fill("standup");

  // No date typed yet — recurrence preset still selectable; date defaults to today.
  await dialog.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

  // Submit — page should be created with a recurrence rule. Press Enter on
  // the input to commit.
  await app.getByPlaceholder(/what's on your mind/i).press("Enter");
  await expect(dialog).not.toBeVisible();

  // One page named "standup".
  const pages = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(pages).toHaveCount(1);

  // Open it and verify the byline shows recurrence in the icon-only chip's
  // accessible name.
  await pages.first().click();
  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

// ─── Stop repeating clears the rule via the byline popover ─────────────────

appTest("byline 'Stop repeating' clears the recurrence rule @tier2", async ({ app }) => {
  // Seed a recurring page via NLP.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByPlaceholder(/what's on your mind/i).fill("standup every monday at 9am");
  await expect(
    dialog.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the page.
  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toBeVisible();
  await listItem.click();

  // Byline shows the recurrence chip; click to open the popover.
  const byline = app.getByRole("button", { name: /recurrence: every week on Monday/i });
  await expect(byline).toBeVisible();
  await byline.click();

  // Click "Stop repeating" — popover closes, chip drops back to "Set recurrence".
  await app.getByRole("button", { name: "Stop repeating" }).click();

  // The icon-only chip now shows the unset state via tooltip "Set recurrence".
  await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
});

// ─── Add recurrence to an existing page via the byline popover ─────────────
//
// User creates a one-off page, then wants to make it recurring. Opening the
// byline RecurrencePopover and picking a preset should attach a rule to the
// page (and anchor to today if no date is set).

appTest("add recurrence to a page from the byline @tier2", async ({ app }) => {
  // Create a single page (no recurrence) via Quick Add.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByPlaceholder(/what's on your mind/i).fill("workout tomorrow");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Open the page.
  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "workout" });
  await listItem.click();

  // The recurrence chip in the byline starts in the unset state.
  const setChip = app.getByRole("button", { name: "Set recurrence" });
  await expect(setChip).toBeVisible();
  await setChip.click();

  // Pick "Daily" preset — preset row label starts with "Daily".
  await app.getByRole("button", { name: /^Daily/ }).click();

  // Chip flips to the active state with a Recurrence: aria-label.
  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

// ─── Completing a recurring head advances it (and clones the prior occurrence) ─
//
// Toggling status on a recurring page triggers `completeRecurringPage`, which
// clones the current occurrence as `done` and advances the head's
// scheduledStart to the next occurrence. The list should still surface a
// non-done "standup" head, plus a `done` clone in the completed section.

appTest("completing a recurring page advances head and clones a done copy @tier2", async ({
  app,
}) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByPlaceholder(/what's on your mind/i).fill("standup every day");
  await expect(dialog.getByRole("button", { name: /recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // The recurring head appears in the active list (status = not_started).
  const standup = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(standup).toHaveCount(1);

  // Toggle complete via the head's checkbox.
  await standup.first().getByRole("checkbox", { name: "Mark done" }).click();

  // The head re-appears as still-open in the active list — advanced, not gone.
  // (A non-recurring page would leave the active list.)
  await expect(standup.filter({ has: app.getByRole("checkbox", { name: "Mark done" }) })).toHaveCount(
    1
  );

  // The completed section now contains a done clone.
  const completedToggle = app.getByRole("button", { name: /Completed/ });
  await completedToggle.click();
  // After expansion, both the head (open) and the clone (done) carry the same
  // title — total "standup" rows should be ≥ 2.
  await expect(standup).toHaveCount(2);
  // One of them is checked (the clone).
  await expect(standup.getByRole("checkbox", { name: "Mark not done" })).toHaveCount(1);
});
