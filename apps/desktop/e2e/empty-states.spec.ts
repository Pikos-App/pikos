import { test as appTest, expect, mod, quickAdd } from "./fixtures";

appTest(
  "Today view with no scheduled pages shows the empty state @smoke",
  { tag: ["@LIST-02:3"] },
  async ({ app }) => {
    // From Inbox: with Today active, QuickAdd anchors the schedule to today.
    await quickAdd(app, "fresh capture");

    await app.getByRole("button", { name: /^Today/ }).click();
    await expect(app.getByText("Nothing scheduled for today")).toBeVisible();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "fresh capture" })
    ).not.toBeVisible();

    await expect(app.locator("[data-page-list-item]")).toHaveCount(0);
  }
);

appTest(
  "search palette: 'No pages found' empty + 'Show completed' toggles in completed matches",
  async ({ app }) => {
    await quickAdd(app, "active draft");
    await quickAdd(app, "archive item");

    const archive = app.locator("[data-page-list-item]").filter({ hasText: "archive item" });
    await archive.getByRole("checkbox", { name: "Mark done" }).click();
    await expect(archive).not.toBeVisible();

    await app.keyboard.press(mod("Mod+k"));
    const palette = app.getByRole("dialog", { name: "Search pages" });
    await expect(palette).toBeVisible();
    const input = palette.getByPlaceholder("Search pages, or > for commands…");
    await input.fill("nonexistentquery");

    await expect(palette.getByText("No pages found")).toBeVisible();

    await input.fill("");
    await input.fill("archive");
    const showCompletedBtn = palette.getByRole("button", { name: /^Show completed \(\d+\)/ });
    await expect(showCompletedBtn).toBeVisible();
    await expect(palette.getByText("archive item")).not.toBeVisible();

    await showCompletedBtn.click();
    await expect(palette.getByText("archive item")).toBeVisible();
    await expect(palette.getByRole("button", { name: "Hide completed (1)" })).toBeVisible();
  }
);

appTest(
  "deleting a scheduled page removes its calendar chip",
  { tag: ["@TRASH-01:5"] },
  async ({ app }) => {
    // "lunch today" parses cleanly; bare "today" anchors the date.
    await quickAdd(app, "lunch today");

    const calendarBtn = app.getByRole("button", { name: "Calendar view" });
    await calendarBtn.click();
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    const calendar = app.getByRole("region", { name: "Week calendar" });
    const chip = calendar.getByRole("button", { name: "lunch" });
    await expect(chip).toHaveCount(1);

    // Delete from the list: the calendar chip's context menu takes a different code path.
    const editorBtn = app.getByRole("button", { name: "Editor view" });
    await editorBtn.click();
    const item = app.locator("[data-page-list-item]").filter({ hasText: "lunch" });
    await item.click({ button: "right" });
    await app.getByRole("menuitem", { name: "Delete" }).click();

    await expect(item).not.toBeVisible();

    await calendarBtn.click();
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(calendar.getByRole("button", { name: "lunch" })).toHaveCount(0);
  }
);
