import { expect, test } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── T1-1: App boots directly to workspace ──────────────────────────────────

test("app boots directly to workspace @tier1", async ({ page }) => {
  await page.goto("/");
  // Workspace auto-creates on first launch — no welcome screen
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
});

// ─── T1-2: Create page via Quick Add (Cmd+N) ────────────────────────────────

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

// ─── T1-3: Open page and edit content ────────────────────────────────────────

appTest("open page and edit content @tier1", async ({ app }) => {
  await quickAdd(app, "my test page");
  await quickAdd(app, "other page");

  // Click the page in the list and verify it's active
  await app.locator("[data-page-list-item]").getByText("my test page").click();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "my test page"
  );

  // Edit the title — title renders as a div when unfocused, textarea when focused.
  // Click the div to enter edit mode, then select all and retype.
  const titleDisplay = app.getByLabel("Page title");
  await expect(titleDisplay).toHaveText("my test page");
  await titleDisplay.click();
  await app.waitForTimeout(100); // let onFocus rAF complete
  const titleInput = app.getByRole("textbox", { name: "Page title" });
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("renamed page");
  await expect(titleInput).toHaveValue("renamed page");

  // Title change reflects in the page list
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "renamed page"
  );

  // Add a description — same div/textarea pattern
  const descDisplay = app.getByLabel("Page description");
  await descDisplay.click();
  const descInput = app.getByRole("textbox", { name: "Page description" });
  await app.keyboard.type("A short summary");
  await expect(descInput).toHaveValue("A short summary");

  // Edit body content
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("Hello world");
  await expect(editor).toContainText("Hello world");

  // Navigate away and back — all changes should persist (autosave)
  await app.locator("[data-page-list-item]").getByText("other page").click();
  await app.locator("[data-page-list-item]").getByText("renamed page").click();
  await expect(app.getByLabel("Page title")).toHaveText("renamed page");
  await expect(app.getByLabel("Page description")).toHaveText("A short summary");
  await expect(editor).toContainText("Hello world");
});

// ─── T1-4: Complete a page (toggle status) ───────────────────────────────────

appTest("complete a page via status toggle @tier1", async ({ app }) => {
  await quickAdd(app, "task to complete");

  // Find the page and click its status checkbox
  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "task to complete" });
  await expect(pageItem).toBeVisible();

  await pageItem.getByRole("checkbox", { name: "Mark done" }).click();

  // Task leaves the active list
  await expect(pageItem).not.toBeVisible();

  // Completed section toggle is always visible
  const completedToggle = app.getByRole("button", { name: /Completed/ });
  await expect(completedToggle).toBeVisible();

  // Expand completed section — page should be inside
  await completedToggle.click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "task to complete" })
  ).toBeVisible();
});

// ─── T1-5: Create and navigate folders ───────────────────────────────────────

appTest("create and navigate folders @tier1", async ({ app }) => {
  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folderBtn = sidebar.getByRole("button", { name: "Projects", exact: true });

  // Click "New Folder" — creates folder, navigates to it, and enters rename mode
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();

  // Rename mode is active with input focused — select all, type new name, commit
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("Projects");
  await app.keyboard.press("Enter");

  // Folder appears in sidebar with its new name and is the active view
  await expect(folderBtn).toHaveAttribute("aria-current", "true");

  // Page list should show empty state (new folder has no pages)
  await expect(app.getByText("No pages")).toBeVisible();

  // Create a page — it lands in the current folder
  await quickAdd(app, "folder page");
  await expect(app.locator("[data-page-list-item]").getByText("folder page")).toBeVisible();

  // Navigate to Inbox — the page should NOT appear there
  await app.getByRole("button", { name: /Inbox/ }).click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "folder page" })
  ).not.toBeVisible();

  // Delete the folder — right-click → Delete — no confirmation dialog, just undo toast
  await folderBtn.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();

  // Folder is gone from sidebar, undo toast appears
  await expect(folderBtn).not.toBeVisible();
  const toast = app.getByRole("alert", { name: /Projects/ });
  await expect(toast).toBeVisible();

  // Child pages are soft-deleted (not moved to Inbox)
  await app.getByRole("button", { name: /Inbox/ }).click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "folder page" })
  ).not.toBeVisible();

  // Undo restores folder and its pages
  await toast.getByRole("button", { name: /Undo/ }).click();
  await expect(folderBtn).toBeVisible();
  await folderBtn.click();
  await expect(app.locator("[data-page-list-item]").getByText("folder page")).toBeVisible();
});

