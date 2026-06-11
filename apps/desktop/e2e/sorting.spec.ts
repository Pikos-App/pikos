// E2E coverage for the page-list sort modes. The persistence spec asserts
// that the sort *toggle* survives reload; this spec asserts that picking a
// sort mode actually re-orders the list. A regression in any of the three
// comparators (title/date/priority) would slip through unit tests if the
// toggle UI just stored the value without applying it.

import type { Page } from "@playwright/test";

import { expect, quickAdd, test as appTest } from "./fixtures";

async function setSort(app: Page, mode: "Date" | "Title" | "Priority" | "Manual") {
  await app.getByRole("button", { name: /^Sort:/ }).click();
  await app.getByRole("menuitem", { name: mode }).click();
  // Sort chip's accessible name reflects the picked value.
  await expect(
    app.getByRole("button", { name: `Sort: ${mode.toLowerCase()}` })
  ).toBeVisible();
}

/** Read the visible page-list-item titles in document order. Returns
 *  trimmed title strings — page-list rows include badges/dates after the
 *  title but the title itself is the first non-checkbox text. */
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

// ─── Sort by Title actually orders alphabetically ──────────────────────────

appTest("sort by Title orders the page list alphabetically @tier2", async ({ app }) => {
  // Seed pages out of alphabetical order so a no-op (manual) sort would
  // leave them in insertion order. Each title leads with a unique letter
  // we can match against.
  await quickAdd(app, "charlie note");
  await quickAdd(app, "alpha note");
  await quickAdd(app, "bravo note");

  // Default is "manual" — insertion order. Confirm via the chip label.
  await expect(app.getByRole("button", { name: "Sort: manual" })).toBeVisible();

  await setSort(app, "Title");

  // Verify the rendered order: alpha → bravo → charlie. Each title's first
  // word is enough to assert order without coupling to the trailing date
  // chip text.
  const titles = await visibleTitles(app);
  const aIdx = titles.findIndex((t) => t.startsWith("alpha note"));
  const bIdx = titles.findIndex((t) => t.startsWith("bravo note"));
  const cIdx = titles.findIndex((t) => t.startsWith("charlie note"));
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThan(aIdx);
  expect(cIdx).toBeGreaterThan(bIdx);
});

// ─── Sort by Date orders by scheduledStart ─────────────────────────────────

appTest("sort by Date orders the page list by schedule @tier2", async ({ app }) => {
  // Use NLP patterns mirrored from quick-add.spec.ts that are known to
  // produce the expected schedule. Bare day-of-week words ("morning",
  // "evening") and ambiguous nouns ("lunch", "run") can confuse chrono
  // when they precede a date, so anchor each page on @<date> markers
  // instead.
  await quickAdd(app, "alpha today");
  await quickAdd(app, "bravo @tomorrow at 9am");
  await quickAdd(app, "charlie on Dec 28");

  // Confirm each page actually got a schedule chip — if any didn't,
  // the date sort assertion below would race the no-schedule fallback.
  // The chip shows absolute "MMM d" dates by default (relative "Today" is
  // opt-in via the chip toggle), so derive the expected labels from the run
  // date to stay correct on any day.
  const monthDay = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  const now = new Date();
  const today = monthDay(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const tomorrow = monthDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const list = app.locator("[data-page-list-item]");
  await expect(list.filter({ hasText: "alpha" })).toContainText(today);
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

// ─── Sort by Priority orders Urgent → Low ──────────────────────────────────

appTest("sort by Priority orders the page list Urgent first @tier2", async ({ app }) => {
  // Three pages with explicit priorities. !1=Urgent, !2=High, !low=Low.
  // Pick titles that don't start with priority labels so we can assert via
  // the leading text.
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
