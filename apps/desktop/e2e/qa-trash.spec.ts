import type { Page } from "@playwright/test";

import { test as appTest, createFolder, expect, mod, quickAdd } from "./fixtures";

appTest(
  "a deleted page leaves every list and search, and comes back from the trash",
  { tag: ["@TRASH-01"] },
  async ({ app }) => {
    const title = "Offsite logistics";
    await quickAdd(app, `${title} today`);
    const row = app.locator("[data-page-list-item]").filter({ hasText: title });
    const palette = app.getByRole("dialog", { name: "Search pages" });

    await appTest.step("TRASH-01 deleting it takes it out of Inbox and Today", async () => {
      await row.click({ button: "right" });
      await app.getByRole("menuitem", { name: "Delete" }).click();
      await expect(row).not.toBeVisible();
      // The trash is what a lapsed toast leaves; undoing is TRASH-02's row.
      const toast = app.getByRole("alert", { name: new RegExp(title) });
      await expect(toast).toBeVisible();
      await expect(toast).not.toBeVisible({ timeout: 15_000 });
      await app.getByRole("button", { name: /^Today/ }).click();
      await expect(row).not.toBeVisible();
    });

    await appTest.step("TRASH-01 search no longer finds it", async () => {
      await app.keyboard.press(mod("Mod+k"));
      await app.keyboard.type(title);
      await expect(palette.getByText("No pages found")).toBeVisible();
      await app.keyboard.press("Escape");
    });

    await appTest.step("TRASH-01 it is recoverable from Trash", async () => {
      await app.getByRole("button", { exact: true, name: "Trash" }).click();
      await expect(app.getByRole("list", { name: "Deleted pages" })).toContainText(title);
      await app.getByRole("button", { name: `Restore ${title}` }).click();
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(row).toBeVisible();
    });
  }
);

function trashList(app: Page) {
  return app.getByRole("list", { name: "Deleted pages" });
}

function listRow(app: Page, title: string) {
  return app.locator("[data-page-list-item]").filter({ hasText: title });
}

async function deleteRow(app: Page, title: string) {
  await listRow(app, title).click({ button: "right" });
  await app.getByRole("menuitem", { exact: true, name: "Delete" }).click();
  await expect(listRow(app, title)).toHaveCount(0);
}

async function openTrash(app: Page) {
  await app.getByRole("button", { exact: true, name: "Trash" }).click();
  await expect(app.getByRole("heading", { name: "Trash" })).toBeVisible();
}

appTest(
  "Trash opens in the list column, shows folder and age, takes new deletes live, and hands back the list",
  { tag: ["@TRASH-03"] },
  async ({ app }) => {
    await createFolder(app, "Work");
    await quickAdd(app, "old draft");
    await quickAdd(app, "open page");
    await deleteRow(app, "old draft");
    await listRow(app, "open page").click();

    await appTest.step("TRASH-03 it opens in the page-list column under Kept for 30 days", async () => {
      await openTrash(app);
      await expect(app.getByText("Kept for 30 days")).toBeVisible();
      await expect(app.getByRole("group", { name: "Work" })).toHaveCount(0);
    });

    await appTest.step("TRASH-03 each row names its folder and how long ago it went", async () => {
      const row = trashList(app).getByRole("listitem").filter({ hasText: "old draft" });
      await expect(row).toContainText("Work");
      await expect(row).toContainText("Deleted today");
    });

    await appTest.step("TRASH-03 the delete shortcut works here, and the page appears at once", async () => {
      await app.getByRole("textbox", { name: "Page content" }).click();
      await app.keyboard.press(mod("Mod+Shift+Backspace"));
      await expect(trashList(app)).toContainText("open page");
    });

    await appTest.step("TRASH-03 leaving it brings the normal list back", async () => {
      await app
        .getByRole("group", { name: "Views and folders" })
        .getByRole("button", { exact: true, name: "Work" })
        .click();
      await expect(app.getByRole("heading", { name: "Trash" })).toHaveCount(0);
      await expect(app.getByRole("group", { name: "Work" })).toBeVisible();
    });
  }
);

