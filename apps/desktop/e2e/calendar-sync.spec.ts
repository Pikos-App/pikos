// Mock-driven (VITE_TEST_MODE=true → MockStorageAdapter): no network, no real
// CalDAV/Google creds. Live auth/transport is exercised only in the manual
// pre-release layer.
//
// The synced-block tests need the "synced" dev seed (Settings → Developer),
// available because the e2e webServer runs the Vite dev server.

import type { Page } from "@playwright/test";

import { expect, mod, test as appTest } from "./fixtures";

// Synced events render in the viewer's zone, so pin one and the seed's block
// positions are the same everywhere.
appTest.use({ timezoneId: "America/New_York" });

async function openSyncPanel(app: Page) {
  await app.getByRole("button", { name: "Open settings" }).click();
  await app.getByRole("button", { name: "Calendar Sync" }).click();
}

/** Connect a mock CalDAV account, leaving the Sync panel open on its card. The
 *  username varies the account identity — every account offers the same two
 *  calendar names, so a second one collides with the first by design. */
async function connectCaldav(app: Page, username = "me@example.com") {
  await openSyncPanel(app);
  await app.getByRole("button", { name: "Add account" }).click();
  await app.getByRole("button", { name: /CalDAV/ }).click();

  await app.getByLabel("Server URL").fill("https://caldav.example.com");
  await app.getByLabel("Username").fill(username);
  await app.getByLabel("App password").fill("app-pw");
  await app.getByRole("button", { name: "Connect" }).click();

  await expect(app.getByRole("switch", { name: "Sync Personal" }).first()).toBeVisible();
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

  const connect = app.getByRole("button", { name: "Connect" });
  await expect(connect).toBeDisabled();
  await app.getByLabel("Server URL").fill("https://caldav.example.com");
  await app.getByLabel("Username").fill("me@example.com");
  await app.getByLabel("App password").fill("app-pw");
  await expect(connect).toBeEnabled();
  await connect.click();

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

  await expect(app.getByRole("button", { name: "Colour for Personal" })).toBeVisible();
});

// ─── tier2: resync + disconnect ──────────────────────────────────────────────

