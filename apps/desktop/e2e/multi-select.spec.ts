import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

async function createPages(app: Page, titles: string[]) {
  for (const title of titles) {
    await quickAdd(app, title);
  }
}

async function createFolder(app: Page, name: string) {
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type(name);
  await app.keyboard.press("Enter");
}

// ─── Cmd+Click ─────────────────────────────────────────────────────────────

appTest("multi-select pages with Cmd+Click @tier2", async ({ app }) => {
  await createPages(app, ["alpha page", "beta page", "gamma page"]);

  const list = app.locator("[data-page-list-item]");
  const alpha = list.filter({ hasText: "alpha page" });
  const beta = list.filter({ hasText: "beta page" });
  const gamma = list.filter({ hasText: "gamma page" });

  await alpha.click();
  await expect(alpha).toHaveAttribute("data-active", "true");

  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).toHaveAttribute("data-selected", "true");

  await gamma.click({ modifiers: ["Meta"] });
  await expect(gamma).toHaveAttribute("data-selected", "true");

  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).not.toHaveAttribute("data-selected", "true");
  await expect(gamma).toHaveAttribute("data-selected", "true");
});

// ─── Shift+Click range ─────────────────────────────────────────────────────

appTest("multi-select range with Shift+Click @tier2", async ({ app }) => {
  await createPages(app, ["range-a", "range-b", "range-c", "range-d"]);

  const list = app.locator("[data-page-list-item]");
  const rangeA = list.filter({ hasText: "range-a" });
  const rangeB = list.filter({ hasText: "range-b" });
  const rangeC = list.filter({ hasText: "range-c" });
  const rangeD = list.filter({ hasText: "range-d" });

  // Plain click sets the range anchor; Shift+Click extends a→c.
  await rangeA.click();
  await rangeC.click({ modifiers: ["Shift"] });

  await expect(rangeA).toHaveAttribute("data-selected", "true");
  await expect(rangeB).toHaveAttribute("data-selected", "true");
  await expect(rangeC).toHaveAttribute("data-selected", "true");
  await expect(rangeD).not.toHaveAttribute("data-selected");
});

// ─── Escape clears selection ───────────────────────────────────────────────

appTest("Escape clears multi-selection @tier2", async ({ app }) => {
  await createPages(app, ["esc-page-1", "esc-page-2"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "esc-page-1" });
  const page2 = list.filter({ hasText: "esc-page-2" });

  await page1.click();
  await page2.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");

  await app.keyboard.press("Escape");

  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});

// ─── Cmd+A selects all visible ─────────────────────────────────────────────

appTest("Cmd+A selects all visible pages @tier2", async ({ app }) => {
  await createPages(app, ["sel-all-1", "sel-all-2", "sel-all-3"]);

  // Blur any focused input/editor so Cmd+A targets the page list
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  const items = app.locator("[data-page-list-item][data-selected=true]");
  await expect(items).toHaveCount(3);
});

// ─── Cmd+A then Space toggles all selected ────────────────────────────────

