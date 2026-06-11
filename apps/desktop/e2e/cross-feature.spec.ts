// E2E tests for cross-feature golden paths — flows that touch 2+ surfaces
// (quick-add ↔ today ↔ calendar ↔ editor ↔ folders ↔ search) and would break
// silently under refactor. Each test follows a complete user journey rather
// than poking at a single component.
//
// Runs against MockStorageAdapter (VITE_TEST_MODE=true). Browser-only — no
// Tauri APIs invoked.

import type { Page } from "@playwright/test";

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

/** Click the right-panel header's calendar toggle. Mirrors the helper used in
 *  calendar.spec.ts / recurring.spec.ts so we exercise the same shell-ready
 *  signal (the button only mounts after the layout settles). */
async function openCalendarMode(app: Page) {
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });
  await calendarBtn.waitFor({ state: "visible" });
  if ((await calendarBtn.getAttribute("aria-pressed")) !== "true") {
    await calendarBtn.click();
  }
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

async function openEditorMode(app: Page) {
  const editorBtn = app.getByRole("button", { name: "Editor view" });
  await editorBtn.waitFor({ state: "visible" });
  if ((await editorBtn.getAttribute("aria-pressed")) !== "true") {
    await editorBtn.click();
  }
}

// ─── Quick-add → Today → complete → Completed accordion ────────────────────
//
// Cross-cuts: QuickAdd NLP (parse @today), folder-list smart views (Today
// filter), page-list status toggle, completed accordion. A regression in any
// of these surfaces would silently break this everyday flow.

appTest(
  "quick-add @today lands in Today, complete moves it to Completed @tier1",
  async ({ app }) => {
    // Two pages so we can tell the filter is doing real work.
    await quickAdd(app, "ship release notes @today");
    await quickAdd(app, "someday backlog");

    await app.getByRole("button", { name: /^Today/ }).click();
    const list = app.locator("[data-page-list-item]");
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();

    // Complete the page from its list-item checkbox. The active list scopes
    // before the Completed accordion expands, so a "Mark done" checkbox
    // outside Completed must belong to the open page.
    const release = list.filter({ hasText: "ship release notes" });
    await release.getByRole("checkbox", { name: "Mark done" }).click();

    await expect(release).not.toBeVisible();

    // Today view's Completed accordion now has it. Today filters to scheduled
    // pages regardless of status — the page is still scheduled, just done.
    const completedToggle = app.getByRole("button", { name: /^Completed/ });
    await completedToggle.click();
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    // The unscheduled page does NOT bleed into Today's Completed section.
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();
  }
);

// ─── Drag page from list onto calendar → schedule round-trips ──────────────
//
// Cross-cuts: page-list drag source, calendar all-day drop target, page
// scheduledStart denorm, page-list date chip, editor byline schedule chip.
// The dnd-kit PointerSensor in this app activates at 8 px of motion, so we
// nudge past the threshold before moving onto the target column.

appTest(
  "drag unscheduled page onto calendar all-day → schedule shows everywhere @tier2",
  async ({ app }) => {
    await quickAdd(app, "draggable task");

    // Open the calendar so an all-day column exists in the same viewport as
    // the page list — drag-to-calendar requires both sides on screen.
    await openCalendarMode(app);

    const list = app.locator("[data-page-list-item]");
    const item = list.filter({ hasText: "draggable task" });
    await expect(item).toBeVisible();

    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page list item has no bounding box");

    // Grab the rightmost-visible all-day column — anchoring on the last column
    // keeps the dropped date inside the current week and avoids the
    // "next-upcoming" filter on past schedules.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target all-day column missing");

    // Read the column's accessible name BEFORE dragging — once dropped, the
    // page list re-renders with the date label, so we can verify the chip
    // refers to the same day we dropped on. The aria-label is shaped
    // "All-day events, <Weekday> <Month> <Day>".
    const dropAriaLabel = (await targetCol.getAttribute("aria-label")) ?? "";
    const dropMatch = /All-day events, \w+ (\w+) (\d+)/.exec(dropAriaLabel);
    if (!dropMatch) throw new Error(`unexpected aria-label: ${dropAriaLabel}`);
    // The column aria-label spells the month in full ("June"); the page-list
    // date chip uses the abbreviated form ("Jun"). en-US short months are the
    // first three letters of the long name, so slice to match the chip.
    const dropMonthDay = `${dropMatch[1]!.slice(0, 3)} ${dropMatch[2]!}`;

    // dnd-kit sensor needs ≥8px before activation — first nudge inside the
    // page list, then move onto the column.
    const startX = itemBox.x + itemBox.width / 2;
    const startY = itemBox.y + itemBox.height / 2;
    const targetX = targetBox.x + targetBox.width / 2;
    const targetY = targetBox.y + targetBox.height / 2;

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 16, startY, { steps: 4 });
    await app.mouse.move(targetX, targetY, { steps: 10 });
    await app.mouse.up();

    const calendarChip = app
      .getByRole("region", { name: "Week calendar" })
      .getByRole("button", { name: "draggable task" });
    await expect(calendarChip).toHaveCount(1);

    // Page list now shows a date chip on the same item — the formatted date
    // includes the dropped column's "Month Day" text.
    await expect(item).toContainText(dropMonthDay);

    // Editor byline (right panel) reflects the schedule too. Open the page
    // and assert the schedule chip has flipped from "Set schedule" to
    // "Scheduled: …". Switching to editor first prevents the
    // calendar-popover schedule chip from racing the byline assertion.
    await openEditorMode(app);
    await item.click();
    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();
    await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();
  }
);

