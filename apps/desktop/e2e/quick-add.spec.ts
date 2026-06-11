import { expect } from "@playwright/test";

import { mod, test as appTest } from "./fixtures";

// ─── Basic Quick Add: chip defaults + NLP tokens ───────────────────────────

appTest("create page via Quick Add @tier1", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  await expect(dialog.getByRole("button", { name: "Folder: Inbox" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: Priority" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: none" })).toBeVisible();

  await input.fill("team meeting @tomorrow at 2pm !high #work");
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: work" })).toBeVisible();

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item]").getByText("team meeting")).toBeVisible();
});

// ─── Multi-day all-day ranges ──────────────────────────────────────────────
// Guards the parser + chip wiring for multi-day all-day inputs. Regressions to
// watch for: (a) "through" between numbers used to be mis-parsed as a time
// range (2–10 am) instead of a date span; (b) QuickAddDialog used to drop
// `scheduledEnd` for all-day events, so the chip collapsed to the start day.

appTest("Quick Add parses multi-day all-day ranges @tier2", async ({ app }) => {
  // Dec 28–31 is the latest safe span in a calendar year; chrono.forwardDate
  // rolls it forward past Dec 28, so the exact label may carry a year suffix
  // in the narrow window where we're already past it. The regex tolerates both.
  async function openQuickAdd() {
    await app.keyboard.press(mod("Mod+n"));
    await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  }

  const dialog = app.getByRole("dialog", { name: "Quick add" });
  const input = app.getByRole("textbox", { name: "Quick add input" });

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
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("standup every monday at 9am");

  // Wait for NLP debounce — the recurrence chip in the byline is compact
  // (visible text is the short form "Weekly"; the full cadence lives in the
  // button's aria-label so screen readers get the weekday anchor).
  await expect(
    dialog.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

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

  await app.getByRole("textbox", { name: "Quick add input" }).fill("page in fresh folder");

  await dialog.getByRole("button", { name: "Folder: Inbox" }).click();
  const folderSearch = app.getByPlaceholder(/search or create/i);
  await folderSearch.fill("Fresh Folder");

  // Enter creates the folder, selects it, and closes the popover
  await app.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Folder: Fresh Folder" })).toBeVisible();

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folderBtn = sidebar.getByRole("button", { name: "Fresh Folder", exact: true });
  await expect(folderBtn).toBeVisible();
  await folderBtn.click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "page in fresh folder" })
  ).toBeVisible();

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
    .getByRole("textbox", { name: "Quick add input" })
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

  await app.getByRole("textbox", { name: "Quick add input" }).fill("meditate 10 times");

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

  await app.getByRole("textbox", { name: "Quick add input" }).fill("swim m/w/f");

  // Finite preview appears in the recurrence chip's override label slot.
  await expect(dialog.getByRole("button", { name: /Recurrence: 3 occurrences/i })).toBeVisible({
    timeout: 2000,
  });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

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

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("report !low");
  await expect(dialog.getByRole("button", { name: "Priority: Low" })).toBeVisible({
    timeout: 2000,
  });

  await dialog.getByRole("button", { name: "Priority: Low" }).click();
  await app.getByRole("menuitem", { name: /High/ }).click();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();

  // Keep typing — NLP re-parses and would normally set priority=low from !low.
  // The manual flag should prevent the override.
  await input.fill("report !low tomorrow");
  // Wait for the parse to fire (200ms debounce) — the Date chip filling is the
  // observable positive signal. Then assert priority is still High.
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });
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

  const input = app.getByRole("textbox", { name: "Quick add input" });

  // Type a date so the recurrence preset has an anchor (presets show
  // weekday/day-of-month detail tied to anchorDate).
  await input.fill("review tomorrow");
  // Wait for the Date chip to fill — proves the 200ms NLP debounce fired.
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });

  await dialog.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

  // Keep typing with conflicting recurrence NLP (would normally infer WEEKLY).
  // Add a tag so we have an observable signal that the parse actually fired —
  // proving the manual override isn't just being checked before re-parse.
  await input.fill("review tomorrow every monday #work");
  await expect(dialog.getByRole("button", { name: /Tags: work/ })).toBeVisible({ timeout: 2000 });
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

  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup");

  // No date typed yet — recurrence preset still selectable; date defaults to today.
  await dialog.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

  // Press Enter on the input (not the page) so the submit handler receives it.
  await app.getByRole("textbox", { name: "Quick add input" }).press("Enter");
  await expect(dialog).not.toBeVisible();

  const pages = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(pages).toHaveCount(1);

  // Open it and verify the byline shows recurrence in the icon-only chip's
  // accessible name.
  await pages.first().click();
  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

// ─── Stop repeating clears the rule via the byline popover ─────────────────

appTest("byline 'Stop repeating' clears the recurrence rule @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every monday at 9am");
  await expect(
    dialog.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toBeVisible();
  await listItem.click();

  const byline = app.getByRole("button", { name: /recurrence: every week on Monday/i });
  await expect(byline).toBeVisible();
  await byline.click();

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
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("workout tomorrow");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "workout" });
  await listItem.click();

  const setChip = app.getByRole("button", { name: "Set recurrence" });
  await expect(setChip).toBeVisible();
  await setChip.click();

  // Preset row label starts with "Daily".
  await app.getByRole("button", { name: /^Daily/ }).click();

  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

// ─── Empty input shakes (validation feedback) ─────────────────────────────

appTest("empty Quick Add input shakes on submit @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  // Empty submit is rejected. The shake is animation-only — the observable
  // contract is that the dialog stays open with focus still on the input.
  await app.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  // Whitespace-only also rejected.
  await input.fill("   ");
  await app.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
});

