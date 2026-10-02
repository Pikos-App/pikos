import { expect, test } from "@playwright/test";

import { test as appTest } from "./fixtures";

test("app boots directly to workspace @smoke @mock-only", async ({ page }) => {
  await page.goto("/");
  // Workspace auto-creates on first launch — no welcome screen
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
});

appTest.describe("a 20,000-page workspace", () => {
  appTest.use({ workspace: "large" });
  // The first large test of the day builds the template: a release build of the CLI, then a seed.
  appTest.setTimeout(240_000);

  appTest("opens with its folders and pages @large", async ({ app }) => {
    await expect(app.getByText("Folder 01", { exact: true }).first()).toBeVisible();
    await expect(app.locator("[data-page-list-item]").first()).toBeVisible();
  });
});
