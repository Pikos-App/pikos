import { test as appTest, expect, mod } from "./fixtures";

appTest(
  "right panel calendar mode persists across reload @smoke",
  { tag: ["@LIST-14:2"] },
  async ({ app }) => {
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Calendar view" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await app.reload();
    await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Calendar view" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(app.getByRole("button", { name: "Editor view" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  }
);

appTest("sidebar collapsed state persists across reload", async ({ app }) => {
  const collapseBtn = app.getByRole("button", { name: "Collapse sidebar" });
  await expect(collapseBtn).toBeVisible();
  await collapseBtn.click();

  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).not.toBeVisible();
});

appTest("calendar reference week persists across reload", async ({ app }) => {
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.click();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  // The heading carries an explicit accessible name, so the assertion doesn't depend on its dynamic text.
  const weekHeading = app.getByRole("heading", { name: "Visible week" });
  const initialLabel = await weekHeading.textContent();

  // The icon button: the date-picker nav button shares the accessible name.
  const nextWeek = app.locator('button[aria-label="Next week"]');
  await nextWeek.click();
  await nextWeek.click();

  const movedLabel = await weekHeading.textContent();
  expect(movedLabel).not.toBe(initialLabel);

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  const restoredLabel = await app.getByRole("heading", { name: "Visible week" }).textContent();
  expect(restoredLabel).toBe(movedLabel);
});

appTest("per-view sort mode persists across reload", async ({ app }) => {
  // Inbox is the default view; Today suppresses the sort menu. The chip's accessible name
  // carries the mode, so the order itself isn't inspected.
  const sortBtn = app.getByRole("button", { name: /^Sort:/ });
  await expect(sortBtn).toBeVisible();
  // The default sort label varies by build, so set it explicitly.
  await sortBtn.click();
  await app.getByRole("menuitem", { name: "Title" }).click();
  await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();

  await app.reload();
  await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

  await expect(app.getByRole("button", { name: "Sort: title" })).toBeVisible();
});
