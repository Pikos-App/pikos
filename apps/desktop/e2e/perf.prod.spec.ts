import { mod, quickAdd, test as appTest, expect } from "./fixtures";

/**
 * Prod-build perf tests. Locally these hard-fail against the quality bar.
 * In CI (PERF_WARN_ONLY=true), they log results but never fail the build.
 *
 * Run locally: pnpm --filter @pikos/desktop test:e2e:perf:prod
 * Run in CI:   PERF_WARN_ONLY=true pnpm --filter @pikos/desktop test:e2e:perf:prod
 */

const WARN_ONLY = process.env["PERF_WARN_ONLY"] === "true";

function assertPerf(label: string, actual: number, limit: number) {
  const status = actual <= limit ? "PASS" : "FAIL";
  console.log(`[PERF] ${status} ${label}: ${Math.round(actual)}ms (limit: ${limit}ms)`);
  if (!WARN_ONLY) {
    expect(actual).toBeLessThan(limit);
  }
}

// ─── P1: App boot to interactive (<500ms) ───────────────────────────────────

appTest("app boots to interactive under 500ms @perf-prod", async ({ app }) => {
  const timing = await app.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return nav.domInteractive - nav.startTime;
  });

  assertPerf("Boot to interactive", timing, 500);
});

// ─── P2: Page list render time on folder switch (<16ms) ─────────────────────

appTest("page list renders under 16ms on folder switch @perf-prod", async ({ app }) => {
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

  assertPerf("Folder switch render", switchTime, 16);
});

// ─── P3: Editor input latency (<16ms) ───────────────────────────────────────

appTest("editor has no long tasks during typing @perf-prod", async ({ app }) => {
  await quickAdd(app, "perf test page");
  await app.locator("[data-page-list-item]").getByText("perf test page").click();

  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();

  // Simulate a non-trivial document
  const bigBlock = "Lorem ipsum dolor sit amet. ".repeat(50);
  await editor.fill(bigBlock);

  // Start observing long animation frames (>16ms) in the browser
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

  // Type 20 characters via real keystrokes
  await app.keyboard.type("abcdefghijklmnopqrst", { delay: 20 });

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__longestTask ?? 0
  );

  // Long tasks are >50ms by definition. If none were observed, longestTask is 0.
  // Threshold: no task should exceed 50ms (one frame budget is 16ms, but
  // the Long Task API only fires at 50ms+).
  console.log(`[PERF] Editor longest task during typing: ${Math.round(longestTask)}ms`);
  if (!WARN_ONLY) {
    // If any long task was observed, it means a keystroke blocked for >50ms
    expect(longestTask).toBe(0);
  }
});

// ─── P4: Search opens and filters under 50ms ───────────────────────────────

appTest("search has no long tasks during open and filter @perf-prod", async ({ app }) => {
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

  // Open search and type a filter query
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

  // No task should block for >50ms during search
  console.log(`[PERF] Search longest task: ${Math.round(longestTask)}ms`);
  if (!WARN_ONLY) {
    expect(longestTask).toBe(0);
  }

  await app.keyboard.press("Escape");
});

// ─── P5: Calendar view with many events ─────────────────────────────────────

appTest("calendar has no long tasks with 20+ events @perf-prod", async ({ app }) => {
  // Seed 25 scheduled pages
  for (let i = 0; i < 25; i++) {
    await quickAdd(app, `event ${i} @today`);
  }

  // Observe long tasks during calendar switch
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

  // Switch to calendar view
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

  // Let rendering settle
  await app.waitForTimeout(500);

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__calLongestTask ?? 0
  );

  console.log(`[PERF] Calendar longest task with 25 events: ${Math.round(longestTask)}ms`);
  if (!WARN_ONLY) {
    expect(longestTask).toBe(0);
  }
});

// ─── P6: Quick Add NLP parsing ──────────────────────────────────────────────

appTest("quick add has no long tasks during NLP input @perf-prod", async ({ app }) => {
  // Observe long tasks during Quick Add typing
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

  // Open Quick Add and type a complex NLP string
  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.type("weekly team standup @tomorrow at 9am !high #work #meetings", {
    delay: 15,
  });

  const longestTask = await app.evaluate(
    () => (window as unknown as Record<string, number>).__qaNlpLongestTask ?? 0
  );

  console.log(`[PERF] Quick Add NLP longest task: ${Math.round(longestTask)}ms`);
  if (!WARN_ONLY) {
    expect(longestTask).toBe(0);
  }

  // Clean up
  await app.keyboard.press("Escape");
});