appTest("resync then disconnect removes the account and its folder @tier2", async ({ app }) => {
  await connectCaldav(app);
  await app.getByRole("switch", { name: "Sync Personal" }).click();

  const menu = app.getByRole("button", { name: /Account actions for/ });
  await menu.click();
  await app.getByRole("menuitem", { name: "Resync now" }).click();

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

// ─── tier2: two accounts, colliding calendar names ───────────────────────────

appTest("same-named calendars on two accounts separate under account headings @tier2", async ({
  app,
}) => {
  await connectCaldav(app, "work@example.com");
  await app.getByRole("switch", { name: "Sync Personal" }).click();
  await app.keyboard.press("Escape");

  await connectCaldav(app, "home@example.com");
  const personalSwitches = app.getByRole("switch", { name: "Sync Personal" });
  await expect(personalSwitches).toHaveCount(2);
  await personalSwitches.nth(1).click();
  await app.keyboard.press("Escape");

  const work = app.getByRole("group", { name: /^work@example\.com/ });
  const home = app.getByRole("group", { name: /^home@example\.com/ });
  await expect(work.getByRole("button", { name: "Personal" })).toBeVisible();
  await expect(home.getByRole("button", { name: "Personal" })).toBeVisible();

  // Down to one account there is nothing left to disambiguate, so the headings go.
  await openSyncPanel(app);
  await app.getByRole("button", { name: /Account actions for home@example\.com/ }).click();
  await app.getByRole("menuitem", { name: "Disconnect" }).click();
  await app.getByRole("alertdialog", { name: /Disconnect/ }).waitFor();
  await app.getByRole("button", { name: "Disconnect" }).click();
  await app.keyboard.press("Escape");

  await expect(app.getByRole("group", { name: /@example\.com/ })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Personal" })).toBeVisible();
});

// ─── tier2: the seed is legible on the calendar at all ───────────────────────
//
// A seed slot collision fails silently: the loser collapses into the "+N more"
// pill and stops existing for every other check here. Three of the five did.

appTest("every seeded Personal synced event renders as its own block @tier2", async ({ app }) => {
  await seedSynced(app);
  await openCalendarMode(app);

  // The trailing time is what a grid block has and the page-list item doesn't.
  for (const name of [
    /Team standup, /,
    /Weekly 1:1 \(London\), /,
    /Recurring review, /,
    /Design review \(LA team\), /,
  ]) {
    await expect(app.getByRole("button", { name })).toBeVisible();
  }
  // All-day events sit in their own bar, with no time.
  await expect(app.getByRole("button", { name: "Company offsite" })).toBeVisible();
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
  await expect(app.getByRole("img", { name: "Disconnected from calendar" }).first()).toBeVisible();

  // Open a synced block's popover — title is read-only (schedule_locked). The
  // block's accessible name is "<title>, <time>"; the comma distinguishes it
  // from the like-named page-list item.
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
// First e2e coverage of the recurring × synced intersection. The seed's "Weekly
// 1:1 (London)" is London-source viewed under New York, so a green completion
// also proves cross-zone occurrence-date-key agreement — a mis-keyed occurrence
// would be rejected as "not part of this synced series" and no clone would land.

/** Open an external-calendar folder by name. A same-named draggable user folder
 *  may also exist; the external one is the non-sortable sidebar item (external
 *  calendars aren't in the dnd reorder set). */
async function openCalendarFolder(app: Page, name: string) {
  await app.locator(`[aria-label="${name}"]:not([aria-roledescription="sortable"])`).click();
}

async function openPersonalFolder(app: Page) {
  await openCalendarFolder(app, "Personal");
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

  // uncompleteRecurringOccurrence drops the clone and rewinds the head onto the
  // restored occurrence.
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
// An upstream-moved instance is stored as an override row keyed to its original
// date — previously nothing rendered it (an all-day move vanished, a timed move
// ghosted at the old slot). It now renders locked and completable at its new
// time, and completing it records the ORIGINAL occurrence so reminder derivation
// agrees. The seed's "Recurring review" moves one instance ~3 weeks out, to 3 PM.

/** Page forward until the moved override block (its new slot is 3 PM) renders. */
async function gotoMovedOverride(app: Page) {
  const moved = app.getByRole("button", { name: /Recurring review, 3/ });
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

  // Routes through completeSyncedOccurrence, keyed on the ORIGINAL occurrence.
  await app.getByRole("button", { name: "Mark done" }).click();
  await expect(app.getByText(/read-only/i)).toHaveCount(0);

  // The done clone lands at the moved slot — the override drops out once its
  // original occurrence is completed. A mis-keyed occurrence would reject with
  // no clone, leaving the slot open.
  await app.getByRole("button", { name: /Recurring review, 3/ }).click();
  await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
});

// ─── tier2: the tick routing splits on sync origin ──────────────────────────
//
// A synced-origin occurrence is ticked where it renders: completion is a record
// that this instance is resolved, so the checkbox sits on the block and the head
// is untouched. A native virtual keeps the repeat glyph and no checkbox — its
// completions funnel to the head, which is always the next thing due.

appTest("a synced virtual completes itself; a native virtual has no checkbox @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarMode(app);

  // Page forward to a week made entirely of virtuals of the weekly London series.
  const virtualLabel = /Weekly 1:1 \(London\)/;
  for (let i = 0; i < 3; i++) {
    await app.getByRole("button", { name: "Next week" }).click();
    await app.waitForTimeout(400);
  }
  const virtual = app.getByRole("button", { name: virtualLabel }).first();
  await expect(virtual).toBeVisible();

  // No repeat glyph on a synced-origin occurrence — it carries a checkbox, and its
  // popover offers the same status toggle a real block does.
  await expect(virtual.getByLabel("Recurring")).toHaveCount(0);
  await virtual.click();
  await app.getByRole("button", { name: "Mark done" }).click();
  await expect(app.getByText(/read-only/i)).toHaveCount(0);

  // That occurrence alone is resolved: its slot shows a done page, and the series
  // still has exactly one open head row in the list.
  await expect(app.getByRole("button", { name: virtualLabel }).first()).toBeVisible();
  await openPersonalFolder(app);
  await expect(
    seriesRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
  ).toHaveCount(1);

  // A native series' virtual is the other arm of the split: glyph, no checkbox.
  await app.keyboard.press(mod("Mod+n"));
  const dialog = app.getByRole("dialog", { name: "Quick add" });
  await expect(dialog).toBeVisible();
  await app.getByRole("textbox", { name: "Quick add input" }).fill("standup every day at 9am");
  await expect(dialog.getByRole("button", { name: /Recurrence: every day/i })).toBeVisible({
    timeout: 2000,
  });
  await app.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();

  await openCalendarMode(app);
  await app.getByRole("button", { name: "Next week" }).click();
  const nativeVirtual = app
    .getByRole("button", { name: /^standup/i })
    .filter({ has: app.getByLabel("Recurring") })
    .first();
  await expect(nativeVirtual).toBeVisible({ timeout: 5_000 });
  await nativeVirtual.click();
  await expect(app.getByRole("button", { name: "Mark done" })).toHaveCount(0);
});

// ─── tier2: a detached series keeps its occurrences in-series ────────────────
//
// A detached synced series is the user's to move, but it still has an upstream to
// re-link to — so a moved occurrence stays an override row keyed to its original
// date rather than cloning out of the series. Two halves: the seeded
// provider-moved instance renders unlocked and completes on its ORIGINAL date
// with the head untouched, and dragging a plain virtual mints an override
// (one block, no clone) instead of materialising a page.
//
// The seed's "Detached sprint" is weekly from today 7:15 AM, with day+14's
// instance moved to day+16 at 3 PM.

function sprintBlocks(app: Page, timeLabel: RegExp) {
  return app.getByRole("button", { name: timeLabel });
}

function sprintRows(app: Page) {
  return app.locator("[data-page-list-item]").filter({ hasText: "Detached sprint" });
}

appTest("a detached series' moved occurrence is editable and completes its original date @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarFolder(app, "Work");
  await openCalendarMode(app);

  const moved = sprintBlocks(app, /Detached sprint, 3/);
  for (let i = 0; i < 6 && (await moved.count()) === 0; i++) {
    await app.getByRole("button", { name: "Next week" }).click();
    await app.waitForTimeout(400);
  }
  await expect(moved).toBeVisible();

  // Unlocked, unlike the active series' moved block above: detach hands the page
  // back to the user while the override row keeps the re-link path open.
  await moved.click();
  const title = app.getByPlaceholder("Untitled");
  await expect(title).toHaveValue("Detached sprint");
  await expect(title).not.toHaveAttribute("readonly", "");

  await app.getByRole("button", { name: "Mark done" }).click();

  // The done clone lands at the moved slot and the override drops out. Completion
  // keyed on the moved day instead of the original would be rejected as not part
  // of the series, leaving the slot open.
  await moved.click();
  await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();
  await app.keyboard.press("Escape");

  // The head is still open at its own date — an occurrence was completed, not the
  // series (the done clone is the only other row, and it isn't the head).
  await expect(
    sprintRows(app).filter({ has: app.getByRole("checkbox", { name: /Mark done/i }) })
  ).toHaveCount(1);
});

appTest("dragging a detached series' virtual leaves one block and no clone @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarFolder(app, "Work");
  await expect(sprintRows(app)).toHaveCount(1);
  await openCalendarMode(app);

  // One week on, the visible window is wholly after the head, so the 7:15 block
  // is a virtual rather than the head page itself.
  await app.getByRole("button", { name: "Next week" }).click();
  const virtual = sprintBlocks(app, /Detached sprint, 7:15/);
  await expect(virtual).toBeVisible();
  await virtual.scrollIntoViewIfNeeded();
  const box = await virtual.boundingBox();
  if (!box) throw new Error("virtual block has no bounding box");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await app.mouse.move(startX, startY);
  await app.mouse.down();
  await app.mouse.move(startX, startY + 12, { steps: 5 }); // past the drag threshold
  await app.mouse.move(startX, startY + 60, { steps: 5 }); // one hour later
  await app.mouse.up();

  // The occurrence moved rather than duplicating: nothing left at the old slot.
  await expect(sprintBlocks(app, /Detached sprint, 8:15/)).toHaveCount(1);
  await expect(sprintBlocks(app, /Detached sprint, 7:15/)).toHaveCount(0);

  // A clone-and-exdate would render one block here too — the Work list's row count
  // is what separates them. No page materialised: the occurrence stayed in-series.
  await expect(sprintRows(app)).toHaveCount(1);
});

// ─── tier2: a synced virtual occurrence's date is read-only ──────────────────
//
// Drag/resize are suppressed on a locked block, so the occurrence popover is the
// only surface that can reach a locked series' reschedule. The seed's "Recurring
// review" head is this week, day+7 is an EXDATE, day+14 is moved to an override
// — the first plain virtual is day+21.

appTest("a synced recurring occurrence's popover offers no editable date @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openCalendarMode(app);

  const occurrence = app.getByRole("button", { name: /Recurring review, 10/ });
  await app.getByRole("button", { name: "Next week" }).click();
  await app.waitForTimeout(400);
  for (let i = 0; i < 6 && (await occurrence.count()) === 0; i++) {
    await app.getByRole("button", { name: "Next week" }).click();
    await app.waitForTimeout(400);
  }
  await expect(occurrence).toBeVisible();

  await occurrence.click();
  // The virtual popover, not the page one: its delete names the local copy, and it
  // has no title input.
  await expect(
    app.getByRole("button", { name: "Remove this occurrence from Pikos" })
  ).toBeVisible();
  await expect(app.getByPlaceholder("Untitled")).toHaveCount(0);

  // Date renders as the read-only synced label — neither picker trigger is present.
  await expect(app.getByRole("button", { name: /^Scheduled:/ })).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Set schedule" })).toHaveCount(0);
});

// ─── tier2: description-changed notice + read-only mirror metadata ───────────
//
// pending_description surfaces as a passive, offline notice — the user folds it
// in by hand, sync never overwrites. The seed's "Team standup" carries a pending
// description plus read-only location/attendees.
appTest("a synced event shows the description-changed notice + read-only location/attendees @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);
  await app.locator("[data-page-list-item]").getByText("Team standup").click();

  await expect(app.getByText("Zoom")).toBeVisible();
  await expect(app.getByText("3 guests")).toBeVisible();

  // Exact "View" avoids the byline's "View in calendar" button.
  await expect(app.getByText(/calendar description changed/i)).toBeVisible();
  await expect(app.getByText(/demo the new sync panel/i)).toHaveCount(0);
  await app.getByRole("button", { name: "View", exact: true }).click();
  await expect(app.getByText(/demo the new sync panel/i)).toBeVisible();
});

