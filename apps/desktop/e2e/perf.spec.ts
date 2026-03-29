import { expect, mod, quickAdd, test as appTest } from "./fixtures";
import { assertNoLongTasks, assertPerf, getLongestTask, observeLongTasks } from "./perf-helpers";

// ─── P1: App boot to interactive ────────────────────────────────────────────

appTest("app boots to interactive under 2000ms @perf", async ({ app }) => {
  const timing = await app.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation"
    )[0] as unknown as PerformanceNavigationTiming;
    return nav.domInteractive - nav.startTime;
  });

  assertPerf(timing, 2000);
});

// ─── P2: Page list render time on folder switch ─────────────────────────────

appTest("page list renders under 50ms on folder switch @perf", async ({ app }) => {
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

  assertPerf(switchTime, 50);
});

// ─── P3: Editor has no long tasks during typing ─────────────────────────────

appTest("editor has no long tasks during typing @perf", async ({ app }) => {
  await quickAdd(app, "perf test page");
  await app.locator("[data-page-list-item]").getByText("perf test page").click();

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await editor.fill("Lorem ipsum dolor sit amet. ".repeat(50));

  await observeLongTasks(app, "__perfEditor");
  await app.keyboard.type("abcdefghijklmnopqrst", { delay: 20 });

  assertNoLongTasks(await getLongestTask(app, "__perfEditor"));
});

// ─── P4: Search has no long tasks ───────────────────────────────────────────

appTest("search has no long tasks during open and filter @perf", async ({ app }) => {
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

  assertNoLongTasks(await getLongestTask(app, "__perfSearch"));

  await app.keyboard.press("Escape");
});

// ─── P5: Calendar view with many events ─────────────────────────────────────

appTest("calendar has no long tasks with 20+ events @perf", async ({ app }) => {
  for (let i = 0; i < 25; i++) {
    await quickAdd(app, `event ${i} @today`);
  }

  await observeLongTasks(app, "__perfCal");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await app.waitForTimeout(500);

  assertNoLongTasks(await getLongestTask(app, "__perfCal"));
});

// ─── P6: Quick Add NLP parsing ──────────────────────────────────────────────

appTest("quick add has no long tasks during NLP input @perf", async ({ app }) => {
  await observeLongTasks(app, "__perfQA");

  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.type("weekly team standup @tomorrow at 9am !high #work #meetings", {
    delay: 15,
  });

  assertNoLongTasks(await getLongestTask(app, "__perfQA"));

  await app.keyboard.press("Escape");
});
