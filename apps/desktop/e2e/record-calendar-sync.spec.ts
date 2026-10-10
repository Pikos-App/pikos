/**
 * Records connecting a CalDAV calendar and its meetings landing on a week of tasks,
 * once per theme. Seeded by `marketing-sync`: the marketing week with nothing
 * connected, and a provider "Work" calendar whose meetings arrive when it is enabled.
 *
 * Narrative:
 *   1. The framed week of native tasks, cursor parked off-screen. This first frame is
 *      the thumbnail and the poster.
 *   2. Settings → Calendar sync → Add account → CalDAV; type the server, username and
 *      a masked password; Connect.
 *   3. The discovered calendars appear; switch Work on and close settings.
 *   4. The Work meetings sit in the week beside the tasks, in the calendar's colour.
 *   5. Double-click "Customer call" → its page opens; type two lines of notes.
 *   6. Back to the calendar, cursor parked, a closing hold.
 *
 * Usage:
 *   pnpm record:calendar-sync
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mod } from "./fixtures";
import {
  clickLocator,
  moveToLocator,
  openFramedWeek,
  parkCursor,
  recordTake,
  typeSlowly,
  weekRegion,
} from "./recording";

// The connect segment is setup, not the payoff; it types faster than the notes so
// the meetings landing and the notes get most of a ~20 s take.
const FORM_TYPING_MS = 28;
const NOTES_TYPING_MS = 45;

async function connectWorkCalendar(page: Page) {
  await clickLocator(page, page.getByRole("button", { name: "Open settings" }));
  await clickLocator(page, page.getByRole("button", { exact: true, name: "Calendar sync" }));
  await clickLocator(page, page.getByRole("button", { name: "Add account" }));
  await clickLocator(page, page.getByRole("button", { name: /CalDAV/ }));

  await clickLocator(page, page.getByLabel("Server URL"));
  await typeSlowly(page, "https://caldav.example.com", FORM_TYPING_MS);
  await clickLocator(page, page.getByLabel("Username"));
  await typeSlowly(page, "you@example.com", FORM_TYPING_MS);
  await clickLocator(page, page.getByLabel("App password"));
  await typeSlowly(page, "app-password", FORM_TYPING_MS);
  await clickLocator(page, page.getByRole("button", { name: "Connect" }));

  const work = page.getByRole("switch", { name: "Sync Work" });
  await work.waitFor();
  await page.waitForTimeout(400);
  await clickLocator(page, work);
  await expect(work).toBeChecked();
  await page.waitForTimeout(500);

  await clickLocator(page, page.getByRole("button", { name: "Close settings" }));
}

async function recordCalendarSync(page: Page): Promise<number> {
  const cutAt = await openFramedWeek(page);
  await page.waitForTimeout(1200);

  await connectWorkCalendar(page);

  const meeting = weekRegion(page).getByRole("button", { name: /^Customer call,/ });
  await expect(meeting).toBeVisible();
  await page.waitForTimeout(1500);

  await moveToLocator(page, meeting);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__clickCursor());
  await meeting.dblclick();

  const editor = page.getByRole("textbox", { name: "Page content" });
  await expect(editor).toBeVisible();
  await page.waitForTimeout(500);
  await clickLocator(page, editor);
  await page.keyboard.press(mod("Mod+a"));
  await page.keyboard.press("ArrowRight");
  await typeSlowly(page, "Wants CSV export before renewal", NOTES_TYPING_MS);
  await page.keyboard.press("Enter");
  await typeSlowly(page, "Send pricing follow-up Friday", NOTES_TYPING_MS);
  await page.waitForTimeout(800);

  await page.keyboard.press(mod("Mod+Shift+c"));
  await parkCursor(page);
  await page.waitForTimeout(2500);

  return cutAt;
}

for (const theme of ["dark", "light"] as const) {
  test(`record calendar sync — ${theme} mode @recording-sync`, async ({ browser }) => {
    await recordTake(browser, "calendar-sync", theme, recordCalendarSync);
  });
}
