import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

/** Create a folder via the toolbar's New Folder button + inline rename. */
async function createFolder(app: Page, name: string) {
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type(name);
  await app.keyboard.press("Enter");
}

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

// ─── Drag a folder to reorder ───────────────────────────────────────────────
//
// useThreePanelDnD's `at === "folder" && ot === "folder"` branch handles
// folder→folder reordering via arrayMove. Manual sort (the default) shows
// folders in the workspace's intrinsic order, so a drag should swap the
// rendered position. A regression that ignored the drop event would
// silently leave the order untouched.

appTest("drag a folder to reorder its position in the sidebar @tier1", async ({ app }) => {
  // Seed three folders. New folders are inserted at the top of the list, so
  // creating in order Alpha → Beta → Gamma yields [Gamma, Beta, Alpha] in
  // the sidebar. Read the actual order before asserting reorder semantics.
  await createFolder(app, "Alpha");
  await createFolder(app, "Beta");
  await createFolder(app, "Gamma");

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folderItems = sidebar.locator('[role="button"][aria-label="Alpha"], [role="button"][aria-label="Beta"], [role="button"][aria-label="Gamma"]');
  // Sanity: all three rendered.
  await expect(folderItems).toHaveCount(3);

  // Capture initial top→bottom names so we can assert the order changed,
  // not assume a specific insert direction.
  async function readOrder(): Promise<string[]> {
    const names: string[] = [];
    const count = await folderItems.count();
    for (let i = 0; i < count; i++) {
      names.push((await folderItems.nth(i).getAttribute("aria-label")) ?? "");
    }
    return names;
  }
  const initial = await readOrder();
  expect(initial).toHaveLength(3);

  // Drag the LAST folder to the FIRST folder's position. dnd-kit activation
  // is 8 px — nudge before moving onto the target.
  const lastFolder = sidebar.getByRole("button", { name: initial[2]!, exact: true });
  const firstFolder = sidebar.getByRole("button", { name: initial[0]!, exact: true });
  const lastBox = await lastFolder.boundingBox();
  const firstBox = await firstFolder.boundingBox();
  if (!lastBox || !firstBox) throw new Error("folder box missing");

  await app.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
  await app.mouse.down();
  // Move up to cross the activation threshold, then onto the first folder.
  await app.mouse.move(
    lastBox.x + lastBox.width / 2,
    lastBox.y + lastBox.height / 2 - 16,
    { steps: 4 }
  );
  await app.mouse.move(
    firstBox.x + firstBox.width / 2,
    firstBox.y + firstBox.height / 2,
    { steps: 10 }
  );
  await app.mouse.up();

  // The reorder is an optimistic update after dragEnd — DOM updates a tick
  // later. Wait for the leading folder to flip; otherwise readOrder() may
  // race the post-drop render.
  await expect
    .poll(async () => (await folderItems.first().getAttribute("aria-label")) ?? "")
    .not.toBe(initial[0]);

  const reordered = await readOrder();
  expect(reordered).toHaveLength(3);
  // Same three folders, different order. Compare on copies because
  // Array.prototype.sort mutates in place. Specifics of arrayMove aren't
  // pinned — we lock down the contract that drag actually re-arranged the list.
  expect([...reordered].sort()).toEqual([...initial].sort());
  expect(reordered).not.toEqual(initial);
});