appTest("Cmd+A then Space marks all selected pages as completed @tier2", async ({ app }) => {
  const titles = ["space-bulk-1", "space-bulk-2", "space-bulk-3"];
  await createPages(app, titles);

  const list = app.locator("[data-page-list-item]");
  const selected = app.locator("[data-page-list-item][data-selected=true]");

  // Drop focus to <body> — this is the regression scenario where the inline
  // onKeyDown handler used to miss Space because the list panel wasn't focused.
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  await expect(selected).toHaveCount(3);

  await app.keyboard.press("Space");

  // All three pages should leave the visible (non-completed) list.
  for (const title of titles) {
    await expect(list.filter({ hasText: title })).not.toBeVisible();
  }

  // Selection should have been cleared by the toggle.
  await expect(selected).toHaveCount(0);

  // ...and every page is actually COMPLETED, not merely hidden — all three
  // surface in the Completed accordion with a "Mark not done" checkbox. This is
  // the core "complete ALL" guarantee: the bug dropped some completions to a
  // write-write race so they silently stayed open (QA §4). The bulk write does
  // every flip in one transaction, so none are left behind.
  await app.getByRole("button", { name: "Completed", exact: true }).click();
  for (const title of titles) {
    const item = list.filter({ hasText: title });
    await expect(item).toBeVisible();
    await expect(item.getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
  }
});

// ─── Cmd+A → Space completes all even with a folder row focused ─────────────
//
// The real user flow: click a folder in the sidebar, Cmd+A, Space. The folder
// row is role="button", so clicking it leaves focus there — and Space's `when`
// gate used to stand down for any focused interactive control, letting the
// folder row swallow the key (its own Enter/Space re-selects the folder) so
// nothing completed. Cmd+A now moves focus onto the (non-interactive) list, so
// the selection owns Space. The `body`-click test above sidesteps this by
// blurring first; this one keeps the folder focused on purpose.

appTest("Cmd+A then Space completes all with the folder row focused @tier2", async ({ app }) => {
  await createFolder(app, "Bulk QA");
  const titles = ["folder-bulk-1", "folder-bulk-2", "folder-bulk-3"];
  await createPages(app, titles);

  const list = app.locator("[data-page-list-item]");
  const selected = app.locator("[data-page-list-item][data-selected=true]");

  // Click the folder row so focus lands on it (role="button") — the exact
  // condition that used to eat Space.
  await app
    .getByRole("group", { name: "Views and folders" })
    .getByRole("button", { name: "Bulk QA", exact: true })
    .click();

  await app.keyboard.press(mod("Mod+a"));
  await expect(selected).toHaveCount(3);

  await app.keyboard.press("Space");

  // All three leave the active list and land in Completed — none swallowed.
  for (const title of titles) {
    await expect(list.filter({ hasText: title })).not.toBeVisible();
  }
  await expect(selected).toHaveCount(0);
});

// ─── Bulk complete partitions recurring pages out of the flip ──────────────
//
// A multi-selection can mix plain and recurring pages. Recurring completion
// clones the head + advances it (completeRecurringPage) — it must NOT be a
// plain status flip, which would mark the head done and corrupt the series.
// This guards `toggleSelected`'s partition end to end: plain pages flow through
// the transactional bulk write; the recurring head advances and stays open.

appTest(
  "Cmd+A then Space completes plain pages but advances a recurring one @tier2",
  async ({ app }) => {
    await createPages(app, ["bulk-plain-1", "bulk-plain-2"]);

    // A daily recurring head, anchored today → no missed-day gap, so completion
    // fast-paths (no dialog). Mirrors recurring.spec's quick-add setup.
    await app.keyboard.press(mod("Mod+n"));
    const dialog = app.getByRole("dialog", { name: "Quick add" });
    await expect(dialog).toBeVisible();
    await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
    await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
      timeout: 2000,
    });
    await app.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();

    const list = app.locator("[data-page-list-item]");
    const selected = app.locator("[data-page-list-item][data-selected=true]");

    await app.locator("body").click({ position: { x: 0, y: 0 } });
    await app.keyboard.press(mod("Mod+a"));
    await expect(selected).toHaveCount(3);

    await app.keyboard.press("Space");

    await expect(list.filter({ hasText: "bulk-plain-1" })).not.toBeVisible();
    await expect(list.filter({ hasText: "bulk-plain-2" })).not.toBeVisible();

    // The recurring head was NOT plain-completed: it advances to the next
    // occurrence and stays OPEN in the list. A regression that lumped recurring
    // pages into the bulk status flip would mark it done and remove it here.
    const standup = list.filter({ hasText: "standup" });
    await expect(standup).toHaveCount(1);
    await expect(standup.getByRole("checkbox", { name: /Mark done/i })).toBeVisible();
  }
);

// ─── Cmd+Backspace bulk delete ─────────────────────────────────────────────

appTest("bulk delete selected pages with Cmd+Backspace @tier2", async ({ app }) => {
  await createPages(app, ["del-bulk-1", "del-bulk-2", "del-bulk-3"]);

  const list = app.locator("[data-page-list-item]");

  await list.filter({ hasText: "del-bulk-1" }).click();
  await list.filter({ hasText: "del-bulk-3" }).click({ modifiers: ["Shift"] });

  await expect(list.filter({ hasText: "del-bulk-1" })).toHaveAttribute("data-selected", "true");
  await expect(list.filter({ hasText: "del-bulk-3" })).toHaveAttribute("data-selected", "true");

  await app.keyboard.press(mod("Mod+Backspace"));

  await expect(list.filter({ hasText: "del-bulk-1" })).not.toBeVisible();
  await expect(list.filter({ hasText: "del-bulk-2" })).not.toBeVisible();
  await expect(list.filter({ hasText: "del-bulk-3" })).not.toBeVisible();
});

// ─── Plain click clears selection ──────────────────────────────────────────

appTest("plain click clears multi-selection @tier2", async ({ app }) => {
  await createPages(app, ["clear-sel-1", "clear-sel-2", "clear-sel-3"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "clear-sel-1" });
  const page2 = list.filter({ hasText: "clear-sel-2" });
  const page3 = list.filter({ hasText: "clear-sel-3" });

  await page1.click();
  await page3.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");
  await expect(page3).toHaveAttribute("data-selected", "true");

  await page2.click();
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
  await expect(page3).not.toHaveAttribute("data-selected");
  await expect(page2).toHaveAttribute("data-active", "true");
});

// ─── Clicking into editor clears selection ─────────────────────────────────

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

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});
