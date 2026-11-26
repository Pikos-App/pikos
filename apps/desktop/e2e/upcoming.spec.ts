// Today/Upcoming surfaces whose logic is unit-pinned in core: the Upcoming view's day grouping and
// the Overdue section's bulk "Move to today".
//
// Both use the raw `page` fixture so the clock is installed before the app boots: "overdue" and
// "the next seven days" exist only relative to a known now.

import type { Page } from "@playwright/test";

import { test as appTest, expect, mod } from "./fixtures";

/** Boots the app with the clock pinned to Monday 2026-06-15, 09:00. */
async function bootAt(page: Page, iso: string) {
  await page.clock.install({ time: new Date(iso) });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
}

/** Quick Add against the raw fixture (the shared helper takes the app fixture). */
async function add(page: Page, input: string) {
  await page.keyboard.press(mod("Mod+n"));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Quick add input" }).fill(input);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

appTest("upcoming groups the next seven days by day @mock-only", async ({ page }) => {
  await bootAt(page, "2026-06-15T09:00:00");

  await add(page, "site visit @today at 3pm");
  await add(page, "design review @tomorrow at 9am");
  await add(page, "quarter retro @friday at 2pm");

  await page.getByRole("button", { name: /^Upcoming/ }).click();

  const list = page.getByRole("group", { name: "Upcoming" });
  // Today and Tomorrow are named; anything further out is weekday + date.
  await expect(list.getByText(/^Today/)).toBeVisible();
  await expect(list.getByText(/^Tomorrow/)).toBeVisible();
  await expect(list.getByText(/^Fri, Jun 19/)).toBeVisible();

  const items = page.locator("[data-page-list-item]");
  await expect(items.filter({ hasText: "site visit" })).toBeVisible();
  await expect(items.filter({ hasText: "design review" })).toBeVisible();
  await expect(items.filter({ hasText: "quarter retro" })).toBeVisible();
});

appTest("upcoming leaves overdue pages to the Today view @mock-only", async ({ page }) => {
  await bootAt(page, "2026-06-15T09:00:00");

  await add(page, "expense report @today at 3pm");

  // Two days on, the page is overdue — Today keeps it, Upcoming does not.
  await page.clock.setFixedTime(new Date("2026-06-17T07:00:00"));

  await page.getByRole("button", { name: /^Upcoming/ }).click();
  await expect(
    page.locator("[data-page-list-item]").filter({ hasText: "expense report" })
  ).toHaveCount(0);

  await page.getByRole("button", { name: /^Today/ }).click();
  await page.getByRole("button", { name: /^Overdue/ }).click();
  await expect(
    page.locator("[data-page-list-item]").filter({ hasText: "expense report" })
  ).toBeVisible();
});

appTest("moving overdue pages to today clears the Overdue section @mock-only", async ({ page }) => {
  await bootAt(page, "2026-06-15T09:00:00");

  await add(page, "expense report @today at 3pm");
  await add(page, "vendor call @today at 4pm");

  await page.clock.setFixedTime(new Date("2026-06-17T07:00:00"));

  await page.getByRole("button", { name: /^Today/ }).click();
  await expect(page.getByRole("button", { name: /^Overdue/ })).toBeVisible();

  await page.getByRole("button", { name: "Move to today" }).click();

  await expect(page.getByRole("alert", { name: "Moved 2 pages to today" })).toBeVisible();
  // Both landed on today at their original times (3pm/4pm, still ahead of 07:00),
  // so the section they were in has nothing left to show.
  await expect(page.getByRole("button", { name: /^Overdue/ })).toHaveCount(0);
  const items = page.locator("[data-page-list-item]");
  await expect(items.filter({ hasText: "expense report" })).toBeVisible();
  await expect(items.filter({ hasText: "vendor call" })).toBeVisible();
});

appTest.describe("with lists loaded a window at a time", () => {
  appTest.use({ tightCache: true });

  appTest(
    "Today and Upcoming move to the new day at midnight, with nothing clicked @mock-only",
    async ({ page }) => {
      await bootAt(page, "2026-06-15T23:58:00");
      await add(page, "dentist @tomorrow at 9am");
      await add(page, "late call @today at 11:59pm");
      const items = page.locator("[data-page-list-item]");

      await page.getByRole("button", { name: /^Today/ }).click();
      await expect(items.filter({ hasText: "late call" })).toBeVisible();
      await expect(items.filter({ hasText: "dentist" })).toHaveCount(0);

      await page.clock.runFor(3 * 60_000);
      await expect(items.filter({ hasText: "dentist" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Overdue/ })).toBeVisible();

      await page.getByRole("button", { name: /^Upcoming/ }).click();
      const list = page.getByRole("group", { name: "Upcoming" });
      await expect(list.getByText(/^Today/)).toBeVisible();
      await expect(items.filter({ hasText: "dentist" })).toBeVisible();
      await expect(items.filter({ hasText: "late call" })).toHaveCount(0);
    }
  );
});