// ─── Search palette → open → edit title → palette reflects new title ───────
//
// Cross-cuts: search FTS index, page-list active state, editor inline title
// rename, search-result freshness. Verifies the editor's title write actually
// reaches the search index (a regression here would silently leave palette
// results stale even after a rename).

appTest(
  "rename via editor reflects in subsequent Cmd+K search results @tier2",
  async ({ app }) => {
    await quickAdd(app, "alpha proposal");
    await quickAdd(app, "beta proposal");

    await app.keyboard.press(mod("Mod+k"));
    const palette = app.getByRole("dialog", { name: "Search pages" });
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder("Search pages…").fill("alpha");
    await expect(palette.getByText("alpha proposal")).toBeVisible();
    await app.keyboard.press("Enter");
    await expect(palette).not.toBeVisible();

    await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
      "alpha proposal"
    );

    const titleDisplay = app.getByLabel("Page title");
    await titleDisplay.click();
    // Wait for edit mode — the textarea replaces the display div on focus.
    await expect(app.getByRole("textbox", { name: "Page title" })).toBeFocused();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("zenith proposal");
    await expect(app.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "zenith proposal"
    );

    // Click out of the title to commit, then re-open the palette and search
    // by the new title. The result must surface immediately — the search
    // index reads from in-memory pages, not a stale snapshot.
    await app.locator("body").click({ position: { x: 0, y: 0 } });

    await app.keyboard.press(mod("Mod+k"));
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder("Search pages…").fill("zenith");
    await expect(palette.getByText("zenith proposal")).toBeVisible();

    // The old title must NOT match — proves the rename replaced rather than
    // appended a search-index entry.
    await palette.getByPlaceholder("Search pages…").fill("alpha");
    // FTS5 rebuild is debounced 150 ms; the retry-until-true semantics of
    // `not.toBeVisible({ timeout })` walk the wait for us — no bare sleep.
    await expect(palette.getByText("alpha proposal")).not.toBeVisible({ timeout: 1000 });
  }
);

// ─── Folder rename → pages still resolvable, smart views still correct ─────
//
// Cross-cuts: folder list, folder rename, page→folder denorm, folder-scoped
// page filter, Today smart-view filter (page schedule still applies). A
// regression that drops folderId during rename would lose the page from
// every view; a regression that doesn't refresh the sidebar label would
// confuse the user.

