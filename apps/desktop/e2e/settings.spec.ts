import { expect } from "@playwright/test";

import { test as appTest, mod, quickAdd } from "./fixtures";

appTest("settings opens and each tab renders @smoke", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  await app.getByRole("button", { name: "Open settings" }).click();

  // General is the default tab; its headings confirm the overlay rendered.
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Preferences" })).toBeVisible();

  await app.getByRole("button", { name: "Notifications" }).click();
  await expect(app.getByRole("heading", { exact: true, name: "Notifications" })).toBeVisible();

  await app.getByRole("button", { exact: true, name: "Data" }).click();
  await expect(app.getByRole("heading", { name: "Your workspace" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Export" })).toBeVisible();

  await app.getByRole("button", { name: "Shortcuts" }).click();
  await expect(app.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();

  await app.getByRole("button", { exact: true, name: "General" }).click();
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  expect(errors).toEqual([]);
});

appTest("settings opens via Cmd+, shortcut @smoke", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  await app.keyboard.press(mod("Mod+,"));
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(app.getByRole("heading", { name: "About" })).not.toBeVisible();

  expect(errors).toEqual([]);
});

appTest(
  "Delete all data dialog requires typing 'delete' to enable confirm",
  { tag: ["@TRASH-08:3"] },
  async ({ app }) => {
    await app.getByRole("button", { name: "Open settings" }).click();
    await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

    await app.getByRole("button", { exact: true, name: "Data" }).click();

    const trigger = app.getByRole("button", { exact: true, name: "Delete" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    await expect(app.getByRole("alertdialog", { name: "Delete all Pikos data?" })).toBeVisible();
    const confirm = app.getByRole("button", { name: "Delete everything" });
    await expect(confirm).toBeDisabled();

    const input = app.getByRole("textbox");
    await input.fill("nope");
    await expect(confirm).toBeDisabled();

    // Mixed case and whitespace verify the case-insensitive trim, as in the unit test.
    await input.fill("  DELETE  ");
    await expect(confirm).toBeEnabled();

    // Cancel out: confirming would wipe the workspace and break later tests.
    await app.getByRole("button", { name: "Cancel" }).click();
    await expect(
      app.getByRole("alertdialog", { name: "Delete all Pikos data?" })
    ).not.toBeVisible();
  }
);

// The panel stays mounted while closed, so a fetch keyed on anything that doesn't change per open pins
// every figure to app launch. Creating the page first and opening settings after separates the two.
appTest("Data tab reads the workspace as it is on open", async ({ app }) => {
  await quickAdd(app, "Stand-up every monday at 9am");

  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { exact: true, name: "Data" }).click();

  await expect(app.getByLabel("Recurring: in use")).toBeVisible();
});
