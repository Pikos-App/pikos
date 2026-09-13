// The trash — the surface that made a soft delete recoverable after the undo
// toast is gone. Before it, "Delete" put a row on disk that nothing in the app
// could ever reach again.
//
// Sandbox note: this spec has not been run here — the container has no WebKit
// build, so Playwright cannot launch. It is written against the same fixtures
// and locator idioms as pages.spec.ts.

import { expect } from "@playwright/test";

import { quickAdd, test as appTest } from "./fixtures";

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
  // exact: the panel's own "Empty Trash" button also matches otherwise.
  return app.getByRole("button", { exact: true, name: "Trash" }).click();
}

// ─── tier2: a delete survives the toast and comes back ───────────────────────

appTest("a deleted page waits in the trash and restores from it @tier2", async ({ app }) => {
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
});

// ─── tier2: emptying the trash ───────────────────────────────────────────────

appTest("emptying the trash destroys what was in it @tier2", async ({ app }) => {
  await quickAdd(app, "draft to abandon");
  await deleteAndLetUndoLapse(app, "draft to abandon");

  await openTrash(app);
  await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText("draft to abandon");

  await app.getByRole("button", { name: "Empty Trash" }).click();
  // Typed confirmation — the action names no page, so the phrase is the guard.
  await app.getByRole("textbox").fill("delete");
  await app.getByRole("alertdialog").getByRole("button", { name: "Empty Trash" }).click();

  await expect(app.getByText("The trash is empty.")).toBeVisible();

  // And it stays gone: leaving and coming back reads the database, not a cached list.
  await app.getByRole("button", { name: /^Inbox/ }).click();
  await openTrash(app);
  await expect(app.getByText("The trash is empty.")).toBeVisible();
});
