/**
 * Records the marketing hero videos (dark + light). Data is seeded via VITE_SEED=marketing, and the browser
 * clock is mocked to Monday 11am so the calendar's "now" line sits at the end of the Roadmap planning block.
 *
 * Looping: the first and last frames are the calendar view with the cursor parked off-screen. The seed data
 * resets at the seam, and the long final hold absorbs the state snap so the loop reads as a clean restart.
 *
 * Usage: pnpm record:hero
 */

import { test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod } from "./fixtures";
import {
  clickLocator,
  dragLocatorTo,
  moveTo,
  moveToLocator,
  openFramedWeek,
  parkCursor,
  recordTake,
  typeSlowly,
  weekRegion,
} from "./recording";

/** Returns the wall-clock moment the finished video should start from. */
async function recordHero(page: Page): Promise<number> {
  // The loop-anchor frame: the recording returns here at the end.
  const calRegion = weekRegion(page);
  const cutAt = await openFramedWeek(page);
  await page.waitForTimeout(900);

  // The hover-revealed `.task-checkbox` flips status directly, with no popover needed.

  const roadmapBlock = calRegion.getByRole("button", { name: /Roadmap planning/ }).first();
  // Hover first so the revealed checkbox has a real bounding box to click.
  await moveToLocator(page, roadmapBlock);
  await page.waitForTimeout(300);

  const roadmapCheckbox = roadmapBlock.locator(".task-checkbox").first();
  await clickLocator(page, roadmapCheckbox);
  await page.waitForTimeout(900);

  // X from Tuesday's all-day column (aligned with timed columns); Y from the "10 AM" hour label, bypassing
  // TimeGutter and scroll math.

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

  // dnd-kit's PointerSensor activates at 8px; dragLocatorTo's step interpolation crosses that on the first move.

  const thuAllDay = calRegion.locator('[aria-label^="All-day events, Thu"]').first();
  const thuBox = await thuAllDay.boundingBox();
  const nineAmLabel = calRegion.getByText("9 AM", { exact: true }).first();
  const nineAmBox = await nineAmLabel.boundingBox();

  if (thuBox && nineAmBox) {
    const dropX = thuBox.x + thuBox.width / 2;
    const dropY = nineAmBox.y + nineAmBox.height / 2 + 4;

    const draftRfc = page
      .locator("[data-page-list-item]")
      .filter({ hasText: "Write proposal" })
      .first();
    await dragLocatorTo(page, draftRfc, dropX, dropY);
    await page.waitForTimeout(700);

    // The drop creates a chip with no end (compact height). Pull the bottom-edge handle down 48px so the block
    // is 64px = HOUR_HEIGHT, snapping to the 10am grid line.

    const rfcBlock = calRegion.getByRole("button", { name: /Write proposal/ }).first();
    const rfcBox = await rfcBlock.boundingBox();
    if (rfcBox) {
      const handleX = rfcBox.x + rfcBox.width / 2;
      const handleY = rfcBox.y + rfcBox.height - 1;
      const targetY = rfcBox.y + 64; // 1 hour from block top

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

    // The resize-handle mousedown sets draggingRef=true to swallow the browser's residual post-drag click, which
    // Playwright's mouse down/up doesn't generate, so the first click after resize is swallowed instead. A paired
    // click works: the first drains draggingRef, the second triggers handleClick's CLICK_DELAY timer and opens the popover.

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

    // Cmd+A then ArrowRight collapses to the end of the document; `End` alone reaches only end-of-visual-line and
    // splits the paragraph mid-sentence. The first "- " triggers Tiptap's bullet-list rule; later Enters add bullets.
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

  // Park the cursor off-screen so the loop seam matches the opening frame.

  await page.keyboard.press(mod("Mod+Shift+c"));
  await parkCursor(page);

  await page.waitForTimeout(3500);

  return cutAt;
}

for (const theme of ["dark", "light"] as const) {
  test(`record hero — ${theme} mode @recording`, async ({ browser }) => {
    await recordTake(browser, "hero", theme, recordHero);
  });
}
