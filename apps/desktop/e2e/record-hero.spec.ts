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
 *   5. Drag "Write proposal" from the inbox list onto Thu 9am,
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

// ── Recording flow ───────────────────────────────────────────────────────────

/** Returns the wall-clock moment the finished video should start from. */
async function recordHero(page: Page): Promise<number> {
  // ── 1. The framed week: Roadmap planning (Mon 9–11) and the now-line together.
  // This is the LOOP-ANCHOR frame; the recording returns here at the end.
  const calRegion = weekRegion(page);
  const cutAt = await openFramedWeek(page);
  await page.waitForTimeout(900);

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

  // ── 5. Drag "Write proposal" from inbox list onto Thu 9am. ───
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
      .filter({ hasText: "Write proposal" })
      .first();
    await dragLocatorTo(page, draftRfc, dropX, dropY);
    await page.waitForTimeout(700);

    // ── 5b. Extend the dropped block to 1 hour by dragging its bottom edge.
    // The drop creates a chip with no end (default ~15-min compact height).
    // We grab the bottom-edge resize handle and pull down 48px so the total
    // block height = 64px = HOUR_HEIGHT. Snaps to the 10am grid line.

    const rfcBlock = calRegion.getByRole("button", { name: /Write proposal/ }).first();
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
  await parkCursor(page);

  // Long final hold so the seam absorbs the seed-data reset on loop.
  await page.waitForTimeout(3500);

  return cutAt;
}

// ── Test definitions ─────────────────────────────────────────────────────────

for (const theme of ["dark", "light"] as const) {
  test(`record hero — ${theme} mode @recording`, async ({ browser }) => {
    await recordTake(browser, "hero", theme, recordHero);
  });
}
