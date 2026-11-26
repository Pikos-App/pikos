import { expect } from "@playwright/test";

import { test as appTest, createFolder, mod } from "./fixtures";

appTest("create page via Quick Add @smoke", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  await expect(dialog.getByRole("button", { name: "Folder: Inbox" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: No priority" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: none" })).toBeVisible();

  await input.fill("team meeting @tomorrow at 2pm !high #work");
  await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tags: work" })).toBeVisible();

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item]").getByText("team meeting")).toBeVisible();
});

// "through" between numbers must be a date span, not a time range (2-10 am), and all-day events must keep
// scheduledEnd so the chip doesn't collapse to the start day.

appTest("Quick Add parses multi-day all-day ranges", async ({ app }) => {
  // Dec 28-31 is the latest safe span; chrono.forwardDate rolls it past Dec 28, so the label may carry a year suffix. The regex tolerates both.
  async function openQuickAdd() {
    await app.keyboard.press(mod("Mod+n"));
    await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  }

  const dialog = app.getByRole("dialog", { name: "Quick add" });
  const input = app.getByRole("textbox", { name: "Quick add input" });

  await openQuickAdd();
  await input.fill("trip Dec 28-31");
  await expect(dialog.getByRole("button", { name: /Scheduled: Dec 28.*31/ })).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Chrono reads "28 through 31" as a time range; the normalizer rewrites it to "28 to 31" so both syntaxes give the same span.
  await openQuickAdd();
  await input.fill("offsite Dec 28 through 31");
  await expect(dialog.getByRole("button", { name: /Scheduled: Dec 28.*31/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Tomorrow/ })).not.toBeVisible();
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

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

appTest("create recurring page shows recurrence label", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("standup every monday at 9am");

  // Wait for the NLP debounce. The byline chip shows the short form "Weekly"; the full cadence is in the aria-label.
  await expect(
    dialog.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const listItem = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(listItem).toBeVisible();

  // The byline chip is icon-only; the cadence is its accessible name.
  await listItem.click();
  await expect(
    app.getByRole("button", { name: /recurrence: every week on Monday/i })
  ).toBeVisible();
});

// The chip preview runs on a 200ms debounce, and submit must not read the rrule from it: Enter inside the
// window must still keep the cadence. No wait here on purpose.

appTest(
  "Quick Add keeps the cadence when Enter beats the preview",
  { tag: ["@QADD-09:4"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();

    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every monday at 9am");
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    await app.locator("[data-page-list-item]").filter({ hasText: "standup" }).click();
    await expect(
      app.getByRole("button", { name: /recurrence: every week on Monday/i })
    ).toBeVisible();
  }
);

appTest("create folder inline via QuickAdd FolderChip", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("page in fresh folder");

  await dialog.getByRole("button", { name: "Folder: Inbox" }).click();
  const folderSearch = app.getByPlaceholder(/search or create/i);
  await folderSearch.fill("Fresh Folder");

  await app.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Folder: Fresh Folder" })).toBeVisible();

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folderBtn = sidebar.getByRole("button", { exact: true, name: "Fresh Folder" });
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

// NLP bounded-recurrence inputs ("every X + window") must produce ONE page with an rrule, not N copies.

appTest("QuickAdd bounded recurrence creates 1 page with rrule", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app
    .getByRole("textbox", { name: "Quick add input" })
    .fill("practice piano every monday at 3pm for 4 weeks");

  await expect(
    dialog.getByRole("button", { name: /Recurrence: every week on Monday until/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const pages = app.locator("[data-page-list-item]").filter({ hasText: "practice piano" });
  await expect(pages).toHaveCount(1);
});

// "meditate 10 times" defaults to FREQ=DAILY + COUNT=10.

appTest("QuickAdd 'N times' defaults to daily recurring", async ({ app }) => {
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

// Finite recurrence (bare slash days, no "every") makes N independent pages, unlike the recurring-template path.

appTest("QuickAdd m/w/f creates 3 separate pages", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("swim m/w/f");

  await expect(dialog.getByRole("button", { name: /Recurrence: 3 occurrences/i })).toBeVisible({
    timeout: 2000,
  });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const pages = app.locator("[data-page-list-item]").filter({ hasText: "swim" });
  await expect(pages).toHaveCount(3);
});

// The same `*Manual` flag pattern guards date, folder and rrule; priority is the cheapest chip to interact with.

appTest(
  "QuickAdd manual priority override survives further typing",
  { tag: ["@QADD-09:4"] },
  async ({ app }) => {
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

    // Keep typing: NLP would normally set priority=low from !low; the manual flag must prevent it.
    await input.fill("report !low tomorrow");
    // Wait for the 200ms parse debounce; the Date chip filling is the observable signal.
    await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  }
);

appTest(
  "QuickAdd manual rrule override survives further typing",
  { tag: ["@QADD-09:4"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();

    const input = app.getByRole("textbox", { name: "Quick add input" });

    // Type a date so the preset has an anchor (presets show details tied to anchorDate).
    await input.fill("review tomorrow");
    await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });

    await dialog.getByRole("button", { name: "Set recurrence" }).click();
    await app.getByRole("button", { name: /^Daily/ }).click();
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

    // Conflicting recurrence NLP would normally infer WEEKLY; the tag is an observable signal that the parse fired.
    await input.fill("review tomorrow every monday #work");
    await expect(dialog.getByRole("button", { name: /Tags: work/ })).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();
  }
);

// With a rule but no date, QuickAdd falls back to today's date.

appTest("QuickAdd recurrence chip without NLP creates recurring page", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup");

  await dialog.getByRole("button", { name: "Set recurrence" }).click();
  await app.getByRole("button", { name: /^Daily/ }).click();
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible();

  // Press Enter on the input, not the page, so the submit handler receives it.
  await app.getByRole("textbox", { name: "Quick add input" }).press("Enter");
  await expect(dialog).not.toBeVisible();

  const pages = app.locator("[data-page-list-item]").filter({ hasText: "standup" });
  await expect(pages).toHaveCount(1);

  await pages.first().click();
  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

appTest("byline 'Stop repeating' clears the recurrence rule", async ({ app }) => {
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

  await expect(app.getByRole("button", { name: "Set recurrence" })).toBeVisible();
});

appTest("add recurrence to a page from the byline", async ({ app }) => {
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

  await app.getByRole("button", { name: /^Daily/ }).click();

  await expect(app.getByRole("button", { name: /recurrence: every day/i })).toBeVisible();
});

appTest("empty Quick Add input shakes on submit", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  // The shake is animation-only; the observable contract is that the dialog stays open with focus on the input.
  await app.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill("   ");
  await app.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
});

// The parser strips tokens leaving title=""; the dialog must not fall back to inputValue (the raw tokens),
// or pages get titled "tomorrow", "#work".

appTest("token-only Quick Add input creates an Untitled page", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("tomorrow");
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const untitled = app.locator("[data-page-list-item]").filter({ hasText: "Untitled" });
  await expect(untitled).toBeVisible();
  const literalTomorrow = app.locator("[data-page-list-item]").filter({ hasText: /^tomorrow$/i });
  await expect(literalTomorrow).toHaveCount(0);
});

appTest("Shift+Enter adds page and opens it in the editor", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("open me on create");
  await app.keyboard.press("Shift+Enter");

  await expect(dialog).not.toBeVisible();

  const item = app.locator("[data-page-list-item]").filter({ hasText: "open me on create" });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-active", "true");

  await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();
});

// Each chip passes onCloseAutoFocus to Radix, so focus returns to the input, not the chip trigger.
// Exercised on PriorityDropdown, the smallest.

appTest("priority dropdown close restores focus to Quick Add input", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await expect(input).toBeFocused();

  // Radix sets aria-hidden on the rest of the page while the menu is open, so input focus can only be asserted after close.
  await dialog.getByRole("button", { name: "Priority: No priority" }).click();
  await app.getByRole("menuitem", { name: /High/ }).click();
  await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(input).toBeFocused();
});

appTest("Cmd+Enter adds page in batch and clears the input", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  const input = app.getByRole("textbox", { name: "Quick add input" });
  await input.fill("first batch task");
  await app.keyboard.press(mod("Mod+Enter"));

  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/first batch task/)).toBeVisible();

  // Wait for addedFeedback to clear (1s timeout) and the input to remount.
  await expect(app.getByRole("textbox", { name: "Quick add input" })).toBeVisible({
    timeout: 2000,
  });

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

appTest("!1 numeric priority maps to Urgent chip", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("blocker !1");
  await expect(dialog.getByRole("button", { name: "Priority: Urgent" })).toBeVisible({
    timeout: 2000,
  });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const item = app.locator("[data-page-list-item]").filter({ hasText: "blocker" });
  await expect(item).toBeVisible();
  await expect(item).not.toContainText("!1");
});

appTest("bare 'today' schedules the page for today", async ({ app }) => {
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();

  await app.getByRole("textbox", { name: "Quick add input" }).fill("lunch today");
  // The UI may display "Today" or a date like "Mar 15"; both are fine.
  await expect(dialog.getByRole("button", { name: /^Scheduled:/ })).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await expect(app.locator("[data-page-list-item]").filter({ hasText: "lunch" })).toBeVisible();
});

// Typing ~inbox, when Inbox isn't a real folder, stashes folderQuery "inbox", which the dialog routes to folderId=null.

appTest("~inbox folder query routes to Inbox", async ({ app }) => {
  await createFolder(app, "Notes");

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

appTest(
  "QuickAdd manual date override survives further typing",
  { tag: ["@QADD-09:4"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();

    const input = app.getByRole("textbox", { name: "Quick add input" });
    await input.fill("review tomorrow");
    await expect(dialog.getByRole("button", { name: /Scheduled:/ })).toBeVisible({ timeout: 2000 });

    await dialog.getByRole("button", { name: /Scheduled:/ }).click();
    await app.getByRole("button", { exact: true, name: "No date" }).click();
    await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();

    // A date in later text must not auto-fill the chip (manual override); the tag shows the parse fired.
    await input.fill("review tomorrow next week #work");
    await expect(dialog.getByRole("button", { name: /Tags: work/ })).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByRole("button", { name: "Set schedule" })).toBeVisible();
  }
);
