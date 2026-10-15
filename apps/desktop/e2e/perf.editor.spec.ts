import { expect, test } from "@playwright/test";

/**
 * What it costs to open and type in a page as the document grows.
 *
 * Storage is not the question here and has already been answered: `pikos stress bench` reads a
 * 200,000-word page from SQLite in 0.49 ms and saves it in 10.5 ms. So anything slow about a large
 * page is the editor, not the database, and the editor is frontend — which makes the in-memory
 * adapter a fair stand-in for once, because nothing being measured goes near storage.
 *
 * The specific worry is that the editor renders the whole ProseMirror document with no windowing,
 * so a long page degrades typing rather than only loading. These numbers are how we find out.
 *
 * Each size checks the editor holds its words before trusting the time: a body the editor can't
 * parse opens as an empty page, and the first numbers this spec printed timed exactly that.
 *
 * Reports rather than asserts. Set budgets from what it prints.
 *
 *   pnpm --filter @pikos/desktop test:e2e:scale
 */

// Words per page. A note, a long article, a book chapter, and something past what anyone types by
// hand — the last is there to find the ceiling, not to represent a real document.
const BODY_SIZES = [50, 2_000, 20_000, 200_000] as const;

interface Row {
  words: number;
  openMs: number;
  keystrokeMs: number;
}

const results: Row[] = [];

for (const words of BODY_SIZES) {
  test(`editor: ${words}-word page @perf-scale`, async ({ page }) => {
    await page.goto(`/?seedPages=30&bodyWords=${words}`);
    await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible({ timeout: 120_000 });

    const openStart = Date.now();
    await page.getByLabel("Seeded page 1", { exact: true }).click();
    // Drawn once the editor holds this page, which it marks; a box with nothing in it isn't open.
    const editor = page.locator('[aria-label="Page content"][data-page-id="seed-1"]');
    await editor.waitFor({ state: "visible", timeout: 120_000 });
    const openMs = Date.now() - openStart;
    const held = await editor.evaluate((el) =>
      [...el.querySelectorAll("p")].reduce((n, p) => n + (p.textContent?.split(" ").length ?? 0), 0)
    );
    expect(held).toBeGreaterThanOrEqual(words);

    await editor.click();

    // Median, not one sample: the first press after a click carries focus work unrelated to size.
    const samples: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t0 = Date.now();
      await page.keyboard.type("x");
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const keystrokeMs = samples[Math.floor(samples.length / 2)] ?? -1;

    results.push({ keystrokeMs, openMs, words });
    console.log(
      `  ${String(words).padStart(7)} words | open ${openMs} ms | keystroke ${keystrokeMs} ms`
    );
  });
}

test.afterAll(() => {
  if (results.length === 0) return;
  console.log("\n    words   open(ms)  keystroke(ms)");
  for (const r of results) {
    console.log(
      `  ${String(r.words).padStart(7)}  ${String(r.openMs).padStart(9)}  ` +
        `${String(r.keystrokeMs).padStart(13)}`
    );
  }
});
