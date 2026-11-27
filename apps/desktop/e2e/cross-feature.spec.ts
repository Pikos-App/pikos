// Golden paths that touch 2+ surfaces and would break silently under refactor; each follows a complete user
// journey. Runs against MockStorageAdapter (VITE_TEST_MODE=true), browser-only with no Tauri APIs.

import type { Page } from "@playwright/test";

import { test as appTest, createFolder, expect, mod, openCalendarMode, quickAdd } from "./fixtures";

async function openEditorMode(app: Page) {
  const editorBtn = app.getByRole("button", { name: "Editor view" });
  await editorBtn.waitFor({ state: "visible" });
  if ((await editorBtn.getAttribute("aria-pressed")) !== "true") {
    await editorBtn.click();
  }
}

appTest(
  "quick-add @today lands in Today, complete moves it to Completed @smoke",
  async ({ app }) => {
    // Two pages so we can tell the filter is doing real work.
    await quickAdd(app, "ship release notes @today");
    await quickAdd(app, "someday backlog");

    await app.getByRole("button", { name: /^Today/ }).click();
    const list = app.locator("[data-page-list-item]");
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();

    // The active list scopes before the Completed accordion expands, so a "Mark done" checkbox outside Completed must belong to the open page.
    const release = list.filter({ hasText: "ship release notes" });
    await release.getByRole("checkbox", { name: "Mark done" }).click();

    await expect(release).not.toBeVisible();

    // Today filters to scheduled pages regardless of status, so the done page is still listed.
    const completedToggle = app.getByRole("button", { name: /^Completed/ });
    await completedToggle.click();
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();
  }
);

// The dnd-kit PointerSensor activates at 8 px of motion, so the test nudges past the threshold before moving onto the target column.

appTest(
  "drag unscheduled page onto calendar all-day → schedule shows everywhere",
  async ({ app }) => {
    await quickAdd(app, "draggable task");

    // Open the calendar so an all-day column shares the viewport with the page list; the drag needs both on screen.
    await openCalendarMode(app);

    const list = app.locator("[data-page-list-item]");
    const item = list.filter({ hasText: "draggable task" });
    await expect(item).toBeVisible();

    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page list item has no bounding box");

    // The rightmost-visible all-day column keeps the dropped date inside the current week and clear of the "next-upcoming" filter on past schedules.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target all-day column missing");

    // Read the column's accessible name before dragging: once dropped, the page list re-renders with the date
    // label, which must refer to the same day. The aria-label is "All-day events, <Weekday> <Month> <Day>".
    const dropAriaLabel = (await targetCol.getAttribute("aria-label")) ?? "";
    const dropMatch = /All-day events, \w+ (\w+) (\d+)/.exec(dropAriaLabel);
    if (!dropMatch) throw new Error(`unexpected aria-label: ${dropAriaLabel}`);
    // The column label spells the month in full ("June"), the date chip abbreviates ("Jun"); en-US short months are the first three letters, so slice.
    const dropMonthDay = `${dropMatch[1]!.slice(0, 3)} ${dropMatch[2]!}`;
    // On the week's last day that column is today, which the chip reads as "Today".
    const todayMonthDay = await app.evaluate(() =>
      new Date().toLocaleDateString("en-US", { day: "numeric", month: "short" })
    );
    const dropLabel = dropMonthDay === todayMonthDay ? "Today" : dropMonthDay;

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

    await expect(item).toContainText(dropLabel);

    // Open the page in the editor first so the calendar popover's schedule chip can't race the byline assertion; the chip must flip from "Set schedule" to "Scheduled: …".
    await openEditorMode(app);
    await item.click();
    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();
    await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();
  }
);

// Verifies the editor's title write reaches the search index: a regression would leave palette results stale after a rename.

