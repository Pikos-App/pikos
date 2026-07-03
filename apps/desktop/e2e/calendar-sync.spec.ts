// E2E tests for the external calendar-sync UI.
//
// Entirely mock-driven: runs under VITE_TEST_MODE=true → MockStorageAdapter,
// whose connectCaldavAccount returns a canned Personal/Work discovery and whose
// toggleSyncCalendar creates a real is_external_calendar folder. No network, no
// real CalDAV/Google creds — the live auth/transport seams stay in the manual
// pre-release layer and are never exercised here.
//
// The synced-block tests load the "synced" dev seed (Settings → Developer),
// available because the e2e webServer runs the Vite dev server (import.meta.env.DEV).

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

// Synced timed events resolve to the viewer's zone (absolute time), so block
// positions depend on the viewer timezone. Pin it so the seed renders the same
// everywhere — e.g. "Team standup" (9am New York) always lands at 9am.
appTest.use({ timezoneId: "America/New_York" });

async function openSyncPanel(app: Page) {
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Calendar Sync" }).click();
}

/** Connect the mock CalDAV account, leaving the Sync panel open on its card. */
async function connectCaldav(app: Page) {
  await openSyncPanel(app);
  await app.getByRole("button", { name: "Add account" }).click();
  await app.getByRole("button", { name: /CalDAV/ }).click();

  await app.getByLabel("Server URL").fill("https://caldav.example.com");
  await app.getByLabel("Username").fill("me@example.com");
  await app.getByLabel("App password").fill("app-pw");
  await app.getByRole("button", { name: "Connect" }).click();

  await expect(app.getByRole("switch", { name: "Sync Personal" })).toBeVisible();
}

/** Wipe + load the mock synced-calendar seed via the Developer settings tab. */
async function seedSynced(app: Page) {
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Developer" }).click();
  await app.getByRole("button", { name: "Seed Mock calendar sync" }).click();
  await app.getByRole("button", { name: "Confirm" }).click();
  // Seeding closes settings on success — the gear button reappearing signals done.
  await expect(app.getByRole("button", { name: "Open settings" })).toBeVisible();
}

async function openCalendarMode(app: Page) {
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.waitFor({ state: "visible" });
  if ((await calendarBtn.getAttribute("aria-pressed")) !== "true") {
    await calendarBtn.click();
  }
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

// ─── tier1: add account ──────────────────────────────────────────────────────

appTest("Calendar Sync panel adds a CalDAV account, calendars start off @tier1", async ({
  app,
}) => {
  await openSyncPanel(app);
  await expect(
    app.getByText("No accounts connected yet. Add one to start syncing a calendar.")
  ).toBeVisible();

  await app.getByRole("button", { name: "Add account" }).click();
  await expect(app.getByRole("dialog", { name: "Add calendar account" })).toBeVisible();
  // Google is the next provider — present but gated.
  await expect(app.getByRole("button", { name: /Google/ })).toBeDisabled();

  await app.getByRole("button", { name: /CalDAV/ }).click();

  // Connect stays disabled until all three fields are filled.
  const connect = app.getByRole("button", { name: "Connect" });
  await expect(connect).toBeDisabled();
  await app.getByLabel("Server URL").fill("https://caldav.example.com");
  await app.getByLabel("Username").fill("me@example.com");
  await app.getByLabel("App password").fill("app-pw");
  await expect(connect).toBeEnabled();
  await connect.click();

  // Both discovered calendars appear, all toggles off.
  await expect(app.getByRole("switch", { name: "Sync Personal" })).not.toBeChecked();
  await expect(app.getByRole("switch", { name: "Sync Work" })).not.toBeChecked();
});

// ─── tier1: toggle ↔ sidebar folder (the highest-value smoke) ─────────────────

appTest("enabling a calendar adds a sidebar folder, disabling removes it @tier1", async ({
  app,
}) => {
  await connectCaldav(app);

  const personal = app.getByRole("switch", { name: "Sync Personal" });
  await personal.click();
  await expect(personal).toBeChecked();

  await app.keyboard.press("Escape");
  const sidebarFolder = app.getByRole("button", { name: "Personal" });
  await expect(sidebarFolder).toBeVisible();

  // Disable → the external folder disappears.
  await openSyncPanel(app);
  await app.getByRole("switch", { name: "Sync Personal" }).click();
  await expect(app.getByRole("switch", { name: "Sync Personal" })).not.toBeChecked();
  await app.keyboard.press("Escape");
  await expect(sidebarFolder).not.toBeVisible();
});

// ─── tier2: recolor ──────────────────────────────────────────────────────────

appTest("recolor a synced calendar from the swatch palette @tier2", async ({ app }) => {
  await connectCaldav(app);
  await app.getByRole("switch", { name: "Sync Personal" }).click();

  await app.getByRole("button", { name: "Colour for Personal" }).click();
  // Palette is a tight grid — neighbouring swatches trip the actionability
  // overlap check, so force the click on the named target.
  await app.getByRole("button", { name: "Lavender" }).click({ force: true });

  // Palette closes; the colour control is still there (recolor stays allowed).
  await expect(app.getByRole("button", { name: "Colour for Personal" })).toBeVisible();
});

// ─── tier2: resync + disconnect ──────────────────────────────────────────────

appTest("resync then disconnect removes the account and its folder @tier2", async ({ app }) => {
  await connectCaldav(app);
  await app.getByRole("switch", { name: "Sync Personal" }).click();

  const menu = app.getByRole("button", { name: /Account actions for/ });
  await menu.click();
  await app.getByRole("menuitem", { name: "Resync now" }).click();

  // Disconnect via the overflow menu → confirm dialog.
  await menu.click();
  await app.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(app.getByRole("alertdialog", { name: /Disconnect/ })).toBeVisible();
  await app.getByRole("button", { name: "Disconnect" }).click();

  await expect(
    app.getByText("No accounts connected yet. Add one to start syncing a calendar.")
  ).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("button", { name: "Personal" })).not.toBeVisible();
});

