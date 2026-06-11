import { expect } from "@playwright/test";

import { mod, test as appTest } from "./fixtures";

// ─── Opens settings and navigates every tab ─────────────────────────────────

appTest("settings opens and each tab renders @tier1", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  await app.getByRole("button", { name: "Open settings" }).click();

  // General is the default tab — its About + Preferences headings confirm the overlay rendered.
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Preferences" })).toBeVisible();

  await app.getByRole("button", { name: "Notifications" }).click();
  await expect(app.getByRole("heading", { name: "Notifications" })).toBeVisible();

  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("heading", { name: "Your Workspace" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Export" })).toBeVisible();

  await app.getByRole("button", { name: "Shortcuts" }).click();
  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();

  await app.getByRole("button", { name: "General", exact: true }).click();
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  expect(errors).toEqual([]);
});

// ─── Cmd+, opens settings ───────────────────────────────────────────────────

appTest("settings opens via Cmd+, shortcut @tier1", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  expect(errors).toEqual([]);
});

// ─── Delete-all-data typed confirmation ─────────────────────────────────────
//
// The Danger Zone "Delete" button opens a typed-confirm dialog that requires
// the user to type "delete" before the destructive action enables. Test
// stops at the typed-match → confirm-enabled boundary; clicking the final
// Confirm would actually wipe the e2e workspace, so we Cancel out instead.

appTest("Delete All Data dialog requires typing 'delete' to enable confirm @tier2", async ({
  app,
}) => {
  await app.getByRole("button", { name: "Open settings" }).click();
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  // Delete All Data lives on the Data settings page now — navigate there first.
  await app.getByRole("button", { name: "Data", exact: true }).click();

  // Danger Zone is at the bottom of Data; scroll the trigger into view.
  const trigger = app.getByRole("button", { name: "Delete", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  await expect(app.getByRole("alertdialog", { name: "Delete all Pikos data?" })).toBeVisible();
  const confirm = app.getByRole("button", { name: "Delete Everything" });
  await expect(confirm).toBeDisabled();

  const input = app.getByRole("textbox");
  await input.fill("nope");
  await expect(confirm).toBeDisabled();

  // Typing the phrase enables it. Use mixed case + whitespace to verify the
  // case-insensitive trim — same contract as the unit test.
  await input.fill("  DELETE  ");
  await expect(confirm).toBeEnabled();

  // Cancel out — clicking confirm would wipe the workspace and break later tests.
  await app.getByRole("button", { name: "Cancel" }).click();
  await expect(app.getByRole("alertdialog", { name: "Delete all Pikos data?" })).not.toBeVisible();
});