// ─── tier2: an overdue synced head reaches the gap dialog ────────────────────
//
// A synced head floors at the connect day, so occurrences that pass while the app
// is closed leave it genuinely overdue — the same shape a native series reaches,
// and it gets the same scope question. Uses the raw `page` fixture because
// clock.install must run before the first app script reads Date.

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

  await expect(page.getByRole("button", { name: /Just this one/ })).toBeVisible();
  await page.getByRole("button", { name: /This and everything before today/ }).click();
  await expect(
    page.getByRole("button", { name: /This and everything before today/ })
  ).not.toBeVisible();
  // The locked mirror accepted the completion — a mis-routed write would surface
  // the read-only rejection instead.
  await expect(page.getByText(/read-only/i)).toHaveCount(0);
});

// ─── tier2: a past synced one-off stays in Today until ticked ────────────────
//
// The predicate is unit-pinned; this covers the round trip — the row reaches
// Today's Overdue group, and the tick lands on the locked mirror instead of
// being rejected read-only.

appTest("a past synced one-off shows in Today and clears when ticked @tier2", async ({ app }) => {
  await seedSynced(app);

  await app.getByRole("button", { name: /^Today/ }).click();
  await app.getByRole("button", { name: /^Overdue/ }).click();

  const list = app.locator("[data-page-list-item]");
  const signoff = list.filter({ hasText: "Budget sign-off" });
  await expect(signoff).toBeVisible();

  await signoff.getByRole("checkbox", { name: "Mark done" }).click();

  await expect(signoff).not.toBeVisible();

  // In Completed, not merely filtered out — the tick reached the locked mirror.
  await app.getByRole("button", { name: /^Completed/ }).click();
  await expect(signoff).toBeVisible();
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

// ─── tier2: the page list honours the mirror lock ────────────────────────────
//
// DOM-level proof for the list side of the lock, mirroring "a synced block can't
// be dragged" on the calendar side. The unit tests call handleDragEnd directly and
// fake the mousemove, so nothing below them exercises dnd-kit's activation
// threshold, the real ghost, or the actual context menu. Both tests pair a locked
// page against the seed's detached one — same list, same shape, differing only in
// lock state, which is the axis the fix keys on.

appTest("a synced page's context menu offers no move, rename or date edit @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);

  await app.locator("[data-page-list-item]").filter({ hasText: "Team standup" }).click({
    button: "right",
  });
  // Delete stays — trashing a synced page is supported (it tombstones the link).
  await expect(app.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: "Move to Folder" })).toHaveCount(0);
  await expect(app.getByRole("menuitem", { name: "Clear Date" })).toHaveCount(0);
  await expect(app.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);

  await app.keyboard.press("Escape");

  // The detached page is the control: unlocked, so every item comes back.
  await openCalendarFolder(app, "Work");
  await app.locator("[data-page-list-item]").filter({ hasText: "Old planning" }).click({
    button: "right",
  });
  await expect(app.getByRole("menuitem", { name: "Move to Folder" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: "Clear Date" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: "Rename" })).toBeVisible();
});

