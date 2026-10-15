import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { BRIDGE_ORIGIN } from "../bridge/origin";
import { test as appTest, bridgeCall, mod, quickAdd } from "./fixtures";

/**
 * What a large workspace may cost, the speed checks that run on every PR, with the app's own cache
 * settings. Counts, not timings, so a shared runner's noise can't fail them. Measured 2026-10-04 on
 * the 20,000-page template: a launch and then opening Folder 01 (750 pages) make 17 or 18 calls,
 * read 400 rows and mount 33 to 37; a write after selecting the folder whole reads 100 rows,
 * where refetching every row it had ids for read 595.
 * Each limit is about twice what was measured, far under a list read or drawn whole.
 */
const LIMITS = { launchCalls: 36, launchRows: 800, mountedRows: 80, writeRows: 200 };

/** The bridge calls the page makes from here on, and the page rows they read: list windows and
 *  pages by id. */
function countReads(app: Page) {
  const seen = { calls: 0, commands: [] as string[], rows: 0 };
  app.on("requestfinished", async (request) => {
    if (!request.url().startsWith(BRIDGE_ORIGIN)) return;
    seen.calls++;
    const command = (request.postDataJSON() as { command?: string } | null)?.command;
    seen.commands.push(command ?? "");
    if (command !== "list_view" && command !== "get_pages") return;
    const reply = (await (await request.response())?.json()) as {
      value?: { rows?: unknown[] } | unknown[];
    };
    seen.rows += Array.isArray(reply.value) ? reply.value.length : (reply.value?.rows?.length ?? 0);
  });
  return seen;
}

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

appTest.describe("a 20,000-page workspace, with the app's own cache settings", () => {
  appTest.use({ tightCache: false, workspace: "large" });
  appTest.setTimeout(240_000);

  appTest(
    "a launch and opening a large folder stay within their counts @large",
    { tag: ["@PERF-01:2"] },
    async ({ app }) => {
      const reads = countReads(app);
      await app.reload();
      await expect(app.locator("[data-page-list-item]").first()).toBeVisible();
      await app.getByText("Folder 01", { exact: true }).first().click();
      await expect(app.getByRole("group", { name: "Folder 01" })).toHaveAttribute(
        "aria-busy",
        "false"
      );
      await app.waitForTimeout(1500);

      expect(await app.locator("[data-page-list-item]").count()).toBeLessThanOrEqual(
        LIMITS.mountedRows
      );
      expect(reads.calls).toBeLessThanOrEqual(LIMITS.launchCalls);
      expect(reads.rows).toBeLessThanOrEqual(LIMITS.launchRows);
    }
  );

  appTest(
    "a write after selecting a large folder whole reads the screen, not the folder @large",
    { tag: ["@PERF-01:2"] },
    async ({ app }) => {
      await app.getByText("Folder 01", { exact: true }).first().click();
      await expect(app.getByRole("group", { name: "Folder 01" })).toHaveAttribute(
        "aria-busy",
        "false"
      );
      // Selecting every page loads every id in the list, as a jump far down it does.
      const selecting = countReads(app);
      await app.keyboard.press(mod("Mod+a"));
      await expect.poll(() => selecting.commands).toContain("list_view_ids");
      await app.keyboard.press("Escape");
      await app.waitForTimeout(1000);

      const reads = countReads(app);
      await quickAdd(app, "written after a select all");
      await app.waitForTimeout(2000);

      expect(reads.rows).toBeLessThanOrEqual(LIMITS.writeRows);
    }
  );
});

appTest.describe("a 20,000-page workspace, its lists loaded a window at a time", () => {
  appTest.use({ tightCache: true, workspace: "large" });
  appTest.setTimeout(240_000);

  appTest(
    "jumping to the bottom of a folder loads and shows its last row @large",
    { tag: ["@PERF-03"] },
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
