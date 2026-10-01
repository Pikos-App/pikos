import {
  test as appTest,
  expect,
  openCalendarMode,
  quickAdd,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

appTest(
  "tags added and removed in the tag picker update the chip and persist",
  { tag: ["@TASK-03"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "TASK-03 reloads, and the mock keeps nothing across a reload");
    await quickAdd(app, "Field research");
    const row = app.locator("[data-page-list-item]").filter({ hasText: "Field research" });
    await row.click();
    const search = app.getByPlaceholder("Search or create…");

    await appTest.step("TASK-03 adding two tags shows both on the chip", async () => {
      await app.getByRole("button", { name: "Tags: none" }).click();
      for (const tag of ["research", "travel"]) {
        await search.fill(tag);
        await app.keyboard.press("Enter");
      }
      await app.keyboard.press("Escape");
      await expect(
        app.getByRole("button", { name: /^Tags: (research, travel|travel, research)$/ })
      ).toBeVisible();
    });

    await appTest.step("TASK-03 removing one leaves the other", async () => {
      await app.getByRole("button", { name: /^Tags: / }).click();
      await app.getByRole("button", { name: "#research" }).click();
      await app.keyboard.press("Escape");
      await expect(app.getByRole("button", { name: "Tags: travel" })).toBeVisible();
    });

    await appTest.step("TASK-03 the tags persist across a relaunch", async () => {
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await row.click();
      await expect(app.getByRole("button", { name: "Tags: travel" })).toBeVisible();
    });
  }
);

appTest(
  "a page's status changes from the byline, both ways, and persists",
  { tag: ["@TASK-01"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "TASK-01 reloads, and the mock keeps nothing across a reload");
    await quickAdd(app, "Send the invoice");
    const row = app.locator("[data-page-list-item]").filter({ hasText: "Send the invoice" });
    const completed = app.getByRole("button", { exact: true, name: "Completed" });
    await row.click();

    await appTest.step("TASK-01 Mark done completes the page", async () => {
      await app.getByRole("button", { name: "Mark done" }).click();
      await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
      await expect(row).toHaveCount(0);
    });

    await appTest.step("TASK-01 the status persists across a relaunch", async () => {
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await expect(row).toHaveCount(0);
      await completed.click();
      await expect(row.getByRole("checkbox", { name: "Mark not done" })).toBeVisible();
    });

    await appTest.step("TASK-01 Mark not done reopens it, and that persists too", async () => {
      await row.click();
      await app.getByRole("button", { name: "Mark not done" }).click();
      await expect(app.getByRole("button", { name: "Mark done" })).toBeVisible();
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await expect(row.getByRole("checkbox", { name: "Mark done" })).toBeVisible();
    });
  }
);

appTest(
  "each of the four priorities shows in the header, the list and the calendar",
  { tag: ["@TASK-02"] },
  async ({ app }) => {
    await quickAdd(app, "Quarterly plan today at 3pm");
    const row = app.locator("[data-page-list-item]").filter({ hasText: "Quarterly plan" });
    const checkbox = row.getByRole("checkbox", { name: "Mark done" });
    const border = () => checkbox.evaluate((el) => getComputedStyle(el).borderColor);
    await row.click();
    const plain = await border();
    const borders: Record<string, string> = {};

    for (const level of ["Urgent", "High", "Medium", "Low"] as const) {
      await appTest.step(`TASK-02 ${level} shows in the header, list and calendar`, async () => {
        await app.getByRole("button", { name: /^Priority: / }).click();
        await app.getByRole("menuitem", { name: new RegExp(level) }).click();
        await expect(app.getByRole("button", { name: `Priority: ${level}` })).toBeVisible();
        borders[level] = await border();

        await openCalendarMode(app);
        await app
          .getByRole("region", { name: "Week calendar" })
          .getByRole("button", { name: /^Quarterly plan, / })
          .click();
        await expect(app.getByRole("button", { name: `Priority: ${level}` })).toBeVisible();
        await app.keyboard.press("Escape");
        await app.getByRole("button", { name: "Editor view" }).click();
      });
    }

    await appTest.step("TASK-02 the list marks Urgent and High apart from the rest", () => {
      expect(borders["Urgent"]).not.toBe(plain);
      expect(borders["High"]).not.toBe(plain);
      expect(borders["Urgent"]).not.toBe(borders["High"]);
      expect(borders["Medium"]).toBe(plain);
      expect(borders["Low"]).toBe(plain);
    });
  }
);
