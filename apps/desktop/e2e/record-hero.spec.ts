/**
 * record-hero.spec.ts — Playwright script that records marketing hero GIFs.
 *
 * Produces two .webm videos (dark + light mode). Data is auto-seeded via
 * VITE_SEED=marketing. The browser clock is set to Monday 9am so the
 * calendar shows a full populated week.
 *
 * Usage:
 *   pnpm record:hero
 */

import { test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { join } from "path";

const VIDEO_DIR = join(import.meta.dirname, "..", "recordings");

// Fixed Monday 9 am — must match TODAY in seed-demo-marketing.ts
const RECORDING_DATE = new Date("2026-03-16T09:00:00");

// ── Fake cursor injection ────────────────────────────────────────────────────

const INJECT_CURSOR = `
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
    transition: transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1);
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
      cursor.style.transition = 'transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1)';
      cursor.style.transform = \`translate(\${window.__cursorX}px, \${window.__cursorY}px) scale(1)\`;
    }, 100);
  };
})();
`;

// ── Cursor helpers ───────────────────────────────────────────────────────────

async function moveTo(page: Page, x: number, y: number) {
  await page.evaluate(([tx, ty]) => window.__moveCursor(tx, ty), [x, y] as const);
  await page.waitForTimeout(400);
}

async function moveToLocator(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not found for cursor move");
  await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickLocator(page: Page, locator: ReturnType<Page["locator"]>) {
  await moveToLocator(page, locator);
  await page.evaluate(() => window.__clickCursor());
  await locator.click();
  await page.waitForTimeout(150);
}

async function dblClickLocator(page: Page, locator: ReturnType<Page["locator"]>) {
  await moveToLocator(page, locator);
  await page.evaluate(() => window.__clickCursor());
  await locator.dblclick();
  await page.waitForTimeout(150);
}

async function typeSlowly(page: Page, text: string, delayMs = 55) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: delayMs });
  }
}

// ── Drag helper ──────────────────────────────────────────────────────────────

async function dragFromTo(page: Page, startX: number, startY: number, endX: number, endY: number) {
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

async function dragLocatorTo(
  page: Page,
  sourceLocator: ReturnType<Page["locator"]>,
  targetX: number,
  targetY: number
) {
  const box = await sourceLocator.boundingBox();
  if (!box) throw new Error("Drag source not found");
  await dragFromTo(page, box.x + box.width / 2, box.y + box.height / 2, targetX, targetY);
}

// ── Sidebar nav helper ───────────────────────────────────────────────────────

function sidebarButton(page: Page, name: string) {
  return page
    .getByRole("group", { name: "Views and folders" })
    .getByRole("button", { name })
    .first();
}

// ── Type declarations ────────────────────────────────────────────────────────

declare global {
  interface Window {
    __cursorX: number;
    __cursorY: number;
    __moveCursor: (x: number, y: number) => void;
    __clickCursor: () => void;
  }
}

// ── Recording flow ───────────────────────────────────────────────────────────

async function recordHero(page: Page) {
  await page.evaluate(INJECT_CURSOR);
  await page.evaluate(() => window.__moveCursor(-30, -30));

  // ── 1. Inbox — let it breathe ──────────────────────────────────────────

  await moveTo(page, 400, 300);
  await page.waitForTimeout(1000);

  // ── 2. Quick Add "Pack bags for the trip" scheduled Wednesday ──────────

  const newPageBtn = page.getByRole("button", { name: "New Page" });
  await clickLocator(page, newPageBtn);
  await page.waitForTimeout(400);

  const input = page.getByPlaceholder(/what's on your mind/i);
  await moveToLocator(page, input);
  await page.evaluate(() => window.__clickCursor());
  await input.click();
  await page.waitForTimeout(200);
  await typeSlowly(page, "Pack bags for the trip wednesday");
  await page.waitForTimeout(500);

  const addBtn = page.getByRole("button", { name: "Add" });
  await clickLocator(page, addBtn);
  await page.waitForTimeout(1000);

  // ── 3. Check off "Research vacation spots" — done researching ─────────

  const researchPage = page
    .locator("[data-page-list-item]")
    .filter({ hasText: "Research vacation spots" })
    .first();
  const researchCheckbox = researchPage.getByRole("checkbox", { name: "Mark done" });
  await clickLocator(page, researchCheckbox);
  await page.waitForTimeout(1000);

  // ── 4. Open "Pack bags" — it's a note with a rich editor ──────────────

  const packBags = page
    .locator("[data-page-list-item]")
    .filter({ hasText: "Pack bags for the trip" })
    .first();
  await clickLocator(page, packBags);
  await page.waitForTimeout(800);

  const editor = page.getByRole("textbox", { name: "Page content" });
  await clickLocator(page, editor);
  await page.waitForTimeout(200);
  await typeSlowly(page, "Check the weather forecast and pack light layers.", 30);
  await page.waitForTimeout(1200);

  // ── 5. Switch to Calendar — pack bags is already on Wednesday ─────────

  const calendarBtn = page.getByRole("button", { name: "Calendar view" });
  await clickLocator(page, calendarBtn);
  await page.waitForTimeout(2000);

  // ── 6. Drag to create a new task on Monday ────────────────────────────

  const calRegion = page.getByRole("region", { name: "Week calendar" });
  const timeGrid = calRegion.locator("[aria-label='Time grid']");
  const gridBox = await timeGrid.boundingBox();

  if (gridBox) {
    // Monday column, 2pm slot (8h from 6am start × 64px/hour = 512px)
    const colWidth = gridBox.width / 7;
    const targetX = gridBox.x + colWidth * 0.5;
    const startY = gridBox.y + 512;
    const endY = startY + 64; // 1-hour block

    await dragFromTo(page, targetX, startY, targetX, endY);
    await page.waitForTimeout(500);

    await typeSlowly(page, "Team standup");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  }

  // ── Hold for loop point ────────────────────────────────────────────────

  await page.waitForTimeout(1500);
}

// ── Test definitions ─────────────────────────────────────────────────────────

for (const theme of ["dark", "light"] as const) {
  test(`record hero — ${theme} mode @recording`, async ({ browser }) => {
    const monday = RECORDING_DATE;

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: {
        dir: VIDEO_DIR,
        size: { width: 1280, height: 800 },
      },
    });

    const page = await ctx.newPage();
    await page.addInitScript(`localStorage.setItem('pikos-theme', '${theme}')`);

    // Mock the clock to Monday 9am so the calendar shows a full week
    await page.clock.install({ time: monday });
    await page.clock.resume();

    await page.goto("/");

    // Wait for seed data to load
    await page.waitForSelector('[role="main"][aria-label="Workspace"]', { timeout: 10000 });
    await page.waitForTimeout(500);

    await recordHero(page);

    await ctx.close();
    console.log(`\n  ✓ Recorded ${theme} mode video to ${VIDEO_DIR}/`);
  });
}
