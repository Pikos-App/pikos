/**
 * record-hero.spec.ts — Playwright script that records marketing hero GIFs.
 *
 * Produces two .webm videos (dark + light mode). Data is auto-seeded via
 * VITE_SEED=marketing. The browser clock is mocked to Monday 11am so the
 * calendar's "now" line lands at the end of the Roadmap planning block —
 * the meeting that just wrapped sits right under the time indicator.
 *
 * Narrative — the start of a planner's week.
 *   1. Switch to Calendar (Cmd+Shift+C). The Monday 9–11am block
 *      "Roadmap planning" sits at the top of the week — a 2-hour meeting
 *      with real notes (seeded with full Tiptap content: themes, bets,
 *      risks, decisions, next steps).
 *   2. Click the block → popover surfaces title + status + folder + date
 *      + repeats + priority. The viewer sees "this is more than a calendar
 *      event — it's a task with metadata and a page with content."
 *   3. Click "Mark done" in the popover → the block flips to done state.
 *      The meeting just wrapped.
 *   4. Click the Tue 10am slot → inline-create "Send recap" — the action
 *      that came out of the planning meeting, scheduled the next morning.
 *   5. Drag "Draft: search relevance" from the inbox list onto Thu 9am,
 *      then drag its bottom edge down to extend the block to 1 hour —
 *      blocks time to actually work on the proposal.
 *   6. Double-click the new Thu block → editor opens on the page. Type a
 *      quick outline (markdown bullets) inline.
 *   7. Cmd+Shift+C → back to Calendar. Long hold for a clean loop point.
 *
 * Looping: both the first and last frames are the calendar view, cursor
 * parked off-screen. The seed data resets at the seam (Send recap and the
 * scheduled proposal disappear, Roadmap planning un-dims). The long final hold
 * absorbs the state-snap so the loop reads as a clean restart, not a glitch.
 *
 * The seed has rich content for every meeting so a viewer who downloads the
 * app and opens this seed sees real-looking work artifacts, not lorem ipsum.
 *
 * Usage:
 *   pnpm record:hero
 */