// ─── Token-only input creates an Untitled page (no raw-token leakage) ────
//
// Regression guard: the parser strips tokens, leaving title="". The dialog
// must not fall back to inputValue (which still holds the raw tokens) —
// otherwise pages get titled "tomorrow", "#work", "!high" etc.

appTest("token-only Quick Add input creates an Untitled page @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  // Input is just a date — parser strips it, leaving an empty title.
  await app.getByRole("textbox", { name: "Quick add input" }).fill("tomorrow");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const untitled = app.locator("[data-page-list-item]").filter({ hasText: "Untitled" });
  await expect(untitled).toBeVisible();
  const literalTomorrow = app
    .locator("[data-page-list-item]")
    .filter({ hasText: /^tomorrow$/i });
  await expect(literalTomorrow).toHaveCount(0);
});

// ─── Shift+Enter adds the page and opens it in the editor ────────────────────
//
// Power-user shortcut: create the page AND jump straight into editing it. The
// dialog closes and the new page becomes the activePage so the editor surfaces
// it. Guards the executeCreate `{id, title}` return-shape refactor and the
// openPage() wiring in handleSubmitAndOpen.

appTest("Shift+Enter adds page and opens it in the editor @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("open me on create");
  await app.keyboard.press("Shift+Enter");

  await expect(dialog).not.toBeVisible();

  const item = app.locator("[data-page-list-item]").filter({ hasText: "open me on create" });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-active", "true");

  // Editor body becomes available — proves the right panel switched to editor.
  await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
});

// ─── Chip dropdown close restores focus to the Quick Add input ──────────────
//
// Each chip plumbs `onCloseAutoFocus` through to Radix's content so clicking
// outside the dropdown (or selecting an item) bounces focus back to the main
// input instead of staying on the chip trigger. Exercised on PriorityDropdown
// — the smallest dropdown to interact with.

appTest("priority dropdown close restores focus to Quick Add input @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  // Open the dropdown and pick High. Radix sets aria-hidden on the rest of the
  // page while the menu is open, so we can't assert input focus state in
  // between — only after close. The contract we care about: after close,
  // focus is back on the input (NOT on the chip trigger).
  await dialog.getByRole("button", { name: "Priority: Priority" }).click();
  await app.getByRole("menuitem", { name: /High/ }).click();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(input).toBeFocused();
});

// ─── Cmd+Enter batch submit adds page and resets the form ──────────────────

appTest("Cmd+Enter adds page in batch and clears the input @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("first batch task");
  await app.keyboard.press(mod("Mod+Enter"));

  // Dialog stays open; brief confirmation appears.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/first batch task/)).toBeVisible();

  // Wait for the addedFeedback to clear (1s timeout in source) and the input
  // to remount.
  await expect(app.getByRole("textbox", { name: "Quick add input" })).toBeVisible({ timeout: 2000 });

  const input2 = app.getByRole("textbox", { name: "Quick add input" });
  await input2.fill("second batch task");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "first batch task" })
  ).toBeVisible();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "second batch task" })
  ).toBeVisible();
});

// ─── Numeric priority shortcut (!1 → urgent chip) ──────────────────────────

appTest("!1 numeric priority maps to Urgent chip @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("blocker !1");
  // !1 maps via parser to "urgent", QuickAddDialog maps to numeric priority 1.
  await expect(dialog.getByRole("button", { name: "Priority: Urgent" })).toBeVisible({
    timeout: 2000,
  });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Page appears in the list with the priority retained — no raw "!1" in title.
  const item = app.locator("[data-page-list-item]").filter({ hasText: "blocker" });
  await expect(item).toBeVisible();
  await expect(item).not.toContainText("!1");
});

// ─── 'today' keyword schedules for today ───────────────────────────────────

appTest("bare 'today' schedules the page for today @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("lunch today");
  // Date chip flips from "Set schedule" → a Scheduled: <date> chip with
  // today's label (UI may display "Today" or e.g. "Mar 15"; both are fine).
  await expect(dialog.getByRole("button", { name: /^Scheduled:/ })).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await expect(app.locator("[data-page-list-item]").filter({ hasText: "lunch" })).toBeVisible();
});

// ─── ~inbox routes to Inbox folder ─────────────────────────────────────────
//
// Special-case: when the user explicitly types ~inbox (and Inbox isn't a
// real folder name), the parser stashes "inbox" as folderQuery and the
// dialog routes it to folderId=null (Inbox is the implicit null-folder
// view).

appTest("~inbox folder query routes to Inbox @tier2", async ({ app }) => {
  // Create a real folder so the default folder isn't Inbox.
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("Notes");
  await app.keyboard.press("Enter");

  // Active folder is now "Notes". A new Quick Add inherits Notes as default.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Folder: Notes" })).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("dump ~inbox");
  await expect(dialog.getByRole("button", { name: "Folder: Inbox" })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await app.getByRole("button", { name: /^Inbox/ }).click();
  await expect(app.locator("[data-page-list-item]").filter({ hasText: "dump" })).toBeVisible();
});

// ─── Manual date override survives further NLP typing ──────────────────────

appTest("QuickAdd manual date override survives further typing @tier2", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("review tomorrow");
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });

  await dialog.getByRole("button", { name: /Scheduled:/ }).click();
  await app.getByRole("button", { name: /^Clear/ }).click();
  await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();

  // Type more text including a date — chip should NOT auto-fill (manual override).
  // Add a tag so we have a positive signal the parse actually fired.
  await input.fill("review tomorrow next week #work");
  await expect(dialog.getByRole("button", { name: /Tags: work/ })).toBeVisible({ timeout: 2000 });
  await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
});

