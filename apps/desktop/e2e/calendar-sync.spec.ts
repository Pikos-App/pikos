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
  // Both providers ship in 0.4.0; the mock adapter reports an OAuth client, so
  // Google is offered rather than showing the not-available-in-this-build state.
  await expect(app.getByRole("button", { name: /Google/ })).toBeEnabled();

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

// ─── tier2: synced recurring completion (the recurring × synced intersection) ─
//
// The recurring × synced intersection previously had zero e2e. A synced recurring
// occurrence must complete through the unified completeRecurringPage with a *client*
// occurrence — never a bare updatePage(status), which the locked mirror rejects
// (mock guard parity). The seed's "Weekly 1:1 (London)" is London-source viewed under New York,
// so a green completion also proves cross-zone occurrence-date-key agreement:
// a mis-keyed occurrence would be rejected as "not part of this synced series"
// and no clone would land.

/** Open the external-calendar "Personal" folder — isolates the synced recurring
 *  head. A same-named draggable user folder also exists; the external one is the
 *  non-sortable sidebar item (external calendars aren't in the dnd reorder set). */
async function openPersonalFolder(app: Page) {
  await app.locator('[aria-label="Personal"]:not([aria-roledescription="sortable"])').click();
}

function seriesRows(app: Page) {
  return app.locator("[data-page-list-item]").filter({ hasText: "Weekly 1:1 (London)" });
}

appTest("completing a synced recurring occurrence drops one done clone, no read-only conflict @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);

  const head = seriesRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) });
  await expect(head).toHaveCount(1);
  await head.getByRole("checkbox", { name: /Mark done/i }).click();

  // Never surfaces the locked-mirror error (a mis-route to updatePage would).
  await expect(app.getByText(/read-only/i)).toHaveCount(0);

  // Exactly one durable done clone lands in Completed — a duplicate-append
  // regression on the completion path would show two.
  await app.getByRole("button", { name: "Completed", exact: true }).click();
  const doneClone = seriesRows(app).filter({
    has: app.getByRole("checkbox", { name: /Mark not done/i }),
  });
  await expect(doneClone).toHaveCount(1);
  // The head stayed open and advanced (still checkable) — it did not get marked done.
  await expect(seriesRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })).toHaveCount(1);
});

appTest("unchecking a synced recurring done clone restores the occurrence @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);

  await seriesRows(app)
    .filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
    .getByRole("checkbox", { name: /Mark done/i })
    .click();

  await app.getByRole("button", { name: "Completed", exact: true }).click();
  const doneClone = seriesRows(app).filter({
    has: app.getByRole("checkbox", { name: /Mark not done/i }),
  });
  await expect(doneClone).toHaveCount(1);

  // Uncheck the clone → uncompleteRecurringOccurrence drops the clone and rewinds
  // the head onto the restored occurrence.
  await doneClone.getByRole("checkbox", { name: /Mark not done/i }).click();
  await expect(
    seriesRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark not done/i }) })
  ).toHaveCount(0);
  await expect(
    seriesRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
  ).toHaveCount(1);
});

// ─── tier2: a moved synced occurrence renders at its new slot + completes ──────
//
// The reconciler stores an upstream-moved instance as an override row keyed to
// its original date; before this, nothing rendered it (an all-day move vanished,
// a timed move showed only a ghost at the old slot). Now the moved instance
// renders at its new time as a locked, completable block, and completing it
// records the ORIGINAL occurrence so the reminder derivation agrees. The seed's
// "Recurring review" moves one instance ~3 weeks out — past the dense current-week
// seed, so the block is unobstructed there. (Current-week synced recurring blocks
// collapse into overflow pills, so grid rendering is otherwise pinned at the
// useRecurrenceExpansion unit layer.)

/** Page forward until the moved override block (its new slot is 4 PM) renders. */
async function gotoMovedOverride(app: Page) {
  const moved = app.getByRole("button", { name: /Recurring review, 4/ });
  for (let i = 0; i < 6 && (await moved.count()) === 0; i++) {
    await app.getByRole("button", { name: "Next week" }).click();
    await app.waitForTimeout(400);
  }
  await expect(moved).toBeVisible();
  return moved;
}

