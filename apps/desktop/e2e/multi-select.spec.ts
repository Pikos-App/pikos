import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

/** Create multiple pages and return their locators. */
async function createPages(app: Page, titles: string[]) {
  for (const title of titles) {
    await quickAdd(app, title);
  }
}

// ─── Cmd+Click ─────────────────────────────────────────────────────────────

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

// ─── Shift+Click range ─────────────────────────────────────────────────────

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

// ─── Escape clears selection ───────────────────────────────────────────────

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

// ─── Cmd+A selects all visible ─────────────────────────────────────────────

appTest("Cmd+A selects all visible pages @tier2", async ({ app }) => {
  await createPages(app, ["sel-all-1", "sel-all-2", "sel-all-3"]);

  // Blur any focused input/editor so Cmd+A targets the page list
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  const items = app.locator("[data-page-list-item][data-selected=true]");
  // Should have at least 3 selected (the ones we just created)
  await expect(items).toHaveCount(3);
});

// ─── Cmd+Backspace bulk delete ─────────────────────────────────────────────

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

// ─── Plain click clears selection ──────────────────────────────────────────

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

  // Click into the editor content area
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  // Selection should be cleared
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});