import { test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { join } from "path";

import { mod } from "./fixtures";

const VIDEO_DIR = join(import.meta.dirname, "..", "recordings");

// Fixed Monday 11 am — the Roadmap planning block (Mon 9–11am) is the
// just-ended meeting, so the calendar's "now" indicator sits at its bottom
// edge. Day-of-week math in the seed only reads .toISOString().slice(0,10)
// so the time portion here doesn't affect which day events land on.
const RECORDING_DATE = new Date("2026-03-16T11:00:00");

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

  // ── 1. Cmd+Shift+C → Calendar. Let the work week settle. ───────────────
  // This is the LOOP-ANCHOR frame: calendar view, cursor parked off-screen.
  // The recording's final frame returns here so the loop seam reads as a
  // clean restart instead of a view-switch.
  //
  // The 11am mocked clock makes the calendar auto-scroll so "now" sits
  // near the top of the viewport — which pushes the Mon 9–11am Roadmap
  // planning block (and Thu 9am Draft: search relevance after the drag)
  // above the fold. We override scrollTop to land 8am at the top: 9am
  // sits ~64px down with the now-line (11am) ~192px below, so both the
  // star block and the now indicator stay framed together.

  const calRegion = page.getByRole("region", { name: "Week calendar" });
  await page.keyboard.press(mod("Mod+Shift+c"));
  await page.waitForTimeout(900);
  const timeGrid = calRegion.locator('[aria-label="Time grid"]');
  await timeGrid.evaluate((el) => {
    // 40px (collapsed 0–6am band) + 2 × 64px (6–8am) = 168 → 8am at top.
    el.scrollTop = 168;
  });
  await page.waitForTimeout(1300);

  // ── 2. Hover the Roadmap planning block, click its checkbox directly. ─
  // The block exposes a TaskCheckbox span (class `.task-checkbox`) that's
  // hover-revealed. No need to route through the popover for a status flip —
  // clicking the checkbox is the faster gesture a real user would use.

  const roadmapBlock = calRegion.getByRole("button", { name: /Roadmap planning/ }).first();
  // Hover first so the hover-revealed checkbox materializes and has a real
  // bounding box for the subsequent click.
  await moveToLocator(page, roadmapBlock);
  await page.waitForTimeout(300);

  const roadmapCheckbox = roadmapBlock.locator(".task-checkbox").first();
  await clickLocator(page, roadmapCheckbox);
  // Hold on the done state so the strikethrough/dim is unambiguous.
  await page.waitForTimeout(900);

  // ── 4. Click Tue 10am → inline-create the follow-up action. ───────────
  // X from Tuesday's all-day column (aligned with timed columns); Y from
  // the visible "10 AM" hour label — bypasses TimeGutter and scroll math.

  const tueAllDay = calRegion.locator('[aria-label^="All-day events, Tue"]').first();
  const tueBox = await tueAllDay.boundingBox();
  const tenAmLabel = calRegion.getByText("10 AM", { exact: true }).first();
  const tenAmBox = await tenAmLabel.boundingBox();

  if (tueBox && tenAmBox) {
    const clickX = tueBox.x + tueBox.width / 2;
    const clickY = tenAmBox.y + tenAmBox.height / 2 + 16;

    await moveTo(page, clickX, clickY);
    await page.evaluate(() => window.__clickCursor());
    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(500);

    await typeSlowly(page, "Send recap");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
  }

  // ── 5. Drag "Draft: search relevance" from inbox list onto Thu 9am. ───
  // The dnd-kit PointerSensor activates at 8px — dragLocatorTo's step
  // interpolation crosses that on the first move.

  const thuAllDay = calRegion.locator('[aria-label^="All-day events, Thu"]').first();
  const thuBox = await thuAllDay.boundingBox();
  const nineAmLabel = calRegion.getByText("9 AM", { exact: true }).first();
  const nineAmBox = await nineAmLabel.boundingBox();

  if (thuBox && nineAmBox) {
    const dropX = thuBox.x + thuBox.width / 2;
    const dropY = nineAmBox.y + nineAmBox.height / 2 + 4;

    const draftRfc = page
      .locator("[data-page-list-item]")
      .filter({ hasText: "Draft: search relevance" })
      .first();
    await dragLocatorTo(page, draftRfc, dropX, dropY);
    await page.waitForTimeout(700);

    // ── 5b. Extend the dropped block to 1 hour by dragging its bottom edge.
    // The drop creates a chip with no end (default ~15-min compact height).
    // We grab the bottom-edge resize handle and pull down 48px so the total
    // block height = 64px = HOUR_HEIGHT. Snaps to the 10am grid line.

    const rfcBlock = calRegion.getByRole("button", { name: /Draft: search relevance/ }).first();
    const rfcBox = await rfcBlock.boundingBox();
    if (rfcBox) {
      const handleX = rfcBox.x + rfcBox.width / 2;
      const handleY = rfcBox.y + rfcBox.height - 1;
      const targetY = rfcBox.y + 64; // 1 hour from block top

      // Show the cursor moving to the grab point before the press.
      await moveTo(page, handleX, handleY);
      await page.waitForTimeout(150);
      await page.mouse.move(handleX, handleY);
      await page.mouse.down();
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const cy = handleY + (targetY - handleY) * progress;
        await page.evaluate(([tx, ty]) => window.__moveCursor(tx, ty), [handleX, cy] as const);
        await page.mouse.move(handleX, cy);
        await page.waitForTimeout(25);
      }
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(700);
    }

    // ── 6. Click the resized Thu block → popover → "Open page" → editor.
    // The resize-handle mousedown set `draggingRef=true` to swallow the
    // browser's residual post-drag click. Playwright's pure mouse-down/up
    // sequence doesn't generate that residual click, so the first click
    // after resize is the one that gets swallowed instead — silently. The
    // workaround is a paired click: first call drains draggingRef, second
    // call triggers handleClick's CLICK_DELAY timer and opens the popover.
    // Then the popover's "Open page" button takes us into the editor.

    const freshRfcBox = await rfcBlock.boundingBox();
    if (freshRfcBox) {
      const cx = freshRfcBox.x + freshRfcBox.width / 2;
      const cy = freshRfcBox.y + freshRfcBox.height / 2;
      await moveTo(page, cx, cy);
      await page.evaluate(() => window.__clickCursor());
      await page.mouse.click(cx, cy); // drain post-drag flag
      await page.waitForTimeout(120);
      await page.mouse.click(cx, cy); // real click → starts popover timer
      await page.waitForTimeout(400); // CLICK_DELAY (150) + render margin
    }

    const openPageBtn = page.getByRole("button", { name: "Open page" });
    await clickLocator(page, openPageBtn);
    await page.waitForTimeout(1000);

    // Click into the editor, jump cursor to the very end of the document
    // (Cmd+A selects all, ArrowRight collapses to the selection's right
    // edge — `End` alone would only reach end-of-visual-line and split the
    // existing paragraph mid-sentence), then append a markdown outline.
    // The first "- " triggers Tiptap's bullet-list input rule; subsequent
    // Enters create new bullet items automatically.
    const editor = page.getByRole("textbox", { name: "Page content" });
    await clickLocator(page, editor);
    await page.keyboard.press(mod("Mod+a"));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await typeSlowly(page, "- Problem statement", 40);
    await page.keyboard.press("Enter");
    await typeSlowly(page, "Options considered", 40);
    await page.keyboard.press("Enter");
    await typeSlowly(page, "Migration risk", 40);
    await page.waitForTimeout(900);
  }

  // ── 7. Cmd+Shift+C → back to Calendar. Park cursor off-screen so the
  // loop seam matches the opening frame's view and cursor state. ─────────

  await page.keyboard.press(mod("Mod+Shift+c"));
  await page.evaluate(() => window.__moveCursor(-30, -30));

  // Long final hold so the seam absorbs the seed-data reset on loop.
  await page.waitForTimeout(3500);
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

    // Mock the clock to Monday 11am so the "now" line sits at the bottom
    // of the Roadmap planning block (the meeting that just wrapped).
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
