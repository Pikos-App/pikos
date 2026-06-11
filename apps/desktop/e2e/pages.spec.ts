import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Open page and edit content ────────────────────────────────────────────

appTest("open page and edit content @tier1", async ({ app }) => {
  await quickAdd(app, "my test page");
  await quickAdd(app, "other page");

  await app.locator("[data-page-list-item]").getByText("my test page").click();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "my test page"
  );

  // Edit the title — title renders as a div when unfocused, textarea when focused.
  // Click the div to enter edit mode, then select all and retype.
  const titleDisplay = app.getByLabel("Page title");
  await expect(titleDisplay).toHaveText("my test page");
  await titleDisplay.click();
  // Wait for edit mode — the textbox replaces the display div on focus.
  const titleInput = app.getByRole("textbox", { name: "Page title" });
  await expect(titleInput).toBeFocused();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("renamed page");
  await expect(titleInput).toHaveValue("renamed page");

  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "renamed page"
  );

  // Add a description — same div/textarea pattern
  const descDisplay = app.getByLabel("Page description");
  await descDisplay.click();
  const descInput = app.getByRole("textbox", { name: "Page description" });
  await app.keyboard.type("A short summary");
  await expect(descInput).toHaveValue("A short summary");

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

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "task to complete" });
  await expect(pageItem).toBeVisible();

  await pageItem.getByRole("checkbox", { name: "Mark done" }).click();

  await expect(pageItem).not.toBeVisible();

  // Completed section toggle is always visible
  const completedToggle = app.getByRole("button", { name: /Completed/ });
  await expect(completedToggle).toBeVisible();

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

  await pageItem.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();

  await expect(pageItem).not.toBeVisible();
  const toast = app.getByRole("alert", { name: /page to delete/ });
  await expect(toast).toBeVisible();

  // Undo restores the page. The toast's action button is labelled "Undo"
  // (see UndoDeleteContext.requestDeletePage), not "Undo delete".
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(pageItem).toBeVisible();
});

// ─── Move page to folder via context menu ──────────────────────────────────

appTest("move page to folder via context menu @tier1", async ({ app }) => {
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.type("Work");
  await app.keyboard.press("Enter");

  // Create the page from Inbox — quickAdd lands pages in the active view's folder.
  await app.getByRole("button", { name: /Inbox/ }).click();
  await quickAdd(app, "movable page");

  const pageItem = app.locator("[data-page-list-item]").filter({ hasText: "movable page" });
  await expect(pageItem).toBeVisible();

  await pageItem.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Move to Folder" }).click();
  await app.getByRole("menuitem", { name: /Work/ }).click();

  await expect(pageItem).not.toBeVisible();

  await app.getByRole("button", { name: "Work" }).click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "movable page" })
  ).toBeVisible();
});

// ─── Drag-to-reorder within the page list ───────────────────────────────────
//
// useThreePanelDnD's `at === "page" && ot === "page"` branch handles page
// reordering inside a folder/inbox via the SortableContext over the
// page-list rows. This is distinct from `folders.spec.ts:drag a folder to
// reorder` which exercises the sidebar's folder list. Reorder only commits
// in manual sort mode — the default sort is by date, so we switch first.
// A regression in the sortable wiring would leave drag-reorder silently
// failing inside the page list even though folders still rearrange.

appTest("drag a page above another reorders the page list @tier2", async ({ app }) => {
  await quickAdd(app, "alpha task");
  await quickAdd(app, "bravo task");
  await quickAdd(app, "charlie task");

  // Switch the active view's sort mode to Manual — reorder is a no-op
  // otherwise (the list is sorted automatically in other modes).
  await app.getByRole("button", { name: /^Sort:/ }).click();
  await app.getByRole("menuitem", { name: "Manual" }).click();
  await expect(app.getByRole("button", { name: "Sort: manual" })).toBeVisible();

  // Capture the initial order. Manual sort defaults to creation order
  // (newest first or oldest first depending on the build) — either way the
  // post-drag order must differ.
  const items = app.locator("[data-page-list-item]");
  await expect(items).toHaveCount(3);
  const before = await items.allInnerTexts();

  // Drag the last visible item onto the first item. dnd-kit's PointerSensor
  // needs ≥8 px of motion before activation, so nudge before targeting.
  const source = items.last();
  const target = items.first();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("page list items missing bounding boxes");

  await app.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await app.mouse.down();
  await app.mouse.move(sourceBox.x + sourceBox.width / 2 + 16, sourceBox.y + sourceBox.height / 2, {
    steps: 4,
  });
  // Aim for the top half of the target so the drop slot resolves above it.
  await app.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 4, { steps: 10 });
  await app.mouse.up();

  const after = await items.allInnerTexts();
  expect(after).not.toEqual(before);
  // The dragged title (last in `before`) is now first.
  const formerLastTitle = before[before.length - 1]!.trim().split("\n")[0]!;
  expect(after[0]!.trim().split("\n")[0]).toBe(formerLastTitle);
});
