import { expect, test } from "@playwright/test";

import { quickAdd, test as appTest } from "./fixtures";

// ─── T1-1: App boots to welcome screen ──────────────────────────────────────

test("app boots to welcome screen @tier1", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /get started/i })).toBeVisible();
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.locator("[data-testid=three-panel-layout]")).toBeVisible();
});

// ─── T1-2: Create page via Quick Add (Cmd+N) ────────────────────────────────

appTest("create page via Quick Add @tier1", async ({ app }) => {
  await app.keyboard.press("Meta+n");
  await expect(app.getByRole("dialog")).toBeVisible();

  const input = app.getByPlaceholder(/what's on your mind/i);
  await expect(input).toBeFocused();

  await input.fill("team meeting @tomorrow at 2pm #work");
  // Wait for NLP debounce to produce chips
  await app.waitForTimeout(300);

  await app.keyboard.press("Enter");
  await expect(app.getByRole("dialog")).not.toBeVisible();

  // Page appears in page list
  await expect(app.locator("[data-page-list-item]").getByText("team meeting")).toBeVisible();
});

// ─── T1-3: Open page and edit content ────────────────────────────────────────

appTest("open page and edit content @tier1", async ({ app }) => {
  await quickAdd(app, "my test page");

  // Click the page in the list
  await app.locator("[data-page-list-item]").getByText("my test page").click();

  // Click into the Tiptap editor area and type
  const editor = app.locator(".tiptap");
  await editor.click();
  await app.keyboard.type("Hello world");
  await expect(editor).toContainText("Hello world");
});

// ─── T1-4: Complete a page (toggle status) ───────────────────────────────────

appTest("complete a page via status toggle @tier1", async ({ app }) => {
  await quickAdd(app, "task to complete");

  // Find the page and click its status checkbox
  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "task to complete" });
  await expect(pageItem).toBeVisible();

  await pageItem.getByRole("button", { name: "Mark done" }).click();

  // Page should no longer appear in the active list (it moves to completed section)
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "task to complete" }).getByRole("button", { name: "Mark not done" })
  ).toBeVisible();
});

// ─── T1-5: Create and navigate folders ───────────────────────────────────────

appTest("create and navigate folders @tier1", async ({ app }) => {
  // Click "New Folder" button in sidebar
  await app.getByRole("button", { name: "New Folder" }).click();

  // Folder appears in sidebar (default name is "New Folder")
  const folderItem = app.getByRole("button", { name: /New Folder/i }).first();
  await expect(folderItem).toBeVisible();

  // Click the folder in sidebar to navigate
  await folderItem.click();

  // Page list should show empty state for that folder
  // Create a page — it should appear in the current folder's list
  await quickAdd(app, "folder page");
  await expect(app.locator("[data-page-list-item]").getByText("folder page")).toBeVisible();
});

// ─── T1-6: Today view shows scheduled pages ─────────────────────────────────

appTest("today view shows scheduled pages @tier1", async ({ app }) => {
  await quickAdd(app, "today task @today");

  // Click "Today" in sidebar
  await app.locator("#nav-today").click();

  // Page visible in Today view
  await expect(app.locator("[data-page-list-item]").getByText("today task")).toBeVisible();
});

// ─── T1-7: Delete a page ─────────────────────────────────────────────────────

appTest("delete a page @tier1", async ({ app }) => {
  await quickAdd(app, "page to delete");

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "page to delete" });
  await expect(pageItem).toBeVisible();

  // Right-click to open context menu
  await pageItem.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();

  // Confirm deletion in dialog
  const dialog = app.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();

  // Page removed from list
  await expect(pageItem).not.toBeVisible();
});

// ─── T1-8: Toggle editor ↔ calendar (Cmd+Shift+C) ──────────────────────────

appTest("toggle editor and calendar view @tier1", async ({ app }) => {
  await quickAdd(app, "calendar test @today at 2pm for 1h");

  // Editor panel should be visible by default
  await expect(app.getByRole("button", { name: "Editor view" })).toBeVisible();

  // Toggle to calendar
  await app.keyboard.press("Meta+Shift+c");
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  // Toggle back to editor
  await app.keyboard.press("Meta+Shift+c");
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
});
