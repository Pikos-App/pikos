// Round-trip coverage for the two Today/Upcoming product surfaces whose logic is
// unit-pinned in core: the Upcoming view's day grouping, and the Overdue
// section's bulk "Move to today".
//
// Both use the raw `page` fixture rather than `app` so the clock can be installed
// before the app boots — "overdue" and "the next seven days" only exist relative
// to a known now, and a wall-clock test would drift into a different set of day
// headers depending on the weekday CI happens to run on.

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

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

// ─── Upcoming groups the window by day ──────────────────────────────────────

appTest("upcoming groups the next seven days by day @tier2", async ({ page }) => {
  await bootAt(page, "2026-06-15T09:00:00");

  await add(page, "site visit @today at 3pm");
  await add(page, "design review @tomorrow at 9am");
  await add(page, "quarter retro @friday at 2pm");

  await page.getByRole("button", { name: /^Upcoming/ }).click();

  const list = page.getByRole("group", { name: "Upcoming" });
  // Today and Tomorrow are named; anything further out is weekday + date.
  await expect(list.getByText(/^Today/)).toBeVisible();
  await expect(list.getByText(/^Tomorrow/)).toBeVisible();
  await expect(list.getByText(/Jun 19/)).toBeVisible();

  const items = page.locator("[data-page-list-item]");
  await expect(items.filter({ hasText: "site visit" })).toBeVisible();
  await expect(items.filter({ hasText: "design review" })).toBeVisible();
  await expect(items.filter({ hasText: "quarter retro" })).toBeVisible();
});

// ─── Upcoming is not a second Today ─────────────────────────────────────────

appTest("upcoming leaves overdue pages to the Today view @tier2", async ({ page }) => {
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

// ─── Bulk "Move to today" on the Overdue header ─────────────────────────────

appTest("moving overdue pages to today clears the Overdue section @tier2", async ({ page }) => {
  await bootAt(page, "2026-06-15T09:00:00");

  await add(page, "expense report @today at 3pm");
  await add(page, "vendor call @today at 4pm");

  await page.clock.setFixedTime(new Date("2026-06-17T07:00:00"));

  await page.getByRole("button", { name: /^Today/ }).click();
  await expect(page.getByRole("button", { name: /^Overdue/ })).toBeVisible();

  await page.getByRole("button", { name: "Move to today" }).click();

  await expect(page.getByRole("alert", { name: "Moved 2 to today" })).toBeVisible();
  // Both landed on today at their original times (3pm/4pm, still ahead of 07:00),
  // so the section they were in has nothing left to show.
  await expect(page.getByRole("button", { name: /^Overdue/ })).toHaveCount(0);
  const items = page.locator("[data-page-list-item]");
  await expect(items.filter({ hasText: "expense report" })).toBeVisible();
  await expect(items.filter({ hasText: "vendor call" })).toBeVisible();
});
