import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

/** Create multiple pages and return their locators. */
async function createPages(app: Page, titles: string[]) {
  for (const title of titles) {
    await quickAdd(app, title);
  }
}

// ─── T2-1: Find in page (Cmd+F) ────────────────────────────────────────────

appTest("find in page highlights matches @tier2", async ({ app }) => {
  await quickAdd(app, "search test page");

  // Open the page and type some content
  await app.locator("[data-page-list-item]").getByText("search test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("The quick brown fox jumps over the lazy fox");

  // Open find popover
  await app.keyboard.press(mod("Mod+f"));

  // Find bar should appear with input focused
  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toBeVisible();
  await expect(findInput).toBeFocused();

  // Type a search query
  await findInput.fill("fox");

  // Match count should show 2 matches
  await expect(app.getByText("1 of 2")).toBeVisible();

  // Highlight decorations should be present in the editor
  const highlights = editor.locator(".find-match");
  await expect(highlights).toHaveCount(2);

  // Active highlight should be on the first match
  const activeHighlight = editor.locator(".find-match-active");
  await expect(activeHighlight).toHaveCount(1);

  // Navigate to next match via Enter
  await app.keyboard.press("Enter");
  await expect(app.getByText("2 of 2")).toBeVisible();

  // Navigate back via Shift+Enter
  await app.keyboard.press("Shift+Enter");
  await expect(app.getByText("1 of 2")).toBeVisible();

  // Close via Escape — highlights should clear
  await app.keyboard.press("Escape");
  await expect(findInput).not.toBeVisible();
  await expect(editor.locator(".find-match")).toHaveCount(0);
});

// ─── T2-2: Find in page with no matches ─────────────────────────────────────

appTest("find in page shows zero matches @tier2", async ({ app }) => {
  await quickAdd(app, "empty search page");

  await app.locator("[data-page-list-item]").getByText("empty search page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("Hello world");

  await app.keyboard.press(mod("Mod+f"));
  const findInput = app.getByPlaceholder("Find…");
  await findInput.fill("xyz");

  await expect(app.getByText("0 of 0")).toBeVisible();
  await expect(editor.locator(".find-match")).toHaveCount(0);
});

// ─── T2-3: Find in page prefills selected text ──────────────────────────────

appTest("find in page prefills selected text @tier2", async ({ app }) => {
  await quickAdd(app, "prefill test page");

  await app.locator("[data-page-list-item]").getByText("prefill test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("hello world");

  // Select "world" (5 chars) via Shift+ArrowLeft from end of line
  for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowLeft");

  // Open find — should prefill with selected text
  await app.keyboard.press(mod("Mod+f"));
  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toHaveValue("world");
  await expect(app.getByText("1 of 1")).toBeVisible();
});

// ─── T2-4: Multi-select with Cmd+Click ──────────────────────────────────────

appTest("multi-select pages with Cmd+Click @tier2", async ({ app }) => {
  await createPages(app, ["alpha page", "beta page", "gamma page"]);

  const list = app.locator("[data-page-list-item]");
  const alpha = list.filter({ hasText: "alpha page" });
  const beta = list.filter({ hasText: "beta page" });
  const gamma = list.filter({ hasText: "gamma page" });

  // Click alpha to select it
  await alpha.click();
  await expect(alpha).toHaveAttribute("data-active", "true");

  // Cmd+Click beta and gamma to add to selection
  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).toHaveAttribute("data-selected", "true");

  await gamma.click({ modifiers: ["Meta"] });
  await expect(gamma).toHaveAttribute("data-selected", "true");

  // Cmd+Click beta again to deselect it
  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).not.toHaveAttribute("data-selected", "true");

  // Gamma should still be selected
  await expect(gamma).toHaveAttribute("data-selected", "true");
});

// ─── T2-5: Multi-select with Shift+Click (range) ───────────────────────────

appTest("multi-select range with Shift+Click @tier2", async ({ app }) => {
  await createPages(app, ["range-a", "range-b", "range-c", "range-d"]);

  const list = app.locator("[data-page-list-item]");
  const rangeA = list.filter({ hasText: "range-a" });
  const rangeB = list.filter({ hasText: "range-b" });
  const rangeC = list.filter({ hasText: "range-c" });
  const rangeD = list.filter({ hasText: "range-d" });

  // Click range-a to set anchor
  await rangeA.click();

  // Shift+Click range-c to select range a-c
  await rangeC.click({ modifiers: ["Shift"] });

  await expect(rangeA).toHaveAttribute("data-selected", "true");
  await expect(rangeB).toHaveAttribute("data-selected", "true");
  await expect(rangeC).toHaveAttribute("data-selected", "true");
  // range-d should not be selected
  await expect(rangeD).not.toHaveAttribute("data-selected");
});

// ─── T2-6: Escape clears multi-selection ────────────────────────────────────

appTest("Escape clears multi-selection @tier2", async ({ app }) => {
  await createPages(app, ["esc-page-1", "esc-page-2"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "esc-page-1" });
  const page2 = list.filter({ hasText: "esc-page-2" });

  // Shift+Click range to select both
  await page1.click();
  await page2.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");

  // Escape clears selection (global shortcut)
  await app.keyboard.press("Escape");

  // Selection should be cleared
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});

// ─── T2-7: Cmd+A selects all visible pages ─────────────────────────────────

appTest("Cmd+A selects all visible pages @tier2", async ({ app }) => {
  await createPages(app, ["sel-all-1", "sel-all-2", "sel-all-3"]);

  // Blur any focused input/editor so Cmd+A targets the page list
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  const items = app.locator("[data-page-list-item][data-selected=true]");
  // Should have at least 3 selected (the ones we just created)
  await expect(items).toHaveCount(3);
});

// ─── T2-8: Bulk delete with Cmd+Backspace ──────────────────────────────────

appTest("bulk delete selected pages with Cmd+Backspace @tier2", async ({ app }) => {
  await createPages(app, ["del-bulk-1", "del-bulk-2", "del-bulk-3"]);

  const list = app.locator("[data-page-list-item]");

  // Select first, then Shift+Click last to range-select all three
  await list.filter({ hasText: "del-bulk-1" }).click();
  await list.filter({ hasText: "del-bulk-3" }).click({ modifiers: ["Shift"] });

  // Verify all three are selected
  await expect(list.filter({ hasText: "del-bulk-1" })).toHaveAttribute("data-selected", "true");
  await expect(list.filter({ hasText: "del-bulk-3" })).toHaveAttribute("data-selected", "true");

  // Bulk delete
  await app.keyboard.press(mod("Mod+Backspace"));

  // All three should be gone
  await expect(list.filter({ hasText: "del-bulk-1" })).not.toBeVisible();
  await expect(list.filter({ hasText: "del-bulk-2" })).not.toBeVisible();
  await expect(list.filter({ hasText: "del-bulk-3" })).not.toBeVisible();
});

// ─── T2-9: Plain click clears multi-selection ──────────────────────────────

appTest("plain click clears multi-selection @tier2", async ({ app }) => {
  await createPages(app, ["clear-sel-1", "clear-sel-2", "clear-sel-3"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "clear-sel-1" });
  const page2 = list.filter({ hasText: "clear-sel-2" });
  const page3 = list.filter({ hasText: "clear-sel-3" });

  // Range-select all three
  await page1.click();
  await page3.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");
  await expect(page3).toHaveAttribute("data-selected", "true");

  // Plain click on page2 — should clear selection and activate only page2
  await page2.click();
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
  await expect(page3).not.toHaveAttribute("data-selected");
  await expect(page2).toHaveAttribute("data-active", "true");
});

// ─── T2-10: Clicking into editor clears multi-selection ─────────────────────

appTest("clicking into editor clears multi-selection @tier2", async ({ app }) => {
  await createPages(app, ["editor-clr-1", "editor-clr-2"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "editor-clr-1" });
  const page2 = list.filter({ hasText: "editor-clr-2" });

  // Select page1 (activates it + opens editor), then Shift+Click page2
  await page1.click();
  await page2.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");

  // Click into the editor content area
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  // Selection should be cleared
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});

// ─── T2-10: Recurring page creation via QuickAdd ───────────────────────────

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

// ─── T2-11: Create folder inline from FolderChip in QuickAdd ────────────────

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

// ─── T2-12: Bounded recurrence round-trip (NLP → 1 page + rrule) ────────────
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

// ─── T2-13: Default-daily round-trip ("N times" with no cadence) ────────────
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

// ─── T2-14: Finite bulk create (m/w/f → 3 separate pages) ───────────────────
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
  await expect(
    dialog.getByRole("button", { name: /Recurrence: 3 occurrences/i })
  ).toBeVisible({ timeout: 2000 });

  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  // Three separate pages, one per scheduled weekday.
  const pages = app.locator("[data-page-list-item]").filter({ hasText: "swim" });
  await expect(pages).toHaveCount(3);
});

// ─── T2-15: Manual chip override survives continued NLP typing ──────────────
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
