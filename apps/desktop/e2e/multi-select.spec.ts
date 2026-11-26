import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test as appTest, createFolder, mod, quickAdd } from "./fixtures";

async function createPages(app: Page, titles: string[]) {
  for (const title of titles) {
    await quickAdd(app, title);
  }
}

appTest("multi-select pages with Cmd+Click", { tag: ["@LIST-09:12"] }, async ({ app }) => {
  await createPages(app, ["alpha page", "beta page", "gamma page"]);

  const list = app.locator("[data-page-list-item]");
  const alpha = list.filter({ hasText: "alpha page" });
  const beta = list.filter({ hasText: "beta page" });
  const gamma = list.filter({ hasText: "gamma page" });

  await alpha.click();
  await expect(alpha).toHaveAttribute("data-active", "true");

  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).toHaveAttribute("data-selected", "true");

  await gamma.click({ modifiers: ["Meta"] });
  await expect(gamma).toHaveAttribute("data-selected", "true");

  await beta.click({ modifiers: ["Meta"] });
  await expect(beta).not.toHaveAttribute("data-selected", "true");
  await expect(gamma).toHaveAttribute("data-selected", "true");
});

appTest("multi-select range with Shift+Click", { tag: ["@LIST-09:12"] }, async ({ app }) => {
  await createPages(app, ["range-a", "range-b", "range-c", "range-d"]);

  const list = app.locator("[data-page-list-item]");
  const rangeA = list.filter({ hasText: "range-a" });
  const rangeB = list.filter({ hasText: "range-b" });
  const rangeC = list.filter({ hasText: "range-c" });
  const rangeD = list.filter({ hasText: "range-d" });

  await rangeA.click();
  await rangeC.click({ modifiers: ["Shift"] });

  await expect(rangeA).toHaveAttribute("data-selected", "true");
  await expect(rangeB).toHaveAttribute("data-selected", "true");
  await expect(rangeC).toHaveAttribute("data-selected", "true");
  await expect(rangeD).not.toHaveAttribute("data-selected");
});

appTest(
  "Shift+Click in a folder ranges from the last Cmd-clicked page, not the open one",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    await createFolder(app, "Range QA");
    await createPages(app, ["anchor-a", "anchor-b", "anchor-c", "anchor-d"]);
    const list = app.locator("[data-page-list-item]");
    const [a, b, c, d] = ["anchor-a", "anchor-b", "anchor-c", "anchor-d"].map((t) =>
      list.filter({ hasText: t })
    );

    await a!.click();
    await c!.click({ modifiers: ["Meta"] });
    await d!.click({ modifiers: ["Shift"] });

    await expect(c!).toHaveAttribute("data-selected", "true");
    await expect(d!).toHaveAttribute("data-selected", "true");
    await expect(b!).not.toHaveAttribute("data-selected");
  }
);

appTest(
  "Shift+Click ranges into the expanded Completed section",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    await createPages(app, ["done-range-a", "done-range-b", "done-range-c"]);
    const list = app.locator("[data-page-list-item]");
    await list
      .filter({ hasText: "done-range-c" })
      .getByRole("checkbox", { name: /Mark done/i })
      .click();
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    const [a, b, c] = ["done-range-a", "done-range-b", "done-range-c"].map((t) =>
      list.filter({ hasText: t })
    );
    await expect(c!).toBeVisible();

    await a!.click();
    await c!.click({ modifiers: ["Shift"] });

    for (const page of [a, b, c]) await expect(page!).toHaveAttribute("data-selected", "true");
  }
);

appTest("Escape clears multi-selection", { tag: ["@LIST-09:12"] }, async ({ app }) => {
  await createPages(app, ["esc-page-1", "esc-page-2"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "esc-page-1" });
  const page2 = list.filter({ hasText: "esc-page-2" });

  await page1.click();
  await page2.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");

  await app.keyboard.press("Escape");

  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});

appTest(
  "Cmd+Click keeps every page it adds selected",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    await createPages(app, ["keep-a", "keep-b", "keep-c"]);
    const list = app.locator("[data-page-list-item]");
    const pages = ["keep-a", "keep-b", "keep-c"].map((t) => list.filter({ hasText: t }));

    await pages[0]!.click();
    await pages[1]!.click({ modifiers: ["Meta"] });
    await pages[2]!.click({ modifiers: ["Meta"] });

    for (const page of pages) await expect(page).toHaveAttribute("data-selected", "true");
  }
);

appTest(
  "a click outside the list clears a multi-selection",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    await createPages(app, ["out-1", "out-2"]);
    const list = app.locator("[data-page-list-item]");
    const page1 = list.filter({ hasText: "out-1" });
    const page2 = list.filter({ hasText: "out-2" });

    await page1.click();
    await page2.click({ modifiers: ["Shift"] });
    await expect(page2).toHaveAttribute("data-selected", "true");

    // Not the editor: focusing it clears a selection on its own.
    await app.getByText("Folders", { exact: true }).click();

    await expect(page1).not.toHaveAttribute("data-selected");
    await expect(page2).not.toHaveAttribute("data-selected");
  }
);

appTest("Cmd+A selects all visible pages", async ({ app }) => {
  await createPages(app, ["sel-all-1", "sel-all-2", "sel-all-3"]);

  // Blur any focused input/editor so Cmd+A targets the page list
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  const items = app.locator("[data-page-list-item][data-selected=true]");
  await expect(items).toHaveCount(3);
});

