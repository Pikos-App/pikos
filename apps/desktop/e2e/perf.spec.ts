import { expect, mod, quickAdd, test as appTest } from "./fixtures";
import { assertNoBlocking, assertPerf, observeLongTasks, readLongTasks } from "./perf-helpers";

// ─── P1: App boot to interactive ────────────────────────────────────────────

appTest("app boots to interactive under 2000ms @perf", async ({ app }) => {
  // Measure to `pikos:ready` (set after AppShell mount) instead of domInteractive,
  // which fires before React mounts and so understates real time-to-interactive.
  // The mark is set inside a useEffect on first AppShell render, so wait for it.
  await app.waitForFunction(
    () => performance.getEntriesByName("pikos:ready", "mark").length > 0
  );

  const timing = await app.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation"
    )[0] as unknown as PerformanceNavigationTiming;
    const ready = performance.getEntriesByName("pikos:ready", "mark")[0];
    if (!ready) return -1;
    return ready.startTime - nav.startTime;
  });

  assertPerf("p1.boot_to_ready", timing, 2000);
});

// ─── P2: Page list render time on folder switch ─────────────────────────────

appTest("page list renders under 50ms on folder switch @perf", async ({ app }) => {
  for (let i = 0; i < 20; i++) {
    await quickAdd(app, `page ${i}`);
  }

  // Create + activate a new (empty) folder. Folder creation activates the new
  // folder, so after Enter the user is sitting on an empty page list — the
  // in-eval Inbox click below is then a real transition from 0 → 20 items.
  await app
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await app.keyboard.press("Enter");

  const switchTime = await app.evaluate(async () => {
    const inboxBtn = document.querySelector<HTMLElement>("#nav-inbox");
    if (!inboxBtn) return -1;

    await new Promise((r) => requestAnimationFrame(r));

    // Measure click → DOM settle via MutationObserver: more robust than counting
    // rAFs (which can miss a late React commit). The metric reports `lastMutation -
    // click`, so the trailing-idle detection window does not inflate the value.
    return new Promise<number>((resolve) => {
      const start = performance.now();
      let firstMutationAt: number | null = null;
      let lastMutationAt = start;
      const obs = new MutationObserver(() => {
        if (firstMutationAt === null) firstMutationAt = performance.now();
        lastMutationAt = performance.now();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      inboxBtn.click();
      const tick = () => {
        const now = performance.now();
        if (firstMutationAt !== null && now - lastMutationAt > 16) {
          obs.disconnect();
          resolve(lastMutationAt - start);
        } else if (now - start > 1000) {
          obs.disconnect();
          resolve(firstMutationAt === null ? -1 : lastMutationAt - start);
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  });

  expect(switchTime).toBeGreaterThanOrEqual(0); // sanity: -1 means no DOM change observed
  assertPerf("p2.folder_switch", switchTime, 50);
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

  assertNoBlocking("p3.editor_typing", await readLongTasks(app, "__perfEditor"));
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

  assertNoBlocking("p4.search_filter", await readLongTasks(app, "__perfSearch"));

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
  // Yield until the browser is idle so any post-mount long tasks (calendar layout,
  // event placement) get reported before we read. Falls back to a small timeout
  // for browsers without requestIdleCallback.
  await app.evaluate(
    () =>
      new Promise<void>((r) => {
        const w = window as unknown as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
        };
        if (typeof w.requestIdleCallback === "function") {
          w.requestIdleCallback(() => r(), { timeout: 500 });
        } else {
          setTimeout(r, 250);
        }
      })
  );

  assertNoBlocking("p5.calendar_open", await readLongTasks(app, "__perfCal"));
});

// ─── P6: Quick Add NLP parsing ──────────────────────────────────────────────

appTest("quick add has no long tasks during NLP input @perf", async ({ app }) => {
  await observeLongTasks(app, "__perfQA");

  await app.keyboard.press(mod("Mod+n"));
  await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
  await app.keyboard.type("weekly team standup @tomorrow at 9am !high #work #meetings", {
    delay: 15,
  });

  assertNoBlocking("p6.quick_add_nlp", await readLongTasks(app, "__perfQA"));

  await app.keyboard.press("Escape");
});
