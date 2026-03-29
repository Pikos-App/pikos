import { expect, mod, quickAdd, test as appTest } from "./fixtures";
import {
  assertNoLongTasks,
  assertPerf,
  getLongestTask,
  observeLongTasks,
} from "./perf-helpers";

/**
 * Prod-build perf tests. Locally these hard-fail against the quality bar.
 * In CI (PERF_WARN_ONLY=true), they log results but never fail the build.
 *
 * Run locally: pnpm --filter @pikos/desktop test:e2e:perf:prod
 * Run in CI:   PERF_WARN_ONLY=true pnpm --filter @pikos/desktop test:e2e:perf:prod
 */

const WARN_ONLY = process.env["PERF_WARN_ONLY"] === "true";

// ─── P1: App boot to interactive (<500ms) ───────────────────────────────────

appTest("app boots to interactive under 500ms @perf-prod", async ({ app }) => {
  const timing = await app.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation"
    )[0] as unknown as PerformanceNavigationTiming;
    return nav.domInteractive - nav.startTime;
  });

  assertPerf(timing, 500, WARN_ONLY);
});

// ─── P2: Page list render time on folder switch (<16ms) ─────────────────────

appTest("page list renders under 16ms on folder switch @perf-prod", async ({ app }) => {
  for (let i = 0; i < 20; i++) {
    await quickAdd(app, `page ${i}`);
  }

  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press("Enter");

  await app.getByRole("button", { name: /Inbox/ }).click();

  const switchTime = await app.evaluate(async () => {
    const inboxBtn = document.querySelector<HTMLElement>('[data-view-id="inbox"]');
    if (!inboxBtn) return 0;

    await new Promise((r) => requestAnimationFrame(r));

    const start = performance.now();
    inboxBtn.click();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - start;
  });

  assertPerf(switchTime, 16, WARN_ONLY);
});

// ─── P3: Editor — no long tasks during typing ───────────────────────────────

appTest("editor has no long tasks during typing @perf-prod", async ({ app }) => {
  await quickAdd(app, "perf test page");
  await app.locator("[data-page-list-item]").getByText("perf test page").click();

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await editor.fill("Lorem ipsum dolor sit amet. ".repeat(50));

  await observeLongTasks(app, "__perfEditor");
  await app.keyboard.type("abcdefghijklmnopqrst", { delay: 20 });

  assertNoLongTasks(await getLongestTask(app, "__perfEditor"), WARN_ONLY);
});

// ─── P4: Search — no long tasks during open and filter ──────────────────────

appTest("search has no long tasks during open and filter @perf-prod", async ({ app }) => {
  for (let i = 0; i < 10; i++) {
    await quickAdd(app, `searchable page ${i}`);
  }

  await observeLongTasks(app, "__perfSearch");

  await app.keyboard.press(mod("Mod+k"));
  await app.getByRole("dialog", { name: "Search pages" }).waitFor({ state: "visible" });
  await app.keyboard.type("searchable page 5");
  await app
    .getByRole("dialog", { name: "Search pages" })
    .getByText("searchable page 5")
    .waitFor({ state: "visible" });

  assertNoLongTasks(await getLongestTask(app, "__perfSearch"), WARN_ONLY);

  await app.keyboard.press("Escape");
});

// ─── P5: Calendar — no long tasks with 20+ events ──────────────────────────

appTest("calendar has no long tasks with 20+ events @perf-prod", async ({ app }) => {
  for (let i = 0; i < 25; i++) {
    await quickAdd(app, `event ${i} @today`);
  }

  await observeLongTasks(app, "__perfCal");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await app.waitForTimeout(500);

  assertNoLongTasks(await getLongestTask(app, "__perfCal"), WARN_ONLY);
});

// ─── P6: Quick Add — no long tasks during NLP input ─────────────────────────

appTest("quick add has no long tasks during NLP input @perf-prod", async ({ app }) => {
  await observeLongTasks(app, "__perfQA");

  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.type("weekly team standup @tomorrow at 9am !high #work #meetings", {
    delay: 15,
  });

  assertNoLongTasks(await getLongestTask(app, "__perfQA"), WARN_ONLY);

  await app.keyboard.press("Escape");
});
