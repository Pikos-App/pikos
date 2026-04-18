import { expect } from "@playwright/test";

import { mod, test as appTest } from "./fixtures";

// ─── Opens settings and navigates every tab ─────────────────────────────────

appTest("settings opens and each tab renders @tier1", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));

  // Open via the sidebar button
  await app.getByRole("button", { name: "Open settings" }).click();

  // General is the default tab — its About + Preferences headings confirm the overlay rendered.
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Preferences" })).toBeVisible();

  // Notifications tab
  await app.getByRole("button", { name: "Notifications" }).click();
  await expect(app.getByRole("heading", { name: "Notifications" })).toBeVisible();

  // Data tab
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("heading", { name: "Your Workspace" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Import" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Export" })).toBeVisible();

  // Shortcuts tab
  await app.getByRole("button", { name: "Shortcuts" }).click();
  await expect(app.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();

  // Back to General
  await app.getByRole("button", { name: "General", exact: true }).click();
  await expect(app.getByRole("heading", { name: "About" })).toBeVisible();

  // Escape closes the overlay
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
