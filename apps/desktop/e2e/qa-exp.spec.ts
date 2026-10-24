import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Page } from "@playwright/test";

import {
  test as appTest,
  bridgeCall,
  expect,
  mod,
  openEditorForPage,
  quickAdd,
  quitApp,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

/** The folder the bridge writes this test's exports to, standing in for ~/Downloads. */
async function downloadsOf(app: Page) {
  return join(dirname(await bridgeCall<string>(app, "bridge_workspace_path")), "Downloads");
}

function row(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

async function expectExported(app: Page, count: number) {
  await expect(app.getByText("Exported to Downloads", { exact: true })).toHaveCount(count);
}

appTest(
  "a page exports as Markdown to Downloads from its menu, ⌘⇧E and the palette, never over an earlier one",
  { tag: ["@EXP-12:2"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EXP-12 reads the file the real writer wrote");
    await quickAdd(app, "Trip notes");
    await quickAdd(app, "Packing list");
    await openEditorForPage(app, "Trip notes");
    await app.keyboard.type("Pack light");
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    const downloads = await downloadsOf(app);

    await appTest.step("EXP-12 from its right-click menu", async () => {
      await row(app, "Trip notes").click({ button: "right" });
      await app.getByRole("menuitem", { name: "Export as Markdown" }).click();
      await expectExported(app, 1);
      expect(readFileSync(join(downloads, "Trip notes.md"), "utf8")).toContain("Pack light");
    });

    await appTest.step("EXP-12 with ⌘⇧E on the open page, as a second file", async () => {
      await app.getByRole("textbox", { name: "Page content" }).click();
      await app.keyboard.press(mod("Mod+Shift+e"));
      await expectExported(app, 2);
      expect(readFileSync(join(downloads, "Trip notes 2.md"), "utf8")).toContain("Pack light");
    });

    await appTest.step("EXP-12 from the palette, as a third", async () => {
      await app.locator("body").click({ position: { x: 0, y: 0 } });
      await app.keyboard.press(mod("Mod+k"));
      const palette = app.getByRole("dialog", { name: "Search pages" });
      await palette.getByPlaceholder("Search pages, or > for commands…").fill(">export page");
      await palette.getByRole("button", { name: /^Export page as Markdown/ }).click();
      await expectExported(app, 3);
      expect(existsSync(join(downloads, "Trip notes 3.md"))).toBe(true);
      expect(readFileSync(join(downloads, "Trip notes.md"), "utf8")).toContain("Pack light");
    });

    await appTest.step("EXP-12 the menu doesn't offer it with several pages selected", async () => {
      await row(app, "Trip notes").click({ modifiers: ["ControlOrMeta"] });
      await row(app, "Packing list").click({ modifiers: ["ControlOrMeta"] });
      await expect(app.locator("[data-page-list-item][data-selected=true]")).toHaveCount(2);
      await row(app, "Packing list").click({ button: "right" });
      await expect(app.getByRole("menuitem", { name: "Delete" })).toBeVisible();
      await expect(app.getByRole("menuitem", { name: "Export as Markdown" })).toHaveCount(0);
    });
  }
);

appTest(
  "a link to a renamed page exports as [[its new title]], from the workspace and from the page alone",
  { tag: ["@EXP-14"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EXP-14 reads the files the real writer wrote");
    await quickAdd(app, "Plans");
    await quickAdd(app, "Garden journal");
    const body = await openEditorForPage(app, "Garden journal");
    await app.keyboard.type("See [[Plans");
    await expect(app.getByRole("listbox", { name: "Link to page" })).toBeVisible();
    await app.keyboard.press("Enter");
    await expect(body.getByRole("button", { exact: true, name: "Plans" })).toBeVisible();
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);

    await row(app, "Plans").click();
    await app.getByLabel("Page title").click();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("Plans for spring");
    await app.keyboard.press("Enter");
    await expect(row(app, "Plans for spring")).toHaveCount(1);
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    const downloads = await downloadsOf(app);

    await appTest.step("EXP-14 the whole workspace writes the link by the new title", async () => {
      await app.getByRole("button", { name: "Open settings" }).click();
      await app.getByRole("button", { exact: true, name: "Data" }).click();
      await app.getByRole("button", { exact: true, name: "Export as Markdown" }).click();
      await expect(app.getByText("Saved to Downloads")).toBeVisible();
      const [folder] = readdirSync(downloads).filter((name) => name.startsWith("pikos-markdown-"));
      const tree = join(downloads, folder!);
      const file = readdirSync(tree, { recursive: true })
        .map(String)
        .find((path) => path.endsWith("Garden journal.md"));
      expect(readFileSync(join(tree, file!), "utf8")).toContain("See [[Plans for spring]]");
      await app.keyboard.press("Escape");
    });

    await appTest.step("EXP-14 the linking page alone writes it the same way", async () => {
      await row(app, "Garden journal").click({ button: "right" });
      await app.getByRole("menuitem", { name: "Export as Markdown" }).click();
      await expectExported(app, 1);
      expect(readFileSync(join(downloads, "Garden journal.md"), "utf8")).toContain(
        "See [[Plans for spring]]"
      );
    });
  }
);

/** Overwrite part of the workspace file, as the manual row's `dd` does. */
function damage(file: string) {
  execFileSync("dd", [
    "if=/dev/urandom",
    `of=${file}`,
    "bs=4096",
    "seek=4",
    "count=4",
    "conv=notrunc",
  ]);
}

appTest(
  "a workspace damaged while the app was closed opens to the damaged screen with its snapshots",
  { tag: ["@EXP-15"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EXP-15 damages the real writer's file");
    await quickAdd(app, "Before the damage");
    // The snapshot an import leaves, so the restore list has one to offer.
    await bridgeCall(app, "backup_db_before_import");
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    damage(await quitApp(app));
    await app.goto("/");

    await appTest.step("EXP-15 it opens to Your workspace file is damaged", async () => {
      await expect(app.getByText("Your workspace file is damaged")).toBeVisible();
      await expect(app.getByRole("main", { name: "Workspace" })).toHaveCount(0);
    });

    await appTest.step("EXP-15 it offers Show me the backups and the snapshots to restore", async () => {
      await expect(app.getByRole("button", { name: "Show me the backups" })).toBeVisible();
      await expect(app.getByText("Before an import")).toBeVisible();
      await expect(app.getByRole("button", { name: /^Restore the backup from / })).toHaveCount(1);
    });
  }
);

appTest(
  "a workspace damaged while the app is open gives way to the damaged screen and takes no more edits",
  { tag: ["@EXP-16"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EXP-16 damages the real writer's file");
    await quickAdd(app, "Before the damage");
    await bridgeCall(app, "backup_db_before_import");
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    const file = await bridgeCall<string>(app, "bridge_workspace_path");
    // As the app's own background checkpoint would by now: recent writes leave the
    // write-ahead log for the file, so the damage lands on pages the app reads.
    execFileSync("sqlite3", ["-cmd", ".timeout 5000", file, "PRAGMA wal_checkpoint(TRUNCATE);"]);
    damage(file);

    await appTest.step("EXP-16 working on gives way to the damaged screen", async () => {
      const damaged = app.getByText("Your workspace file is damaged");
      const work = [
        () => quickAdd(app, "After the damage"),
        () => app.getByRole("button", { name: /^Upcoming/ }).click(),
        () => app.getByRole("button", { exact: true, name: "Trash" }).click(),
        () => app.getByRole("button", { name: "Calendar view" }).click(),
        async () => {
          await app.keyboard.press(mod("Mod+k"));
          await app.keyboard.type("damage");
          await app.keyboard.press("Escape");
        },
      ];
      for (const step of work) {
        if (await damaged.isVisible()) break;
        await step().catch(() => undefined);
      }
      await expect(app.getByText("Your workspace file is damaged")).toBeVisible();
      await expect(app.getByRole("button", { name: /^Restore the backup from / })).toHaveCount(1);
    });

    await appTest.step("EXP-16 no further edit reaches the workspace", async () => {
      await expect(app.getByRole("main", { name: "Workspace" })).toHaveCount(0);
      await expect(app.getByRole("textbox")).toHaveCount(0);
    });
  }
);