appTest(
  "rename via editor reflects in subsequent Cmd+K search results",
  async ({ app }) => {
    await quickAdd(app, "alpha proposal");
    await quickAdd(app, "beta proposal");

    await app.keyboard.press(mod("Mod+k"));
    const palette = app.getByRole("dialog", { name: "Search pages" });
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder("Search pages, or > for commands…").fill("alpha");
    await expect(palette.getByText("alpha proposal")).toBeVisible();
    await app.keyboard.press("Enter");
    await expect(palette).not.toBeVisible();

    await expect(app.locator("[data-page-list-item][data-active='true']")).toContainText(
      "alpha proposal"
    );

    const titleDisplay = app.getByLabel("Page title");
    await titleDisplay.click();
    await expect(app.getByRole("textbox", { name: "Page title" })).toBeFocused();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("zenith proposal");
    await expect(app.getByRole("textbox", { name: "Page title" })).toHaveValue("zenith proposal");

    // Click out of the title to commit, then search by the new title; it must surface immediately, since the index reads from in-memory pages.
    await app.locator("body").click({ position: { x: 0, y: 0 } });

    await app.keyboard.press(mod("Mod+k"));
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder("Search pages, or > for commands…").fill("zenith");
    await expect(palette.getByText("zenith proposal")).toBeVisible();

    // The old title must not match: proves the rename replaced the index entry rather than appending.
    await palette.getByPlaceholder("Search pages, or > for commands…").fill("alpha");
    // The FTS5 rebuild is debounced 150 ms; `not.toBeVisible({ timeout })` retries, so no bare sleep.
    await expect(palette.getByText("alpha proposal")).not.toBeVisible({ timeout: 1000 });
  }
);

// A rename that drops folderId would lose the page from every view; one that doesn't refresh the sidebar label would confuse the user.

appTest(
  "rename a folder → its pages stay reachable; Today still finds scheduled ones",
  async ({ app }) => {
    await createFolder(app, "Work");

    // Active folder is now "Work", where quickAdd lands. Avoid "weekly"/"daily"/"monthly" in the title: the QuickAdd parser strips them as recurrence keywords and attaches an unwanted FREQ=WEEKLY rule.
    await quickAdd(app, "kickoff sync @today");
    await quickAdd(app, "research notes");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const folderBtn = sidebar.getByRole("button", { exact: true, name: "Work" });
    await expect(folderBtn).toBeVisible();

    // The rename input sits inside a role="button" wrapper, which makes Playwright's `.fill()` flake on the
    // "enabled" check. Instead wait for the input to be focused (useInlineRename focuses across rAF retries),
    // then Mod+A + type replaces atomically.
    await folderBtn.click({ button: "right" });
    await app.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = app.getByRole("textbox", { name: "Rename Work" });
    await expect(renameInput).toBeFocused();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.type("Workstreams");
    await app.keyboard.press("Enter");

    await expect(sidebar.getByRole("button", { exact: true, name: "Workstreams" })).toBeVisible();
    await expect(sidebar.getByRole("button", { exact: true, name: "Work" })).not.toBeVisible();

    await sidebar.getByRole("button", { exact: true, name: "Workstreams" }).click();
    const list = app.locator("[data-page-list-item]");
    await expect(list.filter({ hasText: "kickoff sync" })).toBeVisible();
    await expect(list.filter({ hasText: "research notes" })).toBeVisible();

    // The folder-rename path must not have stripped scheduledStart from the page.
    await app.getByRole("button", { name: /^Today/ }).click();
    await expect(list.filter({ hasText: "kickoff sync" })).toBeVisible();
    await expect(list.filter({ hasText: "research notes" })).not.toBeVisible();
  }
);

// useThreePanelDnD's multi-page drop staggers timed events or applies all-day to all; this exercises the
// all-day branch: three pages dropped on one day end up as three chips.