appTest(
  "a page restored while its folder is still in the trash lands in Inbox",
  { tag: ["@TRASH-05"] },
  async ({ app }) => {
    await createFolder(app, "Garden");
    await quickAdd(app, "plant bulbs");
    const garden = app
      .getByRole("group", { name: "Views and folders" })
      .getByRole("button", { exact: true, name: "Garden" });
    await garden.click({ button: "right" });
    await app.getByRole("menuitem", { name: "Delete" }).click();
    await expect(garden).toHaveCount(0);

    await appTest.step("TRASH-05 restoring the page puts it in Inbox, visible", async () => {
      await openTrash(app);
      await app.getByRole("button", { name: "Restore plant bulbs" }).click();
      await expect(trashList(app).getByText("plant bulbs")).toHaveCount(0);
      await app.getByRole("button", { name: /^Inbox/ }).click();
      await expect(listRow(app, "plant bulbs")).toBeVisible();
      await expect(garden).toHaveCount(0);
    });
  }
);

appTest(
  "Empty trash needs delete typed, Delete Forever asks first, and both are for good",
  { tag: ["@TRASH-06"] },
  async ({ app }) => {
    for (const title of ["first gone", "second gone", "third gone"]) {
      await quickAdd(app, title);
      await deleteRow(app, title);
    }
    await openTrash(app);

    await appTest.step("TRASH-06 Delete Forever on one page asks, then removes it", async () => {
      await app.getByRole("button", { name: "Delete first gone forever" }).click();
      const confirm = app.getByRole("alertdialog", { name: "Delete this page forever?" });
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete forever" }).click();
      await expect(trashList(app).getByText("first gone")).toHaveCount(0);
    });

    await appTest.step("TRASH-06 Empty trash stays shut until delete is typed", async () => {
      await app.getByRole("button", { name: "Empty trash" }).click();
      const confirm = app.getByRole("alertdialog", { name: "Empty the trash?" });
      const go = confirm.getByRole("button", { name: "Empty trash" });
      await expect(go).toBeDisabled();
      await confirm.getByLabel(/Type delete to confirm/).fill("delete");
      await expect(go).toBeEnabled();
      await go.click();
      await expect(app.getByText("The trash is empty.")).toBeVisible();
    });

    await appTest.step("TRASH-06 none of them is found anywhere afterwards", async () => {
      await app.keyboard.press(mod("Mod+k"));
      const palette = app.getByRole("dialog", { name: "Search pages" });
      await palette.getByPlaceholder("Search pages, or > for commands…").fill("gone");
      await expect(palette.getByText("No pages found")).toBeVisible();
    });
  }
);

appTest(
  "with a dialog open, the delete shortcuts and Space touch nothing",
  { tag: ["@TRASH-07"] },
  async ({ app }) => {
    await quickAdd(app, "keep me");
    await listRow(app, "keep me").click();
    const untouched = async () => {
      await expect(listRow(app, "keep me")).toHaveCount(1);
      await expect(listRow(app, "keep me").getByRole("checkbox", { name: "Mark done" })).toBeVisible();
    };
    async function pressAll() {
      for (const key of [mod("Mod+Backspace"), mod("Mod+Shift+Backspace"), "Space"]) {
        await app.keyboard.press(key);
      }
    }

    const dialogs: [string, () => Promise<void>][] = [
      ["Quick Add", () => app.keyboard.press(mod("Mod+n"))],
      ["Search", () => app.keyboard.press(mod("Mod+k"))],
      ["Settings", () => app.getByRole("button", { name: "Open settings" }).click()],
    ];
    for (const [name, open] of dialogs) {
      await appTest.step(`TRASH-07 ${name} open: nothing is deleted or completed`, async () => {
        await open();
        await pressAll();
        await app.keyboard.press("Escape");
        await untouched();
      });
    }

    await appTest.step("TRASH-07 the recurring gap dialog open: nothing either", async () => {
      await quickAdd(app, "stretch every day");
      await listRow(app, "stretch").click();
      await app.getByRole("button", { name: /^Scheduled: / }).click();
      const picker = app.getByRole("dialog", { name: "Schedule picker" });
      const day = await app.evaluate(() => {
        const d = new Date();
        d.setDate(d.getDate() - 3);
        return d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
      });
      const cell = picker.getByRole("button", { exact: true, name: day });
      if (!(await cell.isVisible())) await picker.getByRole("button", { name: "Previous month" }).click();
      await cell.click();
      await app.keyboard.press("Escape");
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("dialog").filter({ hasText: /other days are still open/ })).toBeVisible();
      await app.keyboard.press(mod("Mod+Backspace"));
      await app.keyboard.press(mod("Mod+Shift+Backspace"));
      await app.keyboard.press("Escape");
      await expect(listRow(app, "stretch")).toHaveCount(1);
      await expect(listRow(app, "stretch").getByRole("checkbox", { name: "Mark done" })).toBeVisible();
      await untouched();
    });
  }
);
