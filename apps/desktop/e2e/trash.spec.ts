// The trash — the surface that made a soft delete recoverable after the undo
// toast is gone. Before it, "Delete" put a row on disk that nothing in the app
// could ever reach again.
//
// Sandbox note: this spec has not been run here — the container has no WebKit
// build, so Playwright cannot launch. It is written against the same fixtures
// and locator idioms as pages.spec.ts.

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

// ─── tier2: a delete survives the toast and comes back ───────────────────────

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

    // The panel is a view, so leaving it is a navigation rather than a dismissal.
    await app.getByRole("button", { name: /^Inbox/ }).click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "notes from the offsite" })
    ).toBeVisible();
  }
);

// ─── tier2: emptying the trash ───────────────────────────────────────────────

appTest("emptying the trash destroys what was in it", async ({ app }) => {
  await quickAdd(app, "draft to abandon");
  await deleteAndLetUndoLapse(app, "draft to abandon");

  await openTrash(app);
  await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText("draft to abandon");

  await app.getByRole("button", { name: "Empty trash" }).click();
  // Typed confirmation — the action names no page, so the phrase is the guard.
  await app.getByRole("textbox").fill("delete");
  await app.getByRole("alertdialog").getByRole("button", { name: "Empty trash" }).click();

  await expect(app.getByText("The trash is empty.")).toBeVisible();

  // And it stays gone: leaving and coming back reads the database, not a cached list.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await openTrash(app);
  await expect(app.getByText("The trash is empty.")).toBeVisible();
});

// ─── tier2: the trash takes the column without taking its behaviour ──────────

// Both halves of one cause: the trash is its own panel, so opening it unmounts the
// page list. The list caught up only on the way back in, and the delete shortcut —
// registered inside the list — stopped working exactly where a user reaches for it.
appTest(
  "the trash stays live and the delete shortcut survives it",
  async ({ app }) => {
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

    // No navigation between the delete and the assertion — the row arriving is the
    // part that used to wait for a trip out of the view and back.
    await expect(trash).toContainText("deleted while looking at the bin");
  }
);