appTest(
  "rename a folder → its pages stay reachable; Today still finds scheduled ones @tier2",
  async ({ app }) => {
    // Seed a folder named "Work" and put one scheduled, one unscheduled page in it.
    await app
      .getByRole("toolbar", { name: "Folder actions" })
      .getByRole("button", { name: "New Folder" })
      .click();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("Work");
    await app.keyboard.press("Enter");

    // Active folder is now "Work" — quickAdd lands here. Avoid words like
    // "weekly"/"daily"/"monthly" in the title since the QuickAdd parser
    // strips them as recurrence keywords (would leave title="review" with
    // an unwanted FREQ=WEEKLY rule attached).
    await quickAdd(app, "kickoff sync @today");
    await quickAdd(app, "research notes");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const folderBtn = sidebar.getByRole("button", { name: "Work", exact: true });
    await expect(folderBtn).toBeVisible();

    // Rename via context menu — Right-click → Rename → wait for focus → replace.
    // The rename input sits inside a role="button" wrapper, which makes
    // Playwright's `.fill()` flake on the "enabled" check. Instead we wait
    // for the input to be focused (useInlineRename focuses across rAF
    // retries — racing the keyboard input was the original flake), then
    // Mod+A + type replaces atomically.
    await folderBtn.click({ button: "right" });
    await app.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = app.getByRole("textbox", { name: "Rename Work" });
    await expect(renameInput).toBeFocused();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("Workstreams");
    await app.keyboard.press("Enter");

    await expect(
      sidebar.getByRole("button", { name: "Workstreams", exact: true })
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Work", exact: true })
    ).not.toBeVisible();

    // Pages survive the rename — both still listed in the renamed folder.
    await sidebar.getByRole("button", { name: "Workstreams", exact: true }).click();
    const list = app.locator("[data-page-list-item]");
    await expect(list.filter({ hasText: "kickoff sync" })).toBeVisible();
    await expect(list.filter({ hasText: "research notes" })).toBeVisible();

    // Today still surfaces the scheduled page. The folder-rename path must
    // not have stripped scheduledStart.
    await app.getByRole("button", { name: /^Today/ }).click();
    await expect(list.filter({ hasText: "kickoff sync" })).toBeVisible();
    await expect(list.filter({ hasText: "research notes" })).not.toBeVisible();
  }
);

// ─── Multi-select drag → calendar schedules N pages ─────────────────────────
//
// useThreePanelDnD has dedicated multi-page drop logic (single-page drop
// preserves duration; multi-page drop staggers timed events or applies
// all-day to all). This test exercises the all-day branch — three pages
// dropped onto the same day end up with three chips on that day.

appTest(
  "multi-select drag of 3 pages onto an all-day column schedules all 3 @tier2",
  async ({ app }) => {
    await quickAdd(app, "alpha task");
    await quickAdd(app, "beta task");
    await quickAdd(app, "gamma task");

    const list = app.locator("[data-page-list-item]");
    const alpha = list.filter({ hasText: "alpha task" });
    const beta = list.filter({ hasText: "beta task" });
    const gamma = list.filter({ hasText: "gamma task" });

    // Switch to calendar mode via keyboard — clicking the toggle button
    // would mousedown outside the page list and clear selection later.
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // Cmd+Click each page to multi-select without activating — plain click
    // would route through openPage and force the right panel back to editor,
    // collapsing the calendar.
    await alpha.click({ modifiers: ["Meta"] });
    await beta.click({ modifiers: ["Meta"] });
    await gamma.click({ modifiers: ["Meta"] });
    await expect(alpha).toHaveAttribute("data-selected", "true");
    await expect(beta).toHaveAttribute("data-selected", "true");
    await expect(gamma).toHaveAttribute("data-selected", "true");

    // Calendar must still be open after the selection.
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // Drop target — the rightmost-visible all-day column so the drop date
    // stays inside the current week.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target column missing");

    // Start the drag from one of the selected items (alpha) — dnd-kit
    // associates the drag activation with the originating sortable.
    const startBox = await alpha.boundingBox();
    if (!startBox) throw new Error("source item missing");
    const startX = startBox.x + startBox.width / 2;
    const startY = startBox.y + startBox.height / 2;
    const targetX = targetBox.x + targetBox.width / 2;
    const targetY = targetBox.y + targetBox.height / 2;

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 16, startY, { steps: 4 });
    await app.mouse.move(targetX, targetY, { steps: 10 });
    await app.mouse.up();

    const calendar = app.getByRole("region", { name: "Week calendar" });
    await expect(calendar.getByRole("button", { name: "alpha task" })).toHaveCount(1);
    await expect(calendar.getByRole("button", { name: "beta task" })).toHaveCount(1);
    await expect(calendar.getByRole("button", { name: "gamma task" })).toHaveCount(1);
  }
);

