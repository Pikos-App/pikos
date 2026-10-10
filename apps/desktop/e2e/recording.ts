// What the marketing recordings share: the take harness, the framed opening on the
// week, and a visible fake cursor with the gestures that drive it. Playwright's own
// pointer never paints into the video, so every move a viewer should see goes
// through `window.__moveCursor` as well as the real mouse.

import { writeFileSync } from "fs";
import { join } from "path";

import type { Browser, Locator, Page } from "@playwright/test";

import { mod } from "./fixtures";

const RECORDINGS_DIR = join(import.meta.dirname, "..", "recordings");

/**
 * Monday 11 am. The marketing seeds lay the week out from day 0, and at 11 the "now"
 * line sits at the bottom edge of Monday's 9–11 Roadmap planning block, the meeting
 * that just wrapped. The seeds read only the date part, so the hour moves no event.
 */
export const RECORDING_DATE = new Date("2026-03-16T11:00:00");

export type Theme = "dark" | "light";

const DEFAULT_CURSOR_TRAVEL_MS = 350;
const cursorTravel = new WeakMap<Page, number>();

/**
 * Record one take of `flow` into recordings/<take>/, which scripts/record.sh encodes.
 * `flow` returns the wall-clock moment the finished video should open on.
 *
 * Each take writes its own measured prefix beside the .webm rather than the script
 * applying a fixed cut: the first take waits on a cold Vite server, and a fixed cut
 * fitted to the light video shipped two seconds of white on the dark one.
 */
export async function recordTake(
  browser: Browser,
  take: string,
  theme: Theme,
  flow: (page: Page) => Promise<number>
): Promise<void> {
  const videoDir = join(RECORDINGS_DIR, take);
  const ctx = await browser.newContext({
    recordVideo: {
      dir: videoDir,
      size: { height: 800, width: 1280 },
    },
    viewport: { height: 800, width: 1280 },
  });

  const captureStartedAt = Date.now();

  const page = await ctx.newPage();
  await page.addInitScript(`localStorage.setItem('pikos-theme', '${theme}')`);

  await page.clock.install({ time: RECORDING_DATE });
  await page.clock.resume();

  await page.goto("/");
  await page.waitForSelector('[role="main"][aria-label="Workspace"]', { timeout: 10000 });
  await page.waitForTimeout(500);

  const cutAt = await flow(page);

  await ctx.close();

  const videoPath = await page.video()!.path();
  writeFileSync(`${videoPath}.trim`, String((cutAt - captureStartedAt) / 1000));
}

/**
 * Switch to the week calendar, frame the morning, and return the moment the
 * finished video opens on: calendar framed, nothing selected, cursor parked
 * off-screen. A take ends in that same state so its last frame matches its first.
 * `cursorTravelMs` is how long the fake cursor takes to glide to each target.
 */
export async function openFramedWeek(
  page: Page,
  cursorTravelMs = DEFAULT_CURSOR_TRAVEL_MS
): Promise<number> {
  cursorTravel.set(page, cursorTravelMs);
  await page.evaluate(injectCursor(cursorTravelMs));
  await parkCursor(page);

  await page.keyboard.press(mod("Mod+Shift+c"));
  await page.waitForTimeout(900);
  await frameMorning(page);

  // Capture starts when the browser context is created, so everything before this
  // is about:blank and the app painting in.
  await page.waitForTimeout(400);
  return Date.now();
}

/**
 * Put 8 AM at the top of the time grid. The 11 am clock auto-scrolls "now" near the
 * top, which pushes the morning above the fold. 40px (collapsed 0–6am band) + 2 ×
 * 64px (6–8am) = 168, leaving 9am ~64px down and the 11am now-line ~192px below.
 */
export async function frameMorning(page: Page) {
  await weekRegion(page)
    .locator('[aria-label="Time grid"]')
    .evaluate((el) => {
      el.scrollTop = 168;
    });
}

export function weekRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Week calendar" });
}

const injectCursor = (travelMs: number) => `
(() => {
  if (document.getElementById('fake-cursor')) return;
  const cursor = document.createElement('div');
  cursor.id = 'fake-cursor';
  cursor.innerHTML = \`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>\`;
  cursor.style.cssText = \`
    position: fixed;
    top: 0;
    left: 0;
    width: 24px;
    height: 24px;
    z-index: 99999;
    pointer-events: none;
    transition: transform ${travelMs}ms cubic-bezier(0.25, 0.1, 0.25, 1);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
  \`;
  document.body.appendChild(cursor);

  window.__cursorX = 0;
  window.__cursorY = 0;

  window.__moveCursor = (x, y) => {
    window.__cursorX = x;
    window.__cursorY = y;
    cursor.style.transform = \`translate(\${x}px, \${y}px)\`;
  };

  window.__clickCursor = () => {
    cursor.style.transition = 'transform 0.1s ease';
    cursor.style.transform = \`translate(\${window.__cursorX}px, \${window.__cursorY}px) scale(0.85)\`;
    setTimeout(() => {
      cursor.style.transition = 'transform ${travelMs}ms cubic-bezier(0.25, 0.1, 0.25, 1)';
      cursor.style.transform = \`translate(\${window.__cursorX}px, \${window.__cursorY}px) scale(1)\`;
    }, 100);
  };
})();
`;

declare global {
  interface Window {
    __cursorX: number;
    __cursorY: number;
    __moveCursor: (x: number, y: number) => void;
    __clickCursor: () => void;
  }
}

export async function parkCursor(page: Page) {
  await page.evaluate(() => window.__moveCursor(-30, -30));
}

export async function moveTo(page: Page, x: number, y: number) {
  await page.evaluate(([tx, ty]) => window.__moveCursor(tx, ty), [x, y] as const);
  await page.waitForTimeout((cursorTravel.get(page) ?? DEFAULT_CURSOR_TRAVEL_MS) + 50);
}

export async function moveToLocator(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not found for cursor move");
  await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function clickLocator(page: Page, locator: Locator) {
  await moveToLocator(page, locator);
  await page.evaluate(() => window.__clickCursor());
  await locator.click();
  await page.waitForTimeout(150);
}

export async function typeSlowly(page: Page, text: string, delayMs = 55) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: delayMs });
  }
}

export async function dragFromTo(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number
) {
  await moveTo(page, startX, startY);
  await page.waitForTimeout(200);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(100);

  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const cx = startX + (endX - startX) * progress;
    const cy = startY + (endY - startY) * progress;
    await page.evaluate(([tx, ty]) => window.__moveCursor(tx, ty), [cx, cy] as const);
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(20);
  }

  await page.waitForTimeout(200);
  await page.mouse.up();
}

export async function dragLocatorTo(
  page: Page,
  sourceLocator: Locator,
  targetX: number,
  targetY: number
) {
  const box = await sourceLocator.boundingBox();
  if (!box) throw new Error("Drag source not found");
  await dragFromTo(page, box.x + box.width / 2, box.y + box.height / 2, targetX, targetY);
}