appTest(
  "multi-select drag of 3 pages onto an all-day column schedules all 3",
  { tag: ["@CAL-05:2"] }, async ({ app }) => {
    await quickAdd(app, "alpha task");
    await quickAdd(app, "beta task");
    await quickAdd(app, "gamma task");

    const list = app.locator("[data-page-list-item]");
    const alpha = list.filter({ hasText: "alpha task" });
    const beta = list.filter({ hasText: "beta task" });
    const gamma = list.filter({ hasText: "gamma task" });

    // Switch to calendar mode by keyboard: clicking the toggle would mousedown outside the page list and clear the selection.
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // Cmd+Click multi-selects without activating: a plain click routes through openPage and forces the right panel back to the editor, collapsing the calendar.
    await alpha.click({ modifiers: ["Meta"] });
    await beta.click({ modifiers: ["Meta"] });
    await gamma.click({ modifiers: ["Meta"] });
    await expect(alpha).toHaveAttribute("data-selected", "true");
    await expect(beta).toHaveAttribute("data-selected", "true");
    await expect(gamma).toHaveAttribute("data-selected", "true");

    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // Drop on the rightmost-visible all-day column so the date stays inside the current week.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target column missing");

    // Start the drag from a selected item (alpha): dnd-kit ties drag activation to the originating sortable.
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

// useThreePanelDnD's `at === "page" && ot === "view-today"` branch handles drag-to-Today, which schedules the
// page via scheduleOnce; a regression in the droppable wiring would leave it in Inbox.

appTest(
  "drag an unscheduled page onto the Today nav row schedules it for today",
  async ({ app }) => {
    await quickAdd(app, "drop subject");

    // The page lands unscheduled in Inbox; navigate there so the drag source is visible whatever the active view.
    await app.getByRole("button", { name: /^Inbox/ }).click();

    const item = app.locator("[data-page-list-item]").filter({ hasText: "drop subject" });
    await expect(item).toBeVisible();
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page item missing");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const todayRow = sidebar.getByRole("button", { name: /^Today/ });
    const todayBox = await todayRow.boundingBox();
    if (!todayBox) throw new Error("Today row missing");

    const startX = itemBox.x + itemBox.width / 2;
    const startY = itemBox.y + itemBox.height / 2;
    const todayX = todayBox.x + todayBox.width / 2;
    const todayY = todayBox.y + todayBox.height / 2;

    await expect(todayRow).toHaveText(/^Today$/);

    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 16, startY, { steps: 4 });
    await app.mouse.move(todayX, todayY, { steps: 10 });
    await app.mouse.up();

    // Inbox is folder_id IS NULL only, so the page also stays there; the test doesn't assert on it disappearing.
    await expect(todayRow).toHaveText(/^Today\s*1$/);

    // Move the cursor off the Today row before clicking: the button is both a click target and a dnd-kit droppable (see the folder-drag test).
    await app.mouse.move(0, 0);

    await todayRow.click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "drop subject" })
    ).toBeVisible();
  }
);

// useThreePanelDnD's `at === "page" && ot === "folder"` branch handles drag-to-folder; pages.spec.ts covers
// the context-menu path. A regression in the folder droppable wiring would leave the page in its current folder.

appTest(
  "drag a page from list onto a sidebar folder moves it, its ghost clear of the folder's name",
  { tag: ["@LIST-05:2"] },
  async ({ app }) => {
  await createFolder(app, "Archive");

  await app.getByRole("button", { name: /^Inbox/ }).click();
  await quickAdd(app, "movable doc");

  const item = app.locator("[data-page-list-item]").filter({ hasText: "movable doc" });
  await expect(item).toBeVisible();
  const itemBox = await item.boundingBox();
  if (!itemBox) throw new Error("page item missing");

  const sidebar = app.getByRole("group", { name: "Views and folders" });
  const folder = sidebar.getByRole("button", { exact: true, name: "Archive" });
  const folderBox = await folder.boundingBox();
  if (!folderBox) throw new Error("folder missing");

  const startX = itemBox.x + itemBox.width / 2;
  const startY = itemBox.y + itemBox.height / 2;
  const folderX = folderBox.x + folderBox.width / 2;
  const folderY = folderBox.y + folderBox.height / 2;

  await app.mouse.move(startX, startY);
  await app.mouse.down();
  await app.mouse.move(startX + 16, startY, { steps: 4 });
  await app.mouse.move(folderX, folderY, { steps: 10 });

  const ghostBox = await app.getByTestId("page-drag-ghost").boundingBox();
  const nameBox = await folder.getByText("Archive", { exact: true }).boundingBox();
  if (!ghostBox || !nameBox) throw new Error("drag ghost or folder name missing");
  expect(ghostBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);

  await app.mouse.up();

  await expect(item).not.toBeVisible();

  // Move the cursor off the folder before clicking: the button is both a click target and a dnd-kit droppable,
  // and clicking right after `mouse.up` while still hovering can race the drag-end cleanup and swallow the navigation.
  await app.mouse.move(0, 0);

  await folder.click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "movable doc" })
  ).toBeVisible();
  }
);
