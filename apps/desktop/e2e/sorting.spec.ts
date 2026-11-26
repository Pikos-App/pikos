import type { Page } from "@playwright/test";

import { test as appTest, dayFrom, expect, quickAdd } from "./fixtures";

async function setSort(app: Page, mode: "Date" | "Title" | "Priority" | "Manual") {
  await app.getByRole("button", { name: /^Sort:/ }).click();
  await app.getByRole("menuitem", { name: mode }).click();
  await expect(app.getByRole("button", { name: `Sort: ${mode.toLowerCase()}` })).toBeVisible();
}

/** The visible page-list-item titles in document order, trimmed: rows carry badges and dates after the title. */
async function visibleTitles(app: Page): Promise<string[]> {
  const items = app.locator("[data-page-list-item]");
  const count = await items.count();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).textContent()) ?? "";
    out.push(text.trim());
  }
  return out;
}

appTest("sort by Title orders the page list alphabetically", async ({ app }) => {
  // Seed out of alphabetical order so a no-op sort leaves insertion order; each title leads with a unique letter.
  await quickAdd(app, "charlie note");
  await quickAdd(app, "alpha note");
  await quickAdd(app, "bravo note");

  await expect(app.getByRole("button", { name: "Sort: manual" })).toBeVisible();

  await setSort(app, "Title");

  const titles = await visibleTitles(app);
  const aIdx = titles.findIndex((t) => t.startsWith("alpha note"));
  const bIdx = titles.findIndex((t) => t.startsWith("bravo note"));
  const cIdx = titles.findIndex((t) => t.startsWith("charlie note"));
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThan(aIdx);
  expect(cIdx).toBeGreaterThan(bIdx);
});

appTest("sort by Date orders the page list by schedule", async ({ app }) => {
  // Anchor each page on @<date> markers: bare weekday words and ambiguous nouns confuse chrono before a date.
  await quickAdd(app, "alpha today");
  await quickAdd(app, "bravo @tomorrow at 9am");
  await quickAdd(app, "charlie on Dec 28");

  // Each page must have a schedule chip, or the date-sort assertion races the no-schedule fallback.
  // An all-day page due today reads "Today"; the others read "MMM d".
  const { monthDay: tomorrow } = await dayFrom(app, 1);
  const list = app.locator("[data-page-list-item]");
  await expect(list.filter({ hasText: "alpha" })).toContainText("Today");
  await expect(list.filter({ hasText: "bravo" })).toContainText(tomorrow);
  await expect(list.filter({ hasText: "charlie" })).toContainText(/Dec 28/);

  await setSort(app, "Date");

  const titles = await visibleTitles(app);
  const todayIdx = titles.findIndex((t) => t.startsWith("alpha"));
  const tomorrowIdx = titles.findIndex((t) => t.startsWith("bravo"));
  const decemberIdx = titles.findIndex((t) => t.startsWith("charlie"));
  expect(todayIdx).toBeGreaterThanOrEqual(0);
  expect(tomorrowIdx).toBeGreaterThan(todayIdx);
  expect(decemberIdx).toBeGreaterThan(tomorrowIdx);
});

appTest("sort by Priority orders the page list Urgent first", async ({ app }) => {
  // !1=Urgent, !2=High, !low=Low. Titles don't start with priority labels, so assertions use the leading text.
  await quickAdd(app, "minor cleanup !low");
  await quickAdd(app, "build issue !1");
  await quickAdd(app, "design draft !2");

  await setSort(app, "Priority");

  const titles = await visibleTitles(app);
  const urgentIdx = titles.findIndex((t) => t.startsWith("build issue"));
  const highIdx = titles.findIndex((t) => t.startsWith("design draft"));
  const lowIdx = titles.findIndex((t) => t.startsWith("minor cleanup"));
  expect(urgentIdx).toBeGreaterThanOrEqual(0);
  expect(highIdx).toBeGreaterThan(urgentIdx);
  expect(lowIdx).toBeGreaterThan(highIdx);
});
