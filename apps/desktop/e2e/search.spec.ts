import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Search pages (Cmd+K) ──────────────────────────────────────────────────

appTest("search pages via Cmd+K @tier1", async ({ app }) => {
  await quickAdd(app, "alpha project");
  await quickAdd(app, "beta report");
  await quickAdd(app, "gamma notes");

  // Open search palette
  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();

  // Type a query
  await app.keyboard.type("beta");

  // Matching result appears, non-matching filtered out
  await expect(dialog.getByText("beta report")).toBeVisible();
  await expect(dialog.getByText("alpha project")).not.toBeVisible();

  // Select the result via Enter
  await app.keyboard.press("Enter");

  // Dialog closes and page is active in the list
  await expect(dialog).not.toBeVisible();
  await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
    "beta report"
  );
});