appTest(
  "Cmd+A then Space marks all selected pages as completed",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    const titles = ["space-bulk-1", "space-bulk-2", "space-bulk-3"];
    await createPages(app, titles);

    const list = app.locator("[data-page-list-item]");
    const selected = app.locator("[data-page-list-item][data-selected=true]");

    await app.locator("body").click({ position: { x: 0, y: 0 } });
    await app.keyboard.press(mod("Mod+a"));

    await expect(selected).toHaveCount(3);

    await app.keyboard.press("Space");

    for (const title of titles) {
      await expect(list.filter({ hasText: title })).not.toBeVisible();
    }

    await expect(selected).toHaveCount(0);

    // Every page is COMPLETED, not just hidden: all three show in the Completed accordion.
    // The bulk write flips them in one transaction, so none stay open.
    await app.getByRole("button", { exact: true, name: "Completed" }).click();
    for (const title of titles) {
      const item = list.filter({ hasText: title });
      await expect(item).toBeVisible();
      await expect(item.getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
    }
  }
);

appTest("Cmd+A then Space completes all with the folder row focused", async ({ app }) => {
  await createFolder(app, "Bulk QA");
  const titles = ["folder-bulk-1", "folder-bulk-2", "folder-bulk-3"];
  await createPages(app, titles);

  const list = app.locator("[data-page-list-item]");
  const selected = app.locator("[data-page-list-item][data-selected=true]");

  // Focus on the folder row (role="button") must not swallow Space: Cmd+A moves focus onto
  // the list, so the selection owns the key.
  await app
    .getByRole("group", { name: "Views and folders" })
    .getByRole("button", { exact: true, name: "Bulk QA" })
    .click();

  await app.keyboard.press(mod("Mod+a"));
  await expect(selected).toHaveCount(3);

  await app.keyboard.press("Space");

  for (const title of titles) {
    await expect(list.filter({ hasText: title })).not.toBeVisible();
  }
  await expect(selected).toHaveCount(0);
});

appTest("Cmd+A then Space completes plain pages but advances a recurring one", async ({ app }) => {
  await createPages(app, ["bulk-plain-1", "bulk-plain-2"]);

  // A daily series anchored today has no missed-day gap, so completion skips the dialog.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  const list = app.locator("[data-page-list-item]");
  const selected = app.locator("[data-page-list-item][data-selected=true]");

  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));
  await expect(selected).toHaveCount(3);

  await app.keyboard.press("Space");

  await expect(list.filter({ hasText: "bulk-plain-1" })).not.toBeVisible();
  await expect(list.filter({ hasText: "bulk-plain-2" })).not.toBeVisible();

  // Recurring completion advances the head and keeps it open; a plain status flip would corrupt the series.
  const standup = list.filter({ hasText: "standup" });
  await expect(standup).toHaveCount(1);
  await expect(standup.getByRole("checkbox", { name: /Mark done/i })).toBeVisible();
});

appTest(
  "bulk delete selected pages with Cmd+Backspace",
  { tag: ["@LIST-09:12"] },
  async ({ app }) => {
    await createPages(app, ["del-bulk-1", "del-bulk-2", "del-bulk-3"]);

    const list = app.locator("[data-page-list-item]");

    await list.filter({ hasText: "del-bulk-1" }).click();
    await list.filter({ hasText: "del-bulk-3" }).click({ modifiers: ["Shift"] });

    await expect(list.filter({ hasText: "del-bulk-1" })).toHaveAttribute("data-selected", "true");
    await expect(list.filter({ hasText: "del-bulk-3" })).toHaveAttribute("data-selected", "true");

    await app.keyboard.press(mod("Mod+Backspace"));

    await expect(list.filter({ hasText: "del-bulk-1" })).not.toBeVisible();
    await expect(list.filter({ hasText: "del-bulk-2" })).not.toBeVisible();
    await expect(list.filter({ hasText: "del-bulk-3" })).not.toBeVisible();
  }
);

appTest("plain click clears multi-selection", { tag: ["@LIST-09:12"] }, async ({ app }) => {
  await createPages(app, ["clear-sel-1", "clear-sel-2", "clear-sel-3"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "clear-sel-1" });
  const page2 = list.filter({ hasText: "clear-sel-2" });
  const page3 = list.filter({ hasText: "clear-sel-3" });

  await page1.click();
  await page3.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");
  await expect(page3).toHaveAttribute("data-selected", "true");

  await page2.click();
  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
  await expect(page3).not.toHaveAttribute("data-selected");
  await expect(page2).toHaveAttribute("data-active", "true");
});

appTest("clicking into editor clears multi-selection", async ({ app }) => {
  await createPages(app, ["editor-clr-1", "editor-clr-2"]);

  const list = app.locator("[data-page-list-item]");
  const page1 = list.filter({ hasText: "editor-clr-1" });
  const page2 = list.filter({ hasText: "editor-clr-2" });

  await page1.click();
  await page2.click({ modifiers: ["Shift"] });
  await expect(page1).toHaveAttribute("data-selected", "true");
  await expect(page2).toHaveAttribute("data-selected", "true");

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  await expect(page1).not.toHaveAttribute("data-selected");
  await expect(page2).not.toHaveAttribute("data-selected");
});