appTest("a moved synced occurrence renders at its new slot, locked, and completes the original @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarMode(app);

  const moved = await gotoMovedOverride(app);

  // Locked mirror: opening it shows the read-only synced schedule (a native moved
  // block would be editable) — the block inherits the series page's lock.
  await moved.click();
  const title = app.getByPlaceholder("Untitled");
  await expect(title).toHaveValue("Recurring review");
  await expect(title).toHaveAttribute("readonly", "");

  // Complete via the popover's status toggle: routes through the unified
  // completeSyncedOccurrence keyed on the ORIGINAL occurrence — never a bare
  // updatePage(status) that the locked mirror rejects with a read-only error.
  await app.getByRole("button", { name: "Mark done" }).click();
  await expect(app.getByText(/read-only/i)).toHaveCount(0);

  // The done clone lands at the moved slot (the override drops out once its
  // original occurrence is completed) — re-open it; its status now reads Done. A
  // mis-keyed occurrence would reject with no clone, leaving the slot open.
  await app.getByRole("button", { name: /Recurring review, 4/ }).click();
  await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
});

// ─── tier2: a synced virtual occurrence's date is read-only ──────────────────
//
// Drag and resize are suppressed on a locked block, so the occurrence popover is
// the only surface left that can reach a locked series' reschedule. The seed's
// "Recurring review" is a synced weekly at 2 PM; the current week's block is the
// series head (a real page block), day+7 is an EXDATE and day+14 moved to an
// override — so the first plain virtual is day+21. Page forward before matching.

appTest("a synced recurring occurrence's popover offers no editable date @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarMode(app);

  const occurrence = app.getByRole("button", { name: /Recurring review, 2/ });
  await app.getByRole("button", { name: "Next week" }).click();
  await app.waitForTimeout(400);
  for (let i = 0; i < 6 && (await occurrence.count()) === 0; i++) {
    await app.getByRole("button", { name: "Next week" }).click();
    await app.waitForTimeout(400);
  }
  await expect(occurrence).toBeVisible();

  await occurrence.click();
  // The virtual popover, not the page one: it has a Skip action and no title input.
  await expect(app.getByRole("button", { name: "Skip this occurrence" })).toBeVisible();
  await expect(app.getByPlaceholder("Untitled")).toHaveCount(0);

  // Date renders as the read-only synced label — neither picker trigger is present.
  await expect(app.getByRole("button", { name: /^Scheduled:/ })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Set schedule" })).toHaveCount(0);
});

// ─── tier2: description-changed notice + read-only mirror metadata (B1) ───────
//
// When an event's upstream description changes after the user has edited the body,
// the reconciler parks the new text in pending_description rather than clobbering.
// The editor surfaces it as a passive, offline notice (rendered from the parked
// text, no re-fetch) — the user folds it in by hand; sync never overwrites. The
// same page shows its calendar-owned location + attendees read-only. The seed's
// "Team standup" carries all three.
appTest("a synced event shows the description-changed notice + read-only location/attendees @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);
  await app.locator("[data-page-list-item]").getByText("Team standup").click();

  // Read-only mirror metadata renders in the editor header.
  await expect(app.getByText("Zoom")).toBeVisible();
  await expect(app.getByText("3 guests")).toBeVisible();

  // The notice is present; the parked upstream text stays hidden until opened
  // (exact "View" avoids the byline's "View in calendar" button).
  await expect(app.getByText(/calendar description changed/i)).toBeVisible();
  await expect(app.getByText(/demo the new sync panel/i)).toHaveCount(0);
  await app.getByRole("button", { name: "View", exact: true }).click();
  await expect(app.getByText(/demo the new sync panel/i)).toBeVisible();
});

// ─── tier2: an overdue synced head reaches the gap dialog ────────────────────
//
// A synced head floors at the connect day, so occurrences that pass while the app
// is closed leave it genuinely overdue — the same shape a native series reaches.
// It must offer the same advance-one / skip-the-gap choice; the toggle router used
// to intercept a synced head and silently complete one occurrence per click. Uses
// the raw `page` fixture because clock.install must run before the first app
// script reads Date.

appTest("an overdue synced series completes through the gap dialog @tier2", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-08T09:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

  await seedSynced(page);

  await openPersonalFolder(page);
  const head = seriesRows(page).first();
  await expect(head).toBeVisible();

  // Two weeks on, last week's occurrence is missed. The mock never recomputes a
  // locked head, so it stays on the seeded date — the state a real mirror reaches
  // by being left closed.
  await page.clock.setFixedTime(new Date("2026-06-22T09:00:00"));

  await head.getByRole("checkbox", { name: /Mark done/i }).click();

  await expect(page.getByRole("button", { name: /Advance to next page/ })).toBeVisible();
  await page.getByRole("button", { name: /Advance to today/ }).click();
  await expect(page.getByRole("button", { name: /Advance to today/ })).not.toBeVisible();
  // The locked mirror accepted the completion — a mis-routed write would surface
  // the read-only rejection instead.
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
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
