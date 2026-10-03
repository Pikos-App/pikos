import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { test as appTest, bridgeCall } from "./fixtures";

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

appTest.describe("a 20,000-page workspace, its lists loaded a window at a time", () => {
  appTest.use({ viewCache: true, workspace: "large" });
  appTest.setTimeout(240_000);

  appTest(
    "jumping to the bottom of a folder loads and shows its last row @large",
    async ({ app }) => {
      await app.getByText("Folder 01", { exact: true }).first().click();
      const items = app.locator("[data-page-list-item]");
      await expect(items.first()).toBeVisible();

      const ids = await bridgeCall<string[]>(app, "list_view_ids", {
        after: null,
        key: {
          scope: { folderId: await folderId(app, "Folder 01"), kind: "folder" },
          sort: "manual",
          zone: "America/New_York",
        },
        through: null,
      });
      const [last] = await bridgeCall<{ title: string }[]>(app, "get_pages", {
        ids: ids.slice(-1),
      });

      await app.getByRole("group", { name: "Folder 01" }).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(items.filter({ hasText: last?.title ?? "" }).first()).toBeVisible({
        timeout: 15_000,
      });
    }
  );
});

async function folderId(app: Page, name: string): Promise<string> {
  const folders = await bridgeCall<{ id: string; name: string }[]>(app, "list_folders", {});
  const folder = folders.find((f) => f.name === name);
  if (!folder) throw new Error(`no folder ${name}`);
  return folder.id;
}