/**
 * Drag a page-list row into the week grid, reporting the drop ghost's visibility while
 * the cursor is still over the grid. Ghost presence is the only honest signal here: the
 * end state can't tell "blocked" from "attempted", because a rejected schedule write
 * rolls the optimistic update back and the date label reads unchanged either way.
 */
async function dragRowOntoCalendar(app: Page, rowText: string) {
  const row = app.locator("[data-page-list-item]").filter({ hasText: rowText });
  await expect(row).toHaveCount(1);
  const dateButton = row.getByRole("button", { name: /^Toggle date format:/ });
  const before = await dateButton.getAttribute("aria-label");

  const rowBox = await row.boundingBox();
  const grid = await app.getByRole("region", { name: "Week calendar" }).boundingBox();
  if (!rowBox || !grid) throw new Error("page row or week grid missing a bounding box");

  await app.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await app.mouse.down();
  // Past dnd-kit's 8px activation threshold, then into the grid.
  await app.mouse.move(rowBox.x + rowBox.width / 2 + 16, rowBox.y + rowBox.height / 2, {
    steps: 4,
  });
  await app.mouse.move(grid.x + grid.width * 0.6, grid.y + grid.height * 0.4, { steps: 10 });
  const ghosted = (await app.locator("[data-drag-ghost]").count()) > 0;
  await app.mouse.up();

  return { after: await dateButton.getAttribute("aria-label"), before, ghosted };
}

appTest("a synced page can't be dragged from the list onto the calendar @tier2", async ({
  app,
}) => {
  await seedSynced(app);
  await openPersonalFolder(app);
  await openCalendarMode(app);

  const locked = await dragRowOntoCalendar(app, "Team standup");
  expect(locked.ghosted).toBe(false);
  expect(locked.after).toBe(locked.before);

  // The detached page is the control: the same drag previews and lands, so the
  // assertions above are the lock and not a broken drag harness.
  await openCalendarFolder(app, "Work");
  const detached = await dragRowOntoCalendar(app, "Old planning");
  expect(detached.ghosted).toBe(true);
  expect(detached.after).not.toBe(detached.before);
});
