// The trash: where a soft delete stays recoverable once the undo toast is gone.

import { expect } from "@playwright/test";

import { test as appTest, mod, quickAdd } from "./fixtures";

/** Delete through the row's context menu, then let the undo toast expire the
 *  way it does for a user who walks away — which is the state the trash exists
 *  for. Dismissing it by hand would be the same soft delete, but waiting is
 *  what proves the page is only reachable through the trash afterwards. */
async function deleteAndLetUndoLapse(app: Parameters<typeof quickAdd>[0], title: string) {
  const row = app.locator("[data-page-list-item]").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  await expect(row).not.toBeVisible();
  const toast = app.getByRole("alert", { name: new RegExp(title) });
  await expect(toast).toBeVisible();
  await expect(toast).not.toBeVisible({ timeout: 15_000 });
}

function openTrash(app: Parameters<typeof quickAdd>[0]) {
  // exact: the panel's own "Empty trash" button also matches otherwise.
  return app.getByRole("button", { exact: true, name: "Trash" }).click();
}

appTest(
  "a deleted page waits in the trash and restores from it",
  { tag: ["@TRASH-04"] },
  async ({ app }) => {
    await quickAdd(app, "notes from the offsite");
    await deleteAndLetUndoLapse(app, "notes from the offsite");

    await openTrash(app);
    const trash = app.getByRole("list", { name: "Deleted pages" });
    await expect(trash).toContainText("notes from the offsite");
    await expect(trash).toContainText("Deleted today");

    await app.getByRole("button", { name: "Restore notes from the offsite" }).click();

    // Back in the live list without a reload — restore goes through the same
    // re-read the undo toast uses.
    await expect(app.getByText("The trash is empty.")).toBeVisible();

    await app.getByRole("button", { name: /^Inbox/ }).click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "notes from the offsite" })
    ).toBeVisible();
  }
);

appTest("emptying the trash destroys what was in it", async ({ app }) => {
  await quickAdd(app, "draft to abandon");
  await deleteAndLetUndoLapse(app, "draft to abandon");

  await openTrash(app);
  await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText("draft to abandon");

  await app.getByRole("button", { name: "Empty trash" }).click();
  await app.getByRole("alertdialog").getByRole("button", { name: "Empty trash" }).click();

  await expect(app.getByText("The trash is empty.")).toBeVisible();

  // And it stays gone: leaving and coming back reads the database, not a cached list.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await openTrash(app);
  await expect(app.getByText("The trash is empty.")).toBeVisible();
});

// The trash is its own panel, so opening it unmounts the page list; the delete shortcut,
// registered inside the list, must still work there.
appTest("the trash stays live and the delete shortcut survives it", async ({ app }) => {
  await quickAdd(app, "already in the bin");
  await deleteAndLetUndoLapse(app, "already in the bin");
  await quickAdd(app, "deleted while looking at the bin");

  await openTrash(app);
  const trash = app.getByRole("list", { name: "Deleted pages" });
  await expect(trash).toContainText("already in the bin");

  // Open the page the shortcut will act on, without leaving the trash view: the
  // editor keeps an active page whichever panel holds the middle column.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await app
    .locator("[data-page-list-item]")
    .filter({ hasText: "deleted while looking at the bin" })
    .click();
  await openTrash(app);

  await app.keyboard.press(mod("Mod+Shift+Backspace"));

  // No navigation between the delete and the assertion: the row must arrive without leaving the view.
  await expect(trash).toContainText("deleted while looking at the bin");
});
