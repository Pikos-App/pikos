/**
 * Records connecting a CalDAV calendar and its meetings landing on a week of tasks,
 * once per theme. Seeded by `marketing-sync`: the marketing week with nothing
 * connected, and a CalDAV server whose "Team" calendar brings meetings in when enabled.
 *
 * Narrative:
 *   1. The framed week of native tasks, cursor parked off-screen. This first frame is
 *      the thumbnail and the poster.
 *   2. Settings → Calendar sync → Add account → CalDAV; type the server, username and
 *      a masked password; Connect.
 *   3. The discovered calendars appear; switch Team on and close settings.
 *   4. The Team meetings sit in the week beside the tasks, in the calendar's colour.
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

// Paced for a viewer seeing the app for the first time, muted, in a feed: each
// change gets a beat to land before the cursor moves on.
const CURSOR_TRAVEL_MS = 650;
const FORM_TYPING_MS = 45;
const NOTES_TYPING_MS = 65;
const STEP_BEAT_MS = 400;
const CHANGE_HOLD_MS = 1500;

async function step(page: Page, name: string | RegExp, exact = false) {
  await clickLocator(page, page.getByRole("button", { exact, name }));
  await page.waitForTimeout(STEP_BEAT_MS);
}

async function connectTeamCalendar(page: Page) {
  await step(page, "Open settings");
  await step(page, "Calendar sync", true);
  await step(page, "Add account");
  await step(page, /CalDAV/);

  await clickLocator(page, page.getByLabel("Server URL"));
  await typeSlowly(page, "https://caldav.example.com", FORM_TYPING_MS);
  await clickLocator(page, page.getByLabel("Username"));
  await typeSlowly(page, "you@example.com", FORM_TYPING_MS);
  await clickLocator(page, page.getByLabel("App password"));
  await typeSlowly(page, "app-password", FORM_TYPING_MS);
  await page.waitForTimeout(CHANGE_HOLD_MS);
  await clickLocator(page, page.getByRole("button", { name: "Connect" }));

  const team = page.getByRole("switch", { name: "Sync Team" });
  await team.waitFor();
  await page.waitForTimeout(CHANGE_HOLD_MS);
  await clickLocator(page, team);
  await expect(team).toBeChecked();
  await page.waitForTimeout(CHANGE_HOLD_MS);

  await clickLocator(page, page.getByRole("button", { name: "Close settings" }));
}

async function recordCalendarSync(page: Page): Promise<number> {
  const cutAt = await openFramedWeek(page, CURSOR_TRAVEL_MS);
  await page.waitForTimeout(1200);

  await connectTeamCalendar(page);
  await parkCursor(page);

  const meeting = weekRegion(page).getByRole("button", { name: /^Customer call,/ });
  await expect(meeting).toBeVisible();
  await page.waitForTimeout(2500);

  await moveToLocator(page, meeting);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__clickCursor());
  await meeting.dblclick();

  const editor = page.getByRole("textbox", { name: "Page content" });
  await expect(editor).toBeVisible();
  await page.waitForTimeout(1000);
  await clickLocator(page, editor);
  await page.keyboard.press(mod("Mod+a"));
  await page.keyboard.press("ArrowRight");
  await typeSlowly(page, "Wants CSV export before renewal", NOTES_TYPING_MS);
  await page.keyboard.press("Enter");
  await typeSlowly(page, "Send pricing follow-up Friday", NOTES_TYPING_MS);
  await page.waitForTimeout(CHANGE_HOLD_MS);

  await page.keyboard.press(mod("Mod+Shift+c"));
  await parkCursor(page);
  await page.waitForTimeout(2500);

  return cutAt;
}

for (const theme of ["dark", "light"] as const) {
  test(`record calendar sync, ${theme} mode @recording-sync`, async ({ browser }) => {
    await recordTake(browser, "calendar-sync", theme, recordCalendarSync);
  });
}