// ─── Drag page from list onto Today nav row → schedules for today ──────────
//
// useThreePanelDnD's `at === "page" && ot === "view-today"` branch handles
// drag-to-Today. The Today smart view filters by scheduledStart, so a
// successfully scheduled page appears there. A regression in the droppable
// wiring or the scheduleOnce call would leave the page in Inbox.

appTest(
  "drag an unscheduled page onto the Today nav row schedules it for today @tier2",
  async ({ app }) => {
    await quickAdd(app, "drop subject");

    // The page lands in Inbox unscheduled. Navigate there so the drag source
    // is visible regardless of the active view's default.
    await app.getByRole("button", { name: /^Inbox/ }).click();

    const item = app
      .locator("[data-page-list-item]")
      .filter({ hasText: "drop subject" });
    await expect(item).toBeVisible();
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page item missing");

    // Today nav row in the sidebar — same droppable shape as Inbox.
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const todayRow = sidebar.getByRole("button", { name: /^Today/ });
    const todayBox = await todayRow.boundingBox();
    if (!todayBox) throw new Error("Today row missing");

    // dnd-kit activation: nudge ≥8 px before moving onto the target.
    const startX = itemBox.x + itemBox.width / 2;
    const startY = itemBox.y + itemBox.height / 2;
    const todayX = todayBox.x + todayBox.width / 2;
    const todayY = todayBox.y + todayBox.height / 2;

    // Today badge starts at 0 — confirms the page is unscheduled before the drop.
    await expect(todayRow).toHaveText(/^Today$/);

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 16, startY, { steps: 4 });
    await app.mouse.move(todayX, todayY, { steps: 10 });
    await app.mouse.up();

    // Today badge flips to 1 — proves scheduleOnce ran with today's date.
    // Inbox filter is folder_id IS NULL only, so the page also stays in
    // Inbox; we don't assert on it disappearing.
    await expect(todayRow).toHaveText(/^Today\s*1$/);

    // Move the cursor off the Today row before clicking — same race the
    // folder-drag test guards against (button is both click target and
    // dnd-kit droppable).
    await app.mouse.move(0, 0);

    // Today view shows the page — schedule was applied as all-day for today.
    await todayRow.click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "drop subject" })
    ).toBeVisible();
  }
);

// ─── Drag page from list onto a sidebar folder → page moves ─────────────────
//
// useThreePanelDnD's `at === "page" && ot === "folder"` branch handles
// drag-to-folder moves. Pages.spec.ts covers the context-menu path; this
// test covers the DnD path. A regression in the folder droppable wiring
// would silently leave the page in its current folder.

appTest(
  "drag a page from list onto a sidebar folder moves it @tier2",
  async ({ app }) => {
    await app
      .getByRole("toolbar", { name: "Folder actions" })
      .getByRole("button", { name: "New Folder" })
      .click();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("Archive");
    await app.keyboard.press("Enter");

    await app.getByRole("button", { name: /^Inbox/ }).click();
    await quickAdd(app, "movable doc");

    const item = app.locator("[data-page-list-item]").filter({ hasText: "movable doc" });
    await expect(item).toBeVisible();
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page item missing");

    // Sidebar folder buttons receive page drops via useThreePanelDnD.
    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const folder = sidebar.getByRole("button", { name: "Archive", exact: true });
    const folderBox = await folder.boundingBox();
    if (!folderBox) throw new Error("folder missing");

    // dnd-kit activation: nudge ≥8 px before moving onto the target.
    const startX = itemBox.x + itemBox.width / 2;
    const startY = itemBox.y + itemBox.height / 2;
    const folderX = folderBox.x + folderBox.width / 2;
    const folderY = folderBox.y + folderBox.height / 2;

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 16, startY, { steps: 4 });
    await app.mouse.move(folderX, folderY, { steps: 10 });
    await app.mouse.up();

    await expect(item).not.toBeVisible();

    // Move the cursor off the folder before clicking. The folder button is
    // both a click target and a dnd-kit droppable; clicking it immediately
    // after `mouse.up` while the cursor still hovers can race with the
    // drag-end cleanup and swallow the navigation. Moving away first
    // guarantees a clean fresh pointer sequence.
    await app.mouse.move(0, 0);

    await folder.click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "movable doc" })
    ).toBeVisible();
  }
);
