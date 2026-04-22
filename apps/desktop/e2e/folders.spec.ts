import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Create and navigate folders ───────────────────────────────────────────

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
