import { test as appTest, bridgeCall, createFolder, expect, mod, quickAdd } from "./fixtures";

/**
 * Virtualized list tests — validates that keyboard navigation,
 * completed accordion, and folder switching work correctly when
 * the page list is virtualized (items exceed viewport).
 */

const PAGE_COUNT = 25;

async function seedPages(app: import("@playwright/test").Page, count: number, prefix = "virt") {
  for (let i = 0; i < count; i++) {
    await quickAdd(app, `${prefix} ${String(i).padStart(3, "0")}`);
  }
}

// ─── Keyboard nav scrolls through virtualized list ─────────────────────────

appTest(
  "arrow keys navigate through entire virtualized page list",
  { tag: ["@LIST-01:2"] }, async ({ app }) => {
    await seedPages(app, PAGE_COUNT);

    const list = app.locator("[data-page-list-item]");

    // Click the first page to focus the list
    await list.first().click();

    for (let i = 0; i < PAGE_COUNT - 1; i++) {
      await app.keyboard.press("ArrowDown");
    }

    const lastPage = list.filter({ hasText: `virt ${String(PAGE_COUNT - 1).padStart(3, "0")}` });
    await expect(lastPage).toBeVisible();
    await expect(lastPage).toHaveAttribute("data-active", "true");

    for (let i = 0; i < PAGE_COUNT - 1; i++) {
      await app.keyboard.press("ArrowUp");
    }

    const firstPage = list.filter({ hasText: "virt 000" });
    await expect(firstPage).toBeVisible();
    await expect(firstPage).toHaveAttribute("data-active", "true");
  }
);

// ─── Completed accordion works within virtualized list ─────────────────────

appTest(
  "completed accordion expands and collapses inside virtual list",
  { tag: ["@LIST-11:2"] }, async ({ app }) => {
    await seedPages(app, 5);

    const firstItem = app.locator("[data-page-list-item]").filter({ hasText: "virt 000" });
    await firstItem.getByRole("checkbox", { name: "Mark done" }).click();

    await expect(firstItem).not.toBeVisible();

    const completedToggle = app.getByRole("button", { name: /Completed/ });
    await completedToggle.click();

    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "virt 000" })
    ).toBeVisible();

    await completedToggle.click();

    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "virt 000" })
    ).not.toBeVisible();
  }
);

// ─── Folder switch re-renders virtualized list correctly ───────────────────

appTest(
  "switching between folders re-renders virtualized list",
  { tag: ["@LIST-02:3"] },
  async ({ app }) => {
    await seedPages(app, 15, "inbox-page");

    await createFolder(app, "Test Folder");

    // The new folder is active after creation, so these land inside it.
    await seedPages(app, 10, "folder-page");

    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "folder-page 000" })
    ).toBeVisible();

    await app.getByRole("button", { name: /Inbox/ }).click();

    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "inbox-page 000" })
    ).toBeVisible();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "folder-page 000" })
    ).not.toBeVisible();

    await app.getByRole("button", { name: "Test Folder" }).click();

    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "folder-page 000" })
    ).toBeVisible();
  }
);

// ─── Cmd+A selects all in a virtualized list ───────────────────────────────

appTest("Cmd+A selects every page, off-screen too, and deleting them leaves none", { tag: ["@LIST-09:10"] }, async ({ app, storage }) => {
  await seedPages(app, PAGE_COUNT);

  // Focus the page list area (not an input)
  await app.locator("body").click({ position: { x: 0, y: 0 } });
  await app.keyboard.press(mod("Mod+a"));

  const selected = app.locator("[data-page-list-item][data-selected=true]");
  // Virtualized list only renders visible items, so we can't count all 25
  // in the DOM. Instead verify that ALL rendered items are selected.
  const renderedCount = await app.locator("[data-page-list-item]").count();
  await expect(selected).toHaveCount(renderedCount);

  // Most of the 25 were never loaded, so this deletes pages the list only knows by id.
  await app.keyboard.press(mod("Mod+Backspace"));
  await expect(app.locator("[data-page-list-item]")).toHaveCount(0);
  if (storage !== "bridge") return;
  const inbox = { scope: { kind: "inbox" }, sort: "manual", zone: "America/New_York" };
  await expect
    .poll(() => bridgeCall<string[]>(app, "list_view_ids", { after: null, key: inbox, through: null }))
    .toEqual([]);
});
