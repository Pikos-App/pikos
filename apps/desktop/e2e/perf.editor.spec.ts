import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { mod } from "./fixtures";

/**
 * What it costs to open, type in, split and search a page as it grows, on the two shapes a long
 * page really takes: prose with headings, lists, tasks, quotes, code and marks, and a journal's log
 * of short dated lines.
 *
 * Storage is not the question: `pikos stress bench` reads a 200,000-word page from SQLite in
 * 0.49 ms and saves it in 10.5 ms. Everything slow about a large page is the editor, so the
 * in-memory adapter is a fair stand-in here.
 *
 * Every time runs from the input event to the first task after the next frame, so layout and paint
 * are inside it, plus up to a frame of vsync. Timing until the driver's call returns stopped
 * before layout, and reported a 123 ms keystroke as 28 ms.
 *
 * A gate, run locally: on a shared runner these times only report. Each ceiling started at about
 * twice what an M2 Air measured in WebKit on 2026-10-19, so noise can't trip it and a regression
 * that doubles a cost does. A speed fix moves the ceilings for what it sped up to between its new
 * time and the old one, which is what makes reverting it fail.
 *
 *   pnpm --filter @pikos/desktop test:e2e:scale
 */

type Shape = "prose" | "log";

interface Ceiling {
  open: number;
  key: number;
  enter: number;
  findFirst: number;
  findLater: number;
  findNext: number;
}

const CEILINGS: Record<Shape, Record<number, Ceiling>> = {
  log: {
    20_000: { enter: 55, findFirst: 45, findLater: 35, findNext: 15, key: 30, open: 150 },
    100_000: { enter: 240, findFirst: 90, findLater: 60, findNext: 45, key: 20, open: 400 },
    500_000: { enter: 1_200, findFirst: 300, findLater: 240, findNext: 190, key: 90, open: 1_600 },
  },
  prose: {
    20_000: { enter: 40, findFirst: 60, findLater: 40, findNext: 20, key: 30, open: 240 },
    100_000: { enter: 140, findFirst: 180, findLater: 110, findNext: 80, key: 28, open: 700 },
    500_000: { enter: 800, findFirst: 800, findLater: 650, findNext: 420, key: 150, open: 3_200 },
  },
};

const EDITOR = '[aria-label="Page content"][data-page-id="seed-1"]';
const KEY_SAMPLES = 15;
const ENTER_SAMPLES = 5;

/** Arms a timer on the next `type` event that resolves once the frame after it has painted. */
async function armPaintTimer(page: Page, type: "keydown" | "pointerdown", drawn?: string) {
  await page.evaluate(
    ({ selector, type }) => {
      const w = window as unknown as { __paintTimer?: Promise<number> };
      w.__paintTimer = new Promise((resolve) => {
        addEventListener(
          type,
          () => {
            const start = performance.now();
            const afterPaint = () => {
              requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start)));
            };
            if (!selector) {
              afterPaint();
              return;
            }

            const observer = new MutationObserver(() => {
              if (!document.querySelector(selector)) return;
              observer.disconnect();
              afterPaint();
            });
            observer.observe(document.body, {
              attributeFilter: ["data-page-id"],
              childList: true,
              subtree: true,
            });
          },
          { capture: true, once: true }
        );
      });
    },
    { selector: drawn, type }
  );
}

function readPaintTimer(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __paintTimer: Promise<number> }).__paintTimer);
}

async function pressTimed(page: Page, key: string): Promise<number> {
  await armPaintTimer(page, "keydown");
  await page.keyboard.press(key);

  return Math.round(await readPaintTimer(page));
}

async function median(page: Page, key: string, samples: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) times.push(await pressTimed(page, key));
  times.sort((a, b) => a - b);

  return times[Math.floor(times.length / 2)] ?? -1;
}

const SHAPES: Shape[] = ["prose", "log"];
const SIZES = [20_000, 100_000, 500_000] as const;
const rows: string[] = [];

for (const shape of SHAPES) {
  for (const words of SIZES) {
    test(`editor: ${words}-word ${shape} page @perf-scale`, async ({ page }) => {
      const ceiling = CEILINGS[shape][words];
      if (!ceiling) throw new Error(`no ceiling for ${words} words of ${shape}`);

      await page.goto(`/?seedPages=2&bodyWords=${words}&bodyShape=${shape}`);
      await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible({
        timeout: 120_000,
      });

      await armPaintTimer(page, "pointerdown", EDITOR);
      await page.getByLabel("Seeded page 1", { exact: true }).click();
      const open = Math.round(await readPaintTimer(page));

      // A body the editor can't parse opens empty and times as instant, which the first version of
      // this spec reported as a result.
      const editor = page.locator(EDITOR);
      const blocks = await editor.locator(":scope > p").count();
      const held = await editor.evaluate((el) =>
        [...el.querySelectorAll("p, h2, h3, pre code")].reduce(
          (n, block) => n + (block.textContent?.split(" ").filter(Boolean).length ?? 0),
          0
        )
      );
      expect(held).toBe(words);

      // Mid-page, where a split reflows the most below it.
      await editor.locator(":scope > p").nth(Math.floor(blocks / 2)).click();
      // The first press after a click carries focus work unrelated to size.
      await page.keyboard.press("x");
      const key = await median(page, "x", KEY_SAMPLES);
      const enter = await median(page, "Enter", ENTER_SAMPLES);

      await page.keyboard.press(mod("Mod+f"));
      await expect(page.getByPlaceholder("Find…")).toBeFocused();
      const findFirst = await pressTimed(page, "t");
      const findLater = Math.max(await pressTimed(page, "h"), await pressTimed(page, "e"));
      await expect(page.getByText(/^1 of [1-9]/)).toBeVisible();
      const findNext = await pressTimed(page, "Enter");

      rows.push(
        `  ${shape.padEnd(5)} ${String(words).padStart(7)}  ${String(open).padStart(6)}  ` +
          `${String(key).padStart(5)}  ${String(enter).padStart(5)}  ` +
          `${String(findFirst).padStart(9)}  ${String(findLater).padStart(9)}  ` +
          `${String(findNext).padStart(8)}`
      );

      expect.soft(open, "open to paint").toBeLessThan(ceiling.open);
      expect.soft(key, "keystroke to paint").toBeLessThan(ceiling.key);
      expect.soft(enter, "Enter mid-page to paint").toBeLessThan(ceiling.enter);
      expect.soft(findFirst, "Find's first letter").toBeLessThan(ceiling.findFirst);
      expect.soft(findLater, "Find's later letters").toBeLessThan(ceiling.findLater);
      expect.soft(findNext, "Find's next match").toBeLessThan(ceiling.findNext);
    });
  }
}

test.afterAll(() => {
  if (rows.length === 0) return;

  console.log("\n  shape   words    open    key  enter  find(1st)  find(2-3)  find(next)");
  for (const row of rows) console.log(row);
});