// ─── T1-6: Today view shows scheduled pages ─────────────────────────────────

appTest("today view shows scheduled pages @tier1", async ({ app }) => {
  await quickAdd(app, "my scheduled task @today");
  await quickAdd(app, "unscheduled task");

  // Navigate to Today view
  await app.getByRole("button", { name: /Today/ }).click();

  // Scheduled page appears
  await expect(app.locator("[data-page-list-item]").getByText("my scheduled task")).toBeVisible();

  // Unscheduled page does not
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "unscheduled task" })
  ).not.toBeVisible();
});

// ─── T1-7: Delete a page and undo ────────────────────────────────────────────

appTest("delete a page and undo @tier1", async ({ app }) => {
  await quickAdd(app, "page to delete");

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "page to delete" });
  await expect(pageItem).toBeVisible();

  // Right-click to open context menu
  await pageItem.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();

  // Page disappears, undo toast confirms the deletion
  await expect(pageItem).not.toBeVisible();
  const toast = app.getByRole("alert", { name: /page to delete/ });
  await expect(toast).toBeVisible();

  // Undo restores the page
  await toast.getByRole("button", { name: /Undo delete/ }).click();
  await expect(pageItem).toBeVisible();
});

// ─── T1-8: Toggle editor ↔ calendar (Cmd+Shift+C) ───────────────────────────

appTest("toggle editor and calendar view @tier1", async ({ app }) => {
  const editorBtn = app.getByRole("button", { name: "Editor view" });
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });

  // Editor is active by default
  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "false");

  // Toggle to calendar
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "true");
  await expect(editorBtn).toHaveAttribute("aria-pressed", "false");

  // Toggle back to editor
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
});

// ─── T1-9: Search pages (Cmd+K) ──────────────────────────────────────────────

appTest("search pages via Cmd+K @tier1", async ({ app }) => {
  await quickAdd(app, "alpha project");
  await quickAdd(app, "beta report");
  await quickAdd(app, "gamma notes");

  // Open search palette
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  // Type a query
  await app.keyboard.type("beta");

  // Matching result appears, non-matching filtered out
  await expect(dialog.getByText("beta report")).toBeVisible();
  await expect(dialog.getByText("alpha project")).not.toBeVisible();

  // Select the result via Enter
  await app.keyboard.press("Enter");

  // Dialog closes and page is active in the list
  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "beta report"
  );
});

// ─── T1-10: Move page to folder via context menu ─────────────────────────────

appTest("move page to folder via context menu @tier1", async ({ app }) => {
  // Create a folder and rename it
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("Work");
  await app.keyboard.press("Enter");

  // Navigate to Inbox and create a page
  await app.getByRole("button", { name: /Inbox/ }).click();
  await quickAdd(app, "movable page");

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "movable page" });
  await expect(pageItem).toBeVisible();

  // Right-click → Move to Folder → select the folder
  await pageItem.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Move to Folder" }).click();
  await app.getByRole("menuitem", { name: /Work/ }).click();

  // Page disappears from Inbox
  await expect(pageItem).not.toBeVisible();

  // Navigate to the folder — page should be there
  await app.getByRole("button", { name: "Work" }).click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "movable page" })
  ).toBeVisible();
});

// ─── T1-11: Sidebar collapse and expand ──────────────────────────────────────

appTest("sidebar collapse and expand @tier1", async ({ app }) => {
  // Sidebar should be visible by default
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  // Collapse sidebar
  await app.getByRole("button", { name: "Collapse sidebar" }).click();

  // Button label changes to "Expand sidebar" — proves state toggled
  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // Expand sidebar back
  await app.getByRole("button", { name: "Expand sidebar" }).click();

  // Button label returns and Inbox reappears — proves the round-trip works
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(app.getByRole("button", { name: /Inbox/ })).toBeVisible();
});
