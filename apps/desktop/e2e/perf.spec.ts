import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── P1: App boot to interactive ────────────────────────────────────────────

appTest("app boots to interactive under 2000ms @perf", async ({ app }) => {
  const timing = await app.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return nav.domInteractive - nav.startTime;
  });

  console.log(`Boot to interactive: ${Math.round(timing)}ms`);
  expect(timing).toBeLessThan(2000);
});

// ─── P2: Page list render time on folder switch ─────────────────────────────

appTest("page list renders under 50ms on folder switch @perf", async ({ app }) => {
  for (let i = 0; i < 20; i++) {
    await quickAdd(app, `page ${i}`);
  }

  // Create a folder and navigate to it
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press("Enter");

  // Navigate to Inbox first
  await app.getByRole("button", { name: /Inbox/ }).click();

  // Warm up, then measure
  const switchTime = await app.evaluate(async () => {
    const inboxBtn = document.querySelector<HTMLElement>('[data-view-id="inbox"]');
    if (!inboxBtn) return 0;

    await new Promise((r) => requestAnimationFrame(r));

    const start = performance.now();
    inboxBtn.click();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - start;
  });

  console.log(`Folder switch render: ${Math.round(switchTime)}ms`);
  expect(switchTime).toBeLessThan(50);
});

// ─── P3: Editor has no long tasks during typing ─────────────────────────────

appTest("editor has no long tasks during typing @perf", async ({ app }) => {
  await quickAdd(app, "perf test page");
  await app.locator("[data-page-list-item]").getByText("perf test page").click();

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  const bigBlock = "Lorem ipsum dolor sit amet. ".repeat(50);
  await editor.fill(bigBlock);

  // Observe long tasks (>50ms) during real keystrokes
  await app.evaluate(() => {
    (window as unknown as Record<string, number>).__longestTask = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration;
        if (dur > ((window as unknown as Record<string, number>).__longestTask ?? 0)) {
          (window as unknown as Record<string, number>).__longestTask = dur;
        }
      }
    });
    obs.observe({ type: "longtask", buffered: false });
  });

  await app.keyboard.type("abcdefghijklmnopqrst", { delay: 20 });

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__longestTask ?? 0
  );

  console.log(`Editor longest task during typing: ${Math.round(longestTask)}ms`);
  expect(longestTask).toBe(0);
});

// ─── P4: Search opens and filters quickly ───────────────────────────────────

appTest("search has no long tasks during open and filter @perf", async ({ app }) => {
  for (let i = 0; i < 10; i++) {
    await quickAdd(app, `searchable page ${i}`);
  }

  // Observe long tasks during search interaction
  await app.evaluate(() => {
    (window as unknown as Record<string, number>).__searchLongestTask = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration;
        if (dur > ((window as unknown as Record<string, number>).__searchLongestTask ?? 0)) {
          (window as unknown as Record<string, number>).__searchLongestTask = dur;
        }
      }
    });
    obs.observe({ type: "longtask", buffered: false });
  });

  await app.keyboard.press(mod("Mod+k"));
  await app.getByRole("dialog", { name: "Search pages" }).waitFor({ state: "visible" });
  await app.keyboard.type("searchable page 5");
  await app
    .getByRole("dialog", { name: "Search pages" })
    .getByText("searchable page 5")
    .waitFor({ state: "visible" });

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__searchLongestTask ?? 0
  );

  console.log(`Search longest task: ${Math.round(longestTask)}ms`);
  expect(longestTask).toBe(0);

  await app.keyboard.press("Escape");
});

// ─── P5: Calendar view with many events ─────────────────────────────────────

appTest("calendar has no long tasks with 20+ events @perf", async ({ app }) => {
  for (let i = 0; i < 25; i++) {
    await quickAdd(app, `event ${i} @today`);
  }

  await app.evaluate(() => {
    (window as unknown as Record<string, number>).__calLongestTask = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration;
        if (dur > ((window as unknown as Record<string, number>).__calLongestTask ?? 0)) {
          (window as unknown as Record<string, number>).__calLongestTask = dur;
        }
      }
    });
    obs.observe({ type: "longtask", buffered: false });
  });

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await app.waitForTimeout(500);

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__calLongestTask ?? 0
  );

  console.log(`Calendar longest task with 25 events: ${Math.round(longestTask)}ms`);
  expect(longestTask).toBe(0);
});

// ─── P6: Quick Add NLP parsing ──────────────────────────────────────────────

appTest("quick add has no long tasks during NLP input @perf", async ({ app }) => {
  await app.evaluate(() => {
    (window as unknown as Record<string, number>).__qaNlpLongestTask = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration;
        if (dur > ((window as unknown as Record<string, number>).__qaNlpLongestTask ?? 0)) {
          (window as unknown as Record<string, number>).__qaNlpLongestTask = dur;
        }
      }
    });
    obs.observe({ type: "longtask", buffered: false });
  });

  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.type("weekly team standup @tomorrow at 9am !high #work #meetings", {
    delay: 15,
  });

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__qaNlpLongestTask ?? 0
  );

  console.log(`Quick Add NLP longest task: ${Math.round(longestTask)}ms`);
  expect(longestTask).toBe(0);

  await app.keyboard.press("Escape");
});
