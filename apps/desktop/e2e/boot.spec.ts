import { expect, test } from "@playwright/test";

test("app boots directly to workspace @smoke @mock-only", async ({ page }) => {
  await page.goto("/");
  // Workspace auto-creates on first launch — no welcome screen
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
});
