import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Open page and edit content ────────────────────────────────────────────

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

// ─── Complete a page (toggle status) ───────────────────────────────────────

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

// ─── Delete a page and undo ────────────────────────────────────────────────

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

// ─── Move page to folder via context menu ──────────────────────────────────

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
