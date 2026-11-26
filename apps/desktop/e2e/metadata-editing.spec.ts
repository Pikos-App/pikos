import type { Page } from "@playwright/test";

import { test as appTest, expect, mod, quickAdd } from "./fixtures";

/** Open a page in the editor and return when the byline is mounted. The
 *  byline carries every editable metadata chip we assert against. */
async function openPageInEditor(app: Page, title: string) {
  await app.locator("[data-page-list-item]").filter({ hasText: title }).click();
  // The leftmost chip, the status toggle, is the most reliable signal that the header rendered.
  await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();
}

appTest("priority edit via byline reflects in the chip aria-label", async ({ app }) => {
  await quickAdd(app, "policy review");
  await openPageInEditor(app, "policy review");

  const priorityChip = app.getByRole("button", { name: "Priority: No priority" });
  await expect(priorityChip).toBeVisible();

  await priorityChip.click();
  await app.getByRole("menuitem", { name: /High/ }).click();

  await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
  await expect(priorityChip).not.toBeVisible();

  await app.getByRole("button", { name: "Priority: High" }).click();
  await app.getByRole("menuitem", { name: /Low/ }).click();
  await expect(app.getByRole("button", { name: "Priority: Low" })).toBeVisible();
});

appTest("tags add and remove via byline updates the chip", async ({ app }) => {
  await quickAdd(app, "field research");
  await openPageInEditor(app, "field research");

  const emptyChip = app.getByRole("button", { name: "Tags: none" });
  await expect(emptyChip).toBeVisible();

  // TagsPopover.onEnter creates and selects the tag (lowercased) and the popover stays open for multi-select,
  // so close it with Escape: clicking the chip again would close it, not re-open it.
  await emptyChip.click();
  const search = app.getByPlaceholder("Search or create…");
  await search.fill("research");
  await app.keyboard.press("Enter");
  await app.keyboard.press("Escape");

  await expect(app.getByRole("button", { name: "Tags: research" })).toBeVisible();

  await app.getByRole("button", { name: "Tags: research" }).click();
  await expect(app.getByPlaceholder("Search or create…")).toBeVisible();
  await app.getByRole("button", { name: "#research" }).click();
  await app.keyboard.press("Escape");

  await expect(app.getByRole("button", { name: "Tags: none" })).toBeVisible();
});

appTest(
  "schedule via byline picker shows the page in Today after picking Today",
  async ({ app }) => {
    // Create from Inbox: in Today, QuickAdd auto-anchors schedules to today, defeating the unscheduled premise.
    await quickAdd(app, "field research");
    await openPageInEditor(app, "field research");

    const setSchedule = app.getByRole("button", { name: "Set schedule" });
    await expect(setSchedule).toBeVisible();
    await setSchedule.click();

    // The popover's aria-label keeps the assertion from colliding with the sidebar's same-named Today button.
    const picker = app.getByRole("dialog", { name: "Schedule picker" });
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { exact: true, name: "Today" }).click();

    // Proves the schedule committed with the popover still open.
    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();

    // Scope to the sidebar: the schedule picker also has a "Today" button and may still be mounted.
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    await sidebar.getByRole("button", { name: /^Today/ }).click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "field research" })
    ).toBeVisible();
  }
);

appTest("clearing schedule via byline removes the page from Today", async ({ app }) => {
  await quickAdd(app, "lunch today");

  await app.getByRole("button", { name: /^Today/ }).click();
  const item = app.locator("[data-page-list-item]").filter({ hasText: "lunch" });
  await expect(item).toBeVisible();

  // Today doesn't auto-open the editor on page-item click, so click the list item to activate it.
  await item.click();
  await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();

  await app.getByRole("button", { name: /^Scheduled:/ }).click();
  const picker = app.getByRole("dialog", { name: "Schedule picker" });
  await picker.getByRole("button", { exact: true, name: "No date" }).click();

  await app.keyboard.press(mod("Mod+w")); // close active page so list refreshes
  await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();

  await expect(item).not.toBeVisible();

  await app.getByRole("button", { name: /^Inbox/ }).click();
  await expect(app.locator("[data-page-list-item]").filter({ hasText: "lunch" })).toBeVisible();
});
