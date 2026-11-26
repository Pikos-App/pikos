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
    // Two pages, so the filter has real work to do.
    await quickAdd(app, "ship release notes @today");
    await quickAdd(app, "someday backlog");

    await app.getByRole("button", { name: /^Today/ }).click();
    const list = app.locator("[data-page-list-item]");
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();

    // The list scopes before Completed expands, so a "Mark done" checkbox outside Completed belongs to the open page.
    const release = list.filter({ hasText: "ship release notes" });
    await release.getByRole("checkbox", { name: "Mark done" }).click();

    await expect(release).not.toBeVisible();

    // Today lists scheduled pages regardless of status, so the done page still appears.
    const completedToggle = app.getByRole("button", { name: /^Completed/ });
    await completedToggle.click();
    await expect(list.filter({ hasText: "ship release notes" })).toBeVisible();
    await expect(list.filter({ hasText: "someday backlog" })).not.toBeVisible();
  }
);

// dnd-kit's PointerSensor activates at 8 px of motion, so nudge past it before moving onto the target column.

appTest(
  "drag unscheduled page onto calendar all-day → schedule shows everywhere",
  async ({ app }) => {
    await quickAdd(app, "draggable task");

    // Drag-to-calendar needs both the all-day column and the page list on screen.
    await openCalendarMode(app);

    const list = app.locator("[data-page-list-item]");
    const item = list.filter({ hasText: "draggable task" });
    await expect(item).toBeVisible();

    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error("page list item has no bounding box");

    // The last column keeps the dropped date inside the current week, avoiding the "next-upcoming" filter on past schedules.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target all-day column missing");

    // Read the name before dragging: afterwards the list re-renders with a date label to compare against.
    // Shaped "All-day events, <Weekday> <Month> <Day>".
    const dropAriaLabel = (await targetCol.getAttribute("aria-label")) ?? "";
    const dropMatch = /All-day events, \w+ (\w+) (\d+)/.exec(dropAriaLabel);
    if (!dropMatch) throw new Error(`unexpected aria-label: ${dropAriaLabel}`);
    // The column aria-label spells the month in full ("June"); the page-list
    // date chip uses the abbreviated form ("Jun"). en-US short months are the
    // first three letters of the long name, so slice to match the chip.
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

    // Open the editor first so the calendar-popover schedule chip can't race the byline assertion.
    await openEditorMode(app);
    await item.click();
    await expect(app.getByRole("button", { name: /^Scheduled:/ })).toBeVisible();
    await expect(app.getByRole("button", { name: "Set schedule" })).not.toBeVisible();
  }
);

appTest("rename via editor reflects in subsequent Cmd+K search results", async ({ app }) => {
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

  // The result must surface immediately: search reads in-memory pages, not a stale snapshot.
  await app.locator("body").click({ position: { x: 0, y: 0 } });

  await app.keyboard.press(mod("Mod+k"));
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search pages, or > for commands…").fill("zenith");
  await expect(palette.getByText("zenith proposal")).toBeVisible();

  // Proves the rename replaced, not appended, a search-index entry.
  await palette.getByPlaceholder("Search pages, or > for commands…").fill("alpha");
  // FTS5 rebuild is debounced 150 ms; the not.toBeVisible timeout retries, so no bare sleep.
  await expect(palette.getByText("alpha proposal")).not.toBeVisible({ timeout: 1000 });
});

appTest(
  "rename a folder → its pages stay reachable; Today still finds scheduled ones",
  async ({ app }) => {
    await createFolder(app, "Work");

    // Titles avoid "weekly"/"daily"/"monthly": QuickAdd strips them as recurrence keywords.
    await quickAdd(app, "kickoff sync @today");
    await quickAdd(app, "research notes");

    const sidebar = app.getByRole("group", { name: "Views and folders" });
    const folderBtn = sidebar.getByRole("button", { exact: true, name: "Work" });
    await expect(folderBtn).toBeVisible();

    // The rename input sits inside a role="button" wrapper, which makes .fill() flake on the enabled check.
    // Wait for focus (useInlineRename focuses across rAF retries), then Mod+A and type.
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

    await app.getByRole("button", { name: /^Today/ }).click();
    await expect(list.filter({ hasText: "kickoff sync" })).toBeVisible();
    await expect(list.filter({ hasText: "research notes" })).not.toBeVisible();
  }
);

// Exercises the all-day branch of useThreePanelDnD's multi-page drop.

appTest(
  "multi-select drag of 3 pages onto an all-day column schedules all 3",
  { tag: ["@CAL-05:2"] },
  async ({ app }) => {
    await quickAdd(app, "alpha task");
    await quickAdd(app, "beta task");
    await quickAdd(app, "gamma task");

    const list = app.locator("[data-page-list-item]");
    const alpha = list.filter({ hasText: "alpha task" });
    const beta = list.filter({ hasText: "beta task" });
    const gamma = list.filter({ hasText: "gamma task" });

    // Switch via keyboard: clicking the toggle mousedowns outside the page list and clears the selection.
    await app.keyboard.press(mod("Mod+Shift+c"));
    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // Cmd+Click multi-selects without activating: a plain click routes through openPage and collapses the calendar.
    await alpha.click({ modifiers: ["Meta"] });
    await beta.click({ modifiers: ["Meta"] });
    await gamma.click({ modifiers: ["Meta"] });
    await expect(alpha).toHaveAttribute("data-selected", "true");
    await expect(beta).toHaveAttribute("data-selected", "true");
    await expect(gamma).toHaveAttribute("data-selected", "true");

    await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();

    // The rightmost column keeps the drop date inside the current week.
    const cols = app.locator('[aria-label^="All-day events,"]');
    const targetCol = cols.last();
    const targetBox = await targetCol.boundingBox();
    if (!targetBox) throw new Error("target column missing");

    // Drag from a selected item: dnd-kit ties activation to the originating sortable.
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

appTest(
  "drag an unscheduled page onto the Today nav row schedules it for today",
  async ({ app }) => {
    await quickAdd(app, "drop subject");

    // The page lands in Inbox unscheduled; navigate there so the drag source is visible.
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

    // Inbox filters on folder_id IS NULL only, so the page also stays there; that is not asserted.
    await expect(todayRow).toHaveText(/^Today\s*1$/);

    // Move the cursor off the Today row first: the button is both click target and dnd-kit droppable.
    await app.mouse.move(0, 0);

    await todayRow.click();
    await expect(
      app.locator("[data-page-list-item]").filter({ hasText: "drop subject" })
    ).toBeVisible();
  }
);

appTest("drag a page from list onto a sidebar folder moves it", async ({ app }) => {
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
  await app.mouse.up();

  await expect(item).not.toBeVisible();

  // Move the cursor off the folder first: clicking right after mouse.up while hovering can race the
  // drag-end cleanup and swallow the navigation.
  await app.mouse.move(0, 0);

  await folder.click();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "movable doc" })
  ).toBeVisible();
});