// ─── tier2: synced-block treatment ───────────────────────────────────────────

appTest("synced events render source + detached treatment, schedule read-only @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarMode(app);

  // Active synced events carry the source icon; the detached one carries the
  // broken-sync icon.
  await expect(
    app.getByRole("img", { name: "Synced from external calendar" }).first()
  ).toBeVisible();
  await expect(app.getByRole("img", { name: "Disconnected from calendar" })).toBeVisible();

  // Open a synced block's popover — title is read-only (schedule_locked). The
  // block's accessible name is "<title>, <time>"; the comma distinguishes it
  // from the like-named page-list item. The cross-zone "Design review (LA team)"
  // is a reliable afternoon block (the ~9am events fall in the collapsed band).
  await app.getByRole("button", { name: /Design review \(LA team\),/ }).click();
  const title = app.getByPlaceholder("Untitled");
  await expect(title).toHaveValue("Design review (LA team)");
  await expect(title).toHaveAttribute("readonly", "");
});

// ─── tier2: a synced block can't be dragged ──────────────────────────────────

// The only DOM-level proof that a calendar-owned block is immovable; every other
// check of this invariant is at the isolated-hook level (useTimedDrag/useTimedResize).
appTest("a synced block can't be dragged @tier2", async ({ app }) => {
  await seedSynced(app);
  await openCalendarMode(app);

  const block = app.getByRole("button", { name: /Design review \(LA team\),/ });
  await expect(block).toBeVisible();
  const before = await block.boundingBox();
  if (!before) throw new Error("synced block missing");
  // The accessible name is "<title>, <time>", so a schedule change would change it.
  const label = await block.getAttribute("aria-label");

  const cx = before.x + before.width / 2;
  const cy = before.y + before.height / 2;
  await app.mouse.move(cx, cy);
  await app.mouse.down();
  // Past dnd-kit's 8px activation threshold, then a full ~2h down the column.
  await app.mouse.move(cx, cy + 16, { steps: 4 });
  await app.mouse.move(cx, cy + 160, { steps: 10 });
  await app.mouse.up();

  const after = await block.boundingBox();
  expect(Math.abs((after?.y ?? -1) - before.y)).toBeLessThan(5);
  expect(await block.getAttribute("aria-label")).toBe(label);
});

// ─── tier2: FTS search finds a synced page ───────────────────────────────────

appTest("search finds a synced page @tier2", async ({ app }) => {
  await seedSynced(app);

  await app.keyboard.press(mod("Mod+k"));
  const dialog = app.getByRole("dialog", { name: "Search pages" });
  await expect(dialog).toBeVisible();
  await app.keyboard.type("Team standup");
  await expect(dialog.getByText("Team standup")).toBeVisible();
});
