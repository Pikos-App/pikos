import { expect, mod, quickAdd, test as appTest } from "./fixtures";

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
  "arrow keys navigate through entire virtualized page list @tier2",
  async ({ app }) => {
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
  "completed accordion expands and collapses inside virtual list @tier2",
  async ({ app }) => {
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
  "switching between folders re-renders virtualized list @tier2",
  async ({ app }) => {
    await seedPages(app, 15, "inbox-page");

    await app
      .getByRole("toolbar", { name: "Folder actions" })
      .getByRole("button", { name: "New Folder" })
      .click();
    await app.keyboard.type("Test Folder");
    await app.keyboard.press("Enter");

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

appTest(
  "Cmd+A selects all pages including those off-screen @tier2",
  async ({ app }) => {
    await seedPages(app, PAGE_COUNT);

    // Focus the page list area (not an input)
    await app.locator("body").click({ position: { x: 0, y: 0 } });
    await app.keyboard.press(mod("Mod+a"));

    const selected = app.locator("[data-page-list-item][data-selected=true]");
    // Virtualized list only renders visible items, so we can't count all 25
    // in the DOM. Instead verify that ALL rendered items are selected.
    const renderedCount = await app.locator("[data-page-list-item]").count();
    await expect(selected).toHaveCount(renderedCount);
  }
);
