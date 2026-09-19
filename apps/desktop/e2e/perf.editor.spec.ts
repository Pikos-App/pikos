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
 * UNFINISHED as of 2026-09-18 — it hung and produced no output. Fifteen minutes across four sizes
 * with nothing printed, which is one of two things and nobody has separated them yet:
 *
 *   - the page-row selector below never matches, so each test sits on its 120 s timeout; or
 *   - opening a 200,000-word document in ProseMirror genuinely takes that long, which would be
 *     the finding this spec exists to produce.
 *
 * Diagnose before trusting anything it prints: run it with only BODY_SIZES = [50] and `--headed`.
 * If fifty words is instant, the selector is fine and the large sizes are a real result. If fifty
 * words also hangs, the selector is wrong and no size number here means anything.
 *
 * Reports rather than asserts. Set budgets from what it prints.
 *
 *   pnpm --filter @pikos/desktop test:e2e:scale
 */

// Words per page. A note, a long article, a book chapter, and something past what anyone types by
// hand — the last is there to find the ceiling, not to represent a real document.
const BODY_SIZES = [50] as const;

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
    await page.getByRole("button", { name: /Seeded page 1\b/ }).first().click();
    const editor = page.getByRole("textbox", { name: "Page content" });
    await editor.waitFor({ state: "visible", timeout: 120_000 });
    const openMs = Date.now() - openStart;

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
    console.log(`  ${String(words).padStart(7)} words | open ${openMs} ms | keystroke ${keystrokeMs} ms`);
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
