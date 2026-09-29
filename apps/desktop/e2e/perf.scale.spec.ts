import { expect, test } from "@playwright/test";

/**
 * How the interface behaves as the workspace grows, from twenty pages to two million.
 *
 * Deliberately measures *above* the data layer. `pikos stress bench` covers the SQLite side by
 * running the same `list_pages_impl` the desktop's Tauri command calls, so these numbers are
 * render and interaction cost with the database taken out. When one of the two regresses, the
 * split says which half moved.
 *
 * Uses the raw `page` rather than the `app` fixture: that fixture navigates and waits for the
 * workspace itself, which would boot the app once without a seed and then again with one.
 *
 * Reports rather than asserts. There are no budgets yet because nobody has measured this, and a
 * threshold invented before the first run is a number the suite would defend rather than
 * discover. Read the table it prints, then set budgets from it.
 */

// Two million is included to find the ceiling, not because it is expected to pass. Each seeded
// page is an object holding two ~70-character strings, so two million is comfortably past a
// gigabyte of JS heap and may exhaust the renderer. A failure there is a result worth recording.
const SIZES = [20, 200, 2_000, 20_000, 200_000, 2_000_000] as const;

interface Ops {
  create: number;
  read: number;
  list: number;
  search: number;
  update: number;
}

interface Row {
  pages: number;
  seedMs: number;
  bootMs: number;
  rowsMounted: number;
  readyMs: number;
  ops: Ops;
}

const results: Row[] = [];

for (const size of SIZES) {
  test(`scale: ${size} pages @perf-scale`, async ({ page }) => {
    const started = Date.now();
    await page.goto(`/?seedPages=${size}`);

    await page.waitForFunction(
      () => performance.getEntriesByName("pikos:ready", "mark").length > 0,
      undefined,
      { timeout: 540_000 }
    );
    const bootMs = Date.now() - started;

    await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible({ timeout: 120_000 });

    // How many rows the list actually put in the DOM. If this tracks the corpus rather than the
    // viewport, the list mounts everything it holds and no query fix alone will save it.
    const rowsMounted = await page.evaluate(
      () => document.querySelectorAll("[data-page-list-item]").length
    );

    // `seed` is stamped once the adapter is full and before anything renders, so ready-minus-seed
    // is what the app actually costs and the rest is the harness filling a workspace.
    const timings = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const ready = performance.getEntriesByName("pikos:ready", "mark")[0];
      const seeded = performance.getEntriesByName("pikos:seeded", "mark")[0];
      const base = nav.startTime;
      return {
        ready: ready ? Math.round(ready.startTime - base) : -1,
        seed: seeded ? Math.round(seeded.startTime - base) : 0,
      };
    });
    const readyMs = timings.ready - timings.seed;

    // Each operation timed against the full workspace, through the adapter the app uses. Run once
    // to warm any lazy path, then measured, so the figure is steady-state rather than first-touch.
    const ops = await page.evaluate(async () => {
      interface Bench {
        createPage: (d: Record<string, unknown>) => Promise<{ id: string }>;
        getPage: (id: string) => Promise<unknown>;
        listPages: (f: Record<string, unknown>) => Promise<unknown>;
        searchPages: (q: string, includeCompleted: boolean) => Promise<unknown>;
        updatePage: (id: string, u: Record<string, unknown>) => Promise<unknown>;
      }
      const store = (window as unknown as { __pikosStorage: Bench }).__pikosStorage;
      const time = async (fn: () => Promise<unknown>) => {
        await fn();
        const t0 = performance.now();
        await fn();
        return Math.round((performance.now() - t0) * 100) / 100;
      };
      const created = await store.createPage({
        content: "bench",
        contentText: "bench",
        folderId: null,
        links: [],
        priority: 0,
        status: "not_started",
        subtitle: null,
        tags: [],
        title: "bench page",
      });
      return {
        create: await time(() =>
          store.createPage({
            content: "bench",
            contentText: "bench",
            folderId: null,
            links: [],
            priority: 0,
            status: "not_started",
            subtitle: null,
            tags: [],
            title: "bench page",
          })
        ),
        list: await time(() => store.listPages({ status: "not_started" })),
        read: await time(() => store.getPage(created.id)),
        search: await time(() => store.searchPages("Seeded", false)),
        update: await time(() => store.updatePage(created.id, { title: "renamed" })),
      };
    });

    console.log(
      `      create ${ops.create} ms | read ${ops.read} ms | list ${ops.list} ms | ` +
        `search ${ops.search} ms | update ${ops.update} ms`
    );

    results.push({ bootMs, ops, pages: size, readyMs, rowsMounted, seedMs: timings.seed });
    console.log(
      `  ${String(size).padStart(9)} pages | seed ${String(timings.seed).padStart(7)} ms | ` +
        `app ${String(readyMs).padStart(6)} ms | ${rowsMounted} rows mounted`
    );
  });
}

test.afterAll(() => {
  if (results.length === 0) return;
  console.log("\n      pages    app(ms)  rows   create    read      list    search   update");
  for (const r of results) {
    console.log(
      `  ${String(r.pages).padStart(9)}  ${String(r.readyMs).padStart(8)}  ` +
        `${String(r.rowsMounted).padStart(4)}  ${String(r.ops.create).padStart(7)}  ` +
        `${String(r.ops.read).padStart(6)}  ${String(r.ops.list).padStart(8)}  ` +
        `${String(r.ops.search).padStart(8)}  ${String(r.ops.update).padStart(7)}`
    );
  }
});
